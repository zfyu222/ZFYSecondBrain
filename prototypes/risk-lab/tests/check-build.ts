import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import { offlineAssets } from "../server/offline-shell";

const root = path.resolve("dist"),
  names: string[] = [];
async function walk(relative = "") {
  for (const item of await fs.readdir(path.join(root, relative), {
    withFileTypes: true,
  })) {
    const next = relative ? relative + "/" + item.name : item.name;
    if (item.isSymbolicLink()) throw new Error("构建目录含符号链接");
    if (item.isDirectory()) await walk(next);
    else names.push(next);
  }
}
await walk();
const worker = await fs.readFile(path.join(root, "sw.js"), "utf8");
const match = /const ASSETS = (\[[^\n]*\]);/.exec(worker);
assert(match, "生成的 Worker 缺少缓存清单");
const assets: string[] = JSON.parse(match[1]);
assert.deepEqual(assets, offlineAssets(names), "有构建资源未进入离线缓存");
assert(
  assets.some((p) => /\/MapEditor-[^/]+\.js$/.test(p)),
  "导图编辑器没有独立分包",
);
assert(
  assets.some((p) => /\/MarkdownEditor-[^/]+\.js$/.test(p)),
  "Markdown 编辑器没有独立分包",
);
assert(
  !assets.some(
    (p) =>
      p.includes("/api/") ||
      p.includes("/raw/") ||
      p.includes(".prototype-data"),
  ),
  "缓存不应包含原始数据/API",
);
console.log(
  `构建缓存清单检查通过：${assets.length} 个入口/资源，含两个按需编辑器。`,
);
