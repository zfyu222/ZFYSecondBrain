import { z } from "zod";
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
export const changeSchema = z
  .object({
    requestId: z.string().min(8).max(100),
    expectedRevision: z.string().nullable(),
    files: filesSchema,
  })
  .strict();
export type Change = z.infer<typeof changeSchema>;
export type Snapshot = { revision: string; files: Record<string, string> };
export const moveSchema = z
  .object({
    requestId: z.string().min(8).max(100),
    expectedRevision: z.string(),
    from: pathSchema,
    to: pathSchema,
  })
  .strict();
export function validateFiles(files: Record<string, string>) {
  filesSchema.parse(files);
  const allPaths = Object.keys(files).map((p) =>
    p.normalize("NFC").toLocaleLowerCase("en-US"),
  );
  if (allPaths.some((p) => allPaths.some((other) => other.startsWith(p + "/"))))
    throw new Error("文件和目录路径冲突");
  const lower = new Set<string>();
  for (const [path, text] of Object.entries(files)) {
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
