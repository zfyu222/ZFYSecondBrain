import { createHash } from "node:crypto";
import type { Snapshot } from "../src/core/contracts";

export function snapshotRevision(snapshot: Omit<Snapshot, "revision">) {
  const { files, moves = [], attachments = {} } = snapshot;
  const data = Object.keys(attachments).length
    ? { protocolVersion: 2, files, attachments, moves }
    : moves.length
      ? { files, moves }
      : files;
  return createHash("sha256").update(JSON.stringify(data)).digest("hex");
}
