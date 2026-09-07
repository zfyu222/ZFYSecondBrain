import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { cilRequestSchema, validateCilRequest } from "../src/core/cil";
import { ConflictError, FileStore, RejectedError } from "./store";

const reviewStatusSchema = z.enum(["pending", "applied", "rejected", "stale"]);
const reviewSchema = z
  .object({
    id: z.string().uuid(),
    task: z.string().min(1).max(120),
    path: z.string().startsWith("raw/").endsWith(".md"),
    baseRevision: z.string().regex(/^[a-f\d]{64}$/i),
    before: z.string().max(2_000_000).nullable(),
    after: z.string().max(2_000_000),
    rationale: z.string().min(1).max(2_000),
    createdAt: z.string().datetime(),
    status: reviewStatusSchema,
    decidedAt: z.string().datetime().optional(),
    appliedRevision: z.string().regex(/^[a-f\d]{64}$/i).optional(),
  })
  .strict();
export type ManagerReview = z.infer<typeof reviewSchema>;

const reviewFileSchema = z
  .object({ version: z.literal(1), reviews: z.array(reviewSchema).max(500) })
  .strict();

export const managerDecisionSchema = z
  .object({ decision: z.enum(["apply", "reject"]) })
  .strict();

/**
 * Knowledge-service-owned review queue. It stores proposed text, not model state,
 * and applies accepted changes through the same versioned FileStore transaction.
 */
export class ManagerReviewService {
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly store: FileStore) {}

  private exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const pending = this.queue.then(operation);
    this.queue = pending.catch(() => {});
    return pending;
  }

  private get file() {
    return path.join(this.store.root, "state", "manager-reviews.json");
  }

  private async assertPlainFile(file: string) {
    const stat = await fs.lstat(file).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    if (stat?.isSymbolicLink() || (stat?.isFile() && stat.nlink !== 1))
      throw new Error("管理员审阅状态文件不能是链接");
  }

  private async read(): Promise<ManagerReview[]> {
    await this.assertPlainFile(this.file);
    try {
      return reviewFileSchema.parse(JSON.parse(await fs.readFile(this.file, "utf8")))
        .reviews;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }

  private async write(reviews: ManagerReview[]) {
    const temp = `${this.file}.tmp`;
    await this.assertPlainFile(this.file);
    await this.assertPlainFile(temp);
    const handle = await fs.open(temp, "w");
    try {
      await handle.writeFile(
        JSON.stringify({ version: 1, reviews: reviews.slice(-500) }, null, 2),
      );
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.rename(temp, this.file);
  }

  list() {
    return this.exclusive(() => this.read());
  }

  create(input: unknown) {
    return this.exclusive(async () => {
      const request = validateCilRequest(input);
      if (request.command !== "propose-change" || !request.proposal)
        throw new RejectedError("管理员审阅只接受已授权的变更提议");
      const snapshot = await this.store.snapshot();
      if (request.proposal.baseRevision !== snapshot.revision)
        throw new ConflictError(snapshot);
      const before = snapshot.files[request.proposal.path] ?? null;
      if (before === request.proposal.content)
        throw new RejectedError("变更提议与当前文档相同");
      const review: ManagerReview = {
        id: randomUUID(),
        task: request.task,
        path: request.proposal.path,
        baseRevision: request.proposal.baseRevision,
        before,
        after: request.proposal.content,
        rationale: request.proposal.rationale,
        createdAt: new Date().toISOString(),
        status: "pending",
      };
      await this.write([...(await this.read()), review]);
      return review;
    });
  }

  decide(id: string, input: unknown) {
    return this.exclusive(async () => {
      z.string().uuid().parse(id);
      const { decision } = managerDecisionSchema.parse(input);
      const reviews = await this.read();
      const index = reviews.findIndex((review) => review.id === id);
      if (index < 0) throw new RejectedError("管理员审阅不存在");
      const review = reviews[index];
      if (review.status !== "pending") return review;
      const decidedAt = new Date().toISOString();
      if (decision === "reject") {
        reviews[index] = { ...review, status: "rejected", decidedAt };
        await this.write(reviews);
        return reviews[index];
      }
      const snapshot = await this.store.snapshot();
      if (snapshot.revision !== review.baseRevision) {
        reviews[index] = { ...review, status: "stale", decidedAt };
        await this.write(reviews);
        throw new ConflictError(snapshot);
      }
      const result = await this.store.commit({
        requestId: `manager-${review.id}`,
        expectedRevision: review.baseRevision,
        moveSequence: snapshot.moves?.length ?? 0,
        files: { ...snapshot.files, [review.path]: review.after },
        ...(snapshot.attachments
          ? { protocolVersion: 2 as const, attachments: snapshot.attachments }
          : {}),
      });
      reviews[index] = {
        ...review,
        status: "applied",
        decidedAt,
        appliedRevision: result.revision,
      };
      await this.write(reviews);
      return reviews[index];
    });
  }
}

// Exported only for protocol documentation/tests to share the exact request shape.
export const managerProposalRequestSchema = cilRequestSchema.refine(
  (request) => request.command === "propose-change",
  "管理员审阅只接受变更提议",
);
