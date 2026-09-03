import { createHash } from "node:crypto";
import { z } from "zod";
import {
  filesSchema,
  moveRecordSchema,
  validateFiles,
  type Snapshot,
} from "../src/core/contracts";
import { validateMoves } from "../src/core/moves";

const snapshotShape = z
  .object({
    revision: z.string(),
    files: filesSchema,
    moves: z.array(moveRecordSchema).optional(),
  })
  .strict();
// Existing v1 hashes include JSON property order in files and move records. Validate
// without replacing the original object with Zod's reordered representation.
const snapshotSchema = z.unknown().transform((input, ctx): Snapshot => {
  const parsed = snapshotShape.safeParse(input);
  if (!parsed.success) {
    ctx.addIssue({ code: "custom", message: parsed.error.message });
    return z.NEVER;
  }
  const snapshot = input as Snapshot;
  try {
    validateFiles(snapshot.files);
    validateMoves(snapshot.moves ?? []);
    // A backup can have been produced under a different locale/ICU collation.
    // Verify the stored representation, not a newly locale-sorted representation.
    const files = snapshot.files;
    const data = snapshot.moves?.length
      ? { files, moves: snapshot.moves }
      : files;
    const revision = createHash("sha256")
      .update(JSON.stringify(data))
      .digest("hex");
    if (snapshot.revision !== revision) throw new Error("快照校验值不一致");
  } catch (error) {
    ctx.addIssue({ code: "custom", message: String(error) });
  }
  return snapshot;
});
export type Ledger = Record<string, { fingerprint: string; result: Snapshot }>;
const receiptSchema = z
  .object({ fingerprint: z.string(), result: snapshotSchema })
  .strict();
// Validate every own entry, including '__proto__'. Generic record normalization
// intentionally omits that key, which would lose an otherwise valid retry receipt.
export const ledgerSchema = z.unknown().transform((input, ctx): Ledger => {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    ctx.addIssue({ code: "custom", message: "账本必须是对象" });
    return z.NEVER;
  }
  for (const [key, entry] of Object.entries(input)) {
    const parsed = receiptSchema.safeParse(entry);
    if (!parsed.success)
      ctx.addIssue({
        code: "custom",
        path: [key],
        message: parsed.error.message,
      });
  }
  return input as Ledger;
});
export const journalSchema = z
  .object({
    version: z.literal(1),
    status: z.enum(["prepared", "committed"]),
    before: snapshotSchema,
    after: snapshotSchema,
    ledgerBefore: ledgerSchema,
    ledgerAfter: ledgerSchema,
  })
  .strict();
