import { promises as fs } from "node:fs";
import path from "node:path";

export async function inspectExisting(file: string) {
  return fs.lstat(file).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error;
    return undefined;
  });
}
/** Checks observed path components; this is not a lock against concurrent replacement. */
export async function noLinkedAncestors(file: string) {
  const absolute = path.resolve(file);
  let current = path.parse(absolute).root;
  for (const part of path
    .relative(current, absolute)
    .split(path.sep)
    .filter(Boolean)) {
    current = path.join(current, part);
    if ((await inspectExisting(current))?.isSymbolicLink())
      throw new Error("拒绝符号链接路径：" + current);
  }
}
export async function noLinkedFile(file: string) {
  await noLinkedAncestors(file);
  const info = await inspectExisting(file);
  if (info && (!info.isFile() || info.nlink > 1))
    throw new Error("拒绝特殊文件或多重硬链接：" + file);
}
