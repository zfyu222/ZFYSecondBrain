import { z } from "zod";
import {
  attachmentSchema,
  attachmentLimits,
  attachmentSize,
  isAttachmentPath,
  type Attachments,
} from "./attachments";
import {
  parseOpml,
  parseRelations,
  relationsSchema,
  safeYaml,
} from "./formats";

export const pathSchema = z
  .string()
  .max(500)
  .refine((p) => {
    if (
      !/^(raw\/(Inbox|Projects|Areas|Archive)|derived)\//.test(p) ||
      /[\\\x00-\x1f<>:"|?*]/.test(p)
    )
      return false;
    return p
      .split("/")
      .every(
        (s) =>
          s &&
          s !== "." &&
          s !== ".." &&
          !s.endsWith(".risk-tmp") &&
          !/[. ]$/.test(s) &&
          !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i.test(s),
      );
  }, "路径必须位于原型 raw/四空间 或 derived 内，且兼容 Windows");
export const filesSchema = z
  .record(pathSchema, z.string().max(2_000_000))
  .refine(
    (v) =>
      Object.keys(v).length <= 100 &&
      Object.values(v).reduce((sum, t) => sum + t.length, 0) <= 5_000_000,
    "原型提交过大",
  );
export const attachmentsSchema = z
  .record(
    pathSchema.refine(isAttachmentPath, "附件必须使用受支持的 .assets 路径"),
    attachmentSchema,
  )
  .refine(
    (files) =>
      Object.keys(files).length <= attachmentLimits.count &&
      Object.values(files).reduce(
        (sum, item) => sum + attachmentSize(item),
        0,
      ) <= attachmentLimits.total,
    "附件超过原型数量或总量限制",
  );
export const changeSchema = z
  .object({
    requestId: z.string().min(8).max(100),
    expectedRevision: z.string().nullable(),
    moveSequence: z.number().int().nonnegative().optional(),
    files: filesSchema,
    protocolVersion: z.literal(2).optional(),
    attachments: attachmentsSchema.optional(),
  })
  .strict();
export type Change = z.infer<typeof changeSchema>;
export const moveRecordSchema = z
  .object({
    sequence: z.number().int().positive(),
    from: pathSchema,
    to: pathSchema,
    at: z.string(),
    paths: z.array(pathSchema).optional(),
  })
  .strict();
export type MoveRecord = z.infer<typeof moveRecordSchema>;
export type Snapshot = {
  revision: string;
  files: Record<string, string>;
  moves?: MoveRecord[];
  protocolVersion?: 2;
  attachments?: Attachments;
};
export const moveSchema = z
  .object({
    requestId: z.string().min(8).max(100),
    expectedRevision: z.string(),
    from: pathSchema,
    to: pathSchema,
    protocolVersion: z.literal(2).optional(),
  })
  .strict();
export const snapshotPayloadSchema = z
  .object({
    revision: z.string(),
    files: filesSchema,
    moves: z.array(moveRecordSchema).optional(),
    protocolVersion: z.literal(2).optional(),
    attachments: attachmentsSchema.optional(),
  })
  .strict();
export function validateContent(
  files: Record<string, string>,
  attachments: Attachments = {},
) {
  validateFiles(files);
  attachmentsSchema.parse(attachments);
  if (Object.keys(attachments).some((p) => Object.hasOwn(files, p)))
    throw new Error("文本与附件路径重叠");
  if (Object.keys(files).some(isAttachmentPath))
    throw new Error("二进制附件不能按文本提交");
  // Reuse the cross-platform path collision boundary across both namespaces.
  validateFiles({
    ...files,
    ...Object.fromEntries(Object.keys(attachments).map((p) => [p, ""])),
  });
}
export function validateFiles(files: Record<string, string>) {
  filesSchema.parse(files);
  const allPaths = Object.keys(files).map((p) =>
    p.normalize("NFC").toLocaleLowerCase("en-US"),
  );
  if (allPaths.some((p) => allPaths.some((other) => other.startsWith(p + "/"))))
    throw new Error("文件和目录路径冲突");
  const lower = new Set<string>();
  const directories = new Map<string, string>();
  for (const [path, text] of Object.entries(files)) {
    const parts = path.split("/");
    for (let i = 1; i < parts.length; i++) {
      const prefix = parts.slice(0, i).join("/"),
        key = prefix.normalize("NFC").toLocaleLowerCase("en-US");
      if (directories.has(key) && directories.get(key) !== prefix)
        throw new Error("目录存在跨平台大小写或 Unicode 别名");
      directories.set(key, prefix);
    }
    const folded = path.normalize("NFC").toLocaleLowerCase("en-US");
    if (lower.has(folded)) throw new Error("存在跨平台大小写或 Unicode 重名");
    lower.add(folded);
    if (path.endsWith(".opml")) {
      const map = parseOpml(text);
      const relations = files[path.replace(/\.opml$/, ".relations.yaml")];
      if (relations) {
        parseRelations(relations, map);
        if (
          relationsSchema.parse(safeYaml(relations)).map !==
          `./${path.split("/").pop()}`
        )
          throw new Error("关系文件 map 必须指向同名 OPML");
      }
    }
    if (
      path.endsWith(".relations.yaml") &&
      !files[path.replace(/\.relations\.yaml$/, ".opml")]
    )
      throw new Error("关系文件缺少配对 OPML");
  }
}
