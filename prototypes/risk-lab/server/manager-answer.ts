import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { CilRequest, CilResult } from "../src/core/cil";
import type { Snapshot } from "../src/core/contracts";
import { ConflictError, RejectedError } from "./store";

const answerSchema = z
  .object({
    evidenceId: z.string().uuid(),
    answer: z.string().min(1).max(20_000),
    citations: z
      .array(
        z
          .object({
            path: z.string().startsWith("raw/").endsWith(".md"),
            quote: z.string().min(1).max(1_000),
          })
          .strict(),
      )
      .min(1)
      .max(20),
  })
  .strict();
export type ManagerAnswer = z.infer<typeof answerSchema> & {
  sourceRevision: string;
  task: string;
  submittedAt: string;
};

type Evidence = {
  task: string;
  sourceRevision: string;
  paths: string[];
};

/**
 * Ephemeral receipts tie an answer to documents actually returned by CIL read.
 * Restarting the manager service deliberately invalidates receipts and requires a reread.
 */
export class ManagerAnswerService {
  private evidence = new Map<string, Evidence>();

  record(
    request: CilRequest,
    sourceRevision: string,
    result: CilResult,
  ): string | undefined {
    if (request.command !== "read" || result.command !== "read") return undefined;
    const id = randomUUID();
    this.evidence.set(id, {
      task: request.task,
      sourceRevision,
      paths: result.documents.map((document) => document.path),
    });
    return id;
  }

  submit(input: unknown, snapshot: Snapshot): ManagerAnswer {
    const answer = answerSchema.parse(input);
    const evidence = this.evidence.get(answer.evidenceId);
    if (!evidence) throw new RejectedError("回答来源凭据不存在或已随服务重启失效，请重新读取原文");
    if (snapshot.revision !== evidence.sourceRevision) throw new ConflictError(snapshot);
    for (const citation of answer.citations) {
      if (!evidence.paths.includes(citation.path))
        throw new RejectedError("回答引用了本次未读取的文档");
      if (!snapshot.files[citation.path]?.includes(citation.quote))
        throw new RejectedError("回答引用的原文片段不存在或已变化");
    }
    return {
      ...answer,
      sourceRevision: evidence.sourceRevision,
      task: evidence.task,
      submittedAt: new Date().toISOString(),
    };
  }
}
