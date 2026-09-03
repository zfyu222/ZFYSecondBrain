import { z } from "zod";
import {
  validateFiles,
  validateContent,
  snapshotPayloadSchema,
  type Snapshot,
} from "../src/core/contracts";
import { validateMoves } from "../src/core/moves";
import { snapshotRevision } from "./snapshot";

// Existing v1 hashes include JSON property order in files and move records. Validate
// without replacing the original object with Zod's reordered representation.
const snapshotSchema = z.unknown().transform((input, ctx): Snapshot => {
  const parsed = snapshotPayloadSchema.safeParse(input);
  if (!parsed.success) {
    ctx.addIssue({ code: "custom", message: parsed.error.message });
    return z.NEVER;
  }
  const snapshot = input as Snapshot;
  try {
    if (snapshot.attachments !== undefined) {
      if (snapshot.protocolVersion !== 2) throw new Error("附件缺少协议版本");
      validateContent(snapshot.files, snapshot.attachments);
    } else validateFiles(snapshot.files);
    validateMoves(snapshot.moves ?? []);
    // A backup can have been produced under a different locale/ICU collation.
    // Verify the stored representation, not a newly locale-sorted representation.
    const revision = snapshotRevision(snapshot);
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
    version: z.union([z.literal(1), z.literal(2)]),
    status: z.enum(["prepared", "committed"]),
    before: snapshotSchema,
    after: snapshotSchema,
    ledgerBefore: ledgerSchema,
    ledgerAfter: ledgerSchema,
  })
  .strict()
  .refine(
    (journal) =>
      journal.version === 2 ||
      (!journal.before.attachments && !journal.after.attachments),
    "旧事务不能包含二进制附件",
  );
