import { z } from "zod";

export const attachmentLimits = {
  single: 1_000_000,
  total: 4_000_000,
  count: 40,
} as const;
// Binary originals are explicit, bounded files beside their owning note. SVG/HTML
// are deliberately not active media; byte preservation does not imply safe rendering.
export const mediaTypes: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  mp4: "video/mp4",
  webm: "video/webm",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  ogg: "audio/ogg",
  pdf: "application/pdf",
};
export function isAttachmentPath(path: string) {
  return (
    /^raw\/(Inbox|Projects|Areas|Archive)\/.+\.assets\/.+/.test(path) &&
    Object.hasOwn(mediaTypes, path.split(".").pop()!.toLowerCase())
  );
}
export type Attachment = { encoding: "base64"; data: string };
export type Attachments = Record<string, Attachment>;

function canonicalBase64(data: string) {
  if (data.length % 4 || /[^A-Za-z0-9+/=]/.test(data)) return false;
  try {
    return btoa(atob(data)) === data;
  } catch {
    return false;
  }
}
export const attachmentSchema = z
  .object({
    encoding: z.literal("base64"),
    data: z
      .string()
      .max(Math.ceil(attachmentLimits.single / 3) * 4)
      .refine(canonicalBase64, "附件编码不是规范 Base64"),
  })
  .strict()
  .refine(
    (value) => attachmentSize(value) <= attachmentLimits.single,
    "单附件超过原型限制",
  );
export function attachmentSize(value: Attachment) {
  return (
    (value.data.length / 4) * 3 -
    (value.data.endsWith("==") ? 2 : value.data.endsWith("=") ? 1 : 0)
  );
}
export function encodeAttachment(bytes: Uint8Array): Attachment {
  if (bytes.byteLength > attachmentLimits.single)
    throw new Error("单附件超过原型 1 MB 限制");
  const chunks: string[] = [];
  for (let i = 0; i < bytes.length; i += 8192)
    chunks.push(String.fromCharCode(...bytes.subarray(i, i + 8192)));
  return { encoding: "base64", data: btoa(chunks.join("")) };
}
export function decodeAttachment(value: Attachment): Uint8Array<ArrayBuffer> {
  attachmentSchema.parse(value);
  const binary = atob(value.data);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}
export function sameAttachment(a?: Attachment | null, b?: Attachment | null) {
  return a?.encoding === b?.encoding && a?.data === b?.data;
}
export type AttachmentConflict = {
  path: string;
  base: Attachment | null;
  local: Attachment | null;
  remote: Attachment | null;
};
export function mergeAttachments(
  base: Attachments = {},
  local: Attachments = {},
  remote: Attachments = {},
) {
  const attachments: Attachments = {},
    conflicts: AttachmentConflict[] = [];
  for (const path of new Set([
    ...Object.keys(base),
    ...Object.keys(local),
    ...Object.keys(remote),
  ])) {
    const b = base[path],
      l = local[path],
      r = remote[path];
    let chosen: Attachment | undefined;
    if (sameAttachment(l, r)) chosen = l;
    else if (sameAttachment(l, b)) chosen = r;
    else if (sameAttachment(r, b)) chosen = l;
    else {
      conflicts.push({
        path,
        base: b ?? null,
        local: l ?? null,
        remote: r ?? null,
      });
      continue;
    }
    if (chosen) attachments[path] = chosen;
  }
  return { attachments, conflicts };
}
export function attachmentChoiceKey(path: string) {
  return JSON.stringify(["attachment", path]);
}
export function resolveAttachments(
  merged: Attachments,
  conflicts: AttachmentConflict[],
  choices: Record<string, "local" | "remote">,
) {
  const result = { ...merged };
  for (const conflict of conflicts) {
    const choice = choices[attachmentChoiceKey(conflict.path)];
    if (choice !== "local" && choice !== "remote")
      throw new Error("请为每个附件冲突选择一版");
    const chosen = conflict[choice];
    if (chosen) result[conflict.path] = chosen;
    else delete result[conflict.path];
  }
  return result;
}
export function relocateAttachments(
  attachments: Attachments,
  moves: Record<string, string>,
) {
  const result: Attachments = {};
  for (const [path, value] of Object.entries(attachments)) {
    const destination = moves[path] ?? path;
    if (Object.hasOwn(result, destination))
      throw new Error("附件移动目标已存在，不能覆盖");
    result[destination] = value;
  }
  return result;
}
