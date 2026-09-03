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
// Existing v1 hashes include JSON property order in move records. Validate
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
    const files = Object.fromEntries(
      Object.entries(snapshot.files).sort(([a], [b]) => a.localeCompare(b)),
    );
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
export const ledgerSchema = z.record(
  z.string(),
  z
    .object({
      fingerprint: z.string(),
      result: snapshotSchema,
    })
    .strict(),
);
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
export type Ledger = z.infer<typeof ledgerSchema>;
