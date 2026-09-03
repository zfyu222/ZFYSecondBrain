import { XMLParser, XMLValidator } from "fast-xml-parser";
import { parseDocument, stringify } from "yaml";
import { z } from "zod";

export type Topic = {
  text: string;
  body: string;
  type: string;
  children: Topic[];
  attrs: Record<string, string>;
};
export type Mindmap = { title: string; root: Topic };
export const relationTypes = [
  "定义为",
  "属于",
  "组成",
  "例子",
  "导致",
  "影响",
  "支持",
  "反驳",
  "实现",
  "依赖",
  "先于",
  "相似",
  "相反",
  "相关",
  "未明确",
];
export const relationSchema = z
  .object({
    from: z.string().startsWith("/"),
    to: z.string().startsWith("/"),
    type: z.string().min(1).max(80),
    status: z.enum(["confirmed", "unresolved"]),
  })
  .strict();
export type Relation = z.infer<typeof relationSchema>;
export const relationsSchema = z
  .object({
    version: z.literal(1),
    map: z.string(),
    relations: z.array(relationSchema).max(2000),
  })
  .strict();

export function safeYaml(text: string): unknown {
  if (text.length > 2_000_000) throw new Error("YAML 超过原型大小限制");
  const doc = parseDocument(text, { uniqueKeys: true });
  if (doc.errors.length)
    throw new Error(doc.errors.map((e) => e.message).join("; "));
  return doc.toJS({ maxAliasCount: 0 });
}
export function topic(text = "新节点"): Topic {
  return { text, body: "", type: "topic", children: [], attrs: {} };
}
const escapePart = (text: string) =>
  text
    .replaceAll("~", "~0")
    .replaceAll("/", "~1")
    .replaceAll("[", "~2")
    .replaceAll("]", "~3");
export function flatten(map: Mindmap) {
  const rows: { path: string; node: Topic; parent?: string; depth: number }[] =
    [];
  function walk(nodes: Topic[], parent?: string, depth = 0) {
    const counts = new Map<string, number>();
    nodes.forEach((node) => {
      const ordinal = (counts.get(node.text) ?? 0) + 1;
      counts.set(node.text, ordinal);
      const path = `${parent ?? ""}/${escapePart(node.text)}[${ordinal}]`;
      rows.push({ path, node, parent, depth });
      walk(node.children, path, depth + 1);
    });
  }
  walk([map.root]);
  return rows;
}
export function editMap(
  map: Mindmap,
  relations: Relation[],
  action: (map: Mindmap) => void,
): { map: Mindmap; relations: Relation[] } {
  const next = structuredClone(map);
  const oldPaths = new Map(flatten(next).map((row) => [row.node, row.path]));
  action(next);
  const remap = new Map(
    flatten(next).map((row) => [oldPaths.get(row.node), row.path]),
  );
  return {
    map: next,
    relations: relations
      .filter((r) => remap.has(r.from) && remap.has(r.to))
      .map((r) => ({ ...r, from: remap.get(r.from)!, to: remap.get(r.to)! })),
  };
}
const attrEscape = (s: string) =>
  s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("\r", "&#13;")
    .replaceAll("\n", "&#10;")
    .replaceAll("\t", "&#9;");
export function serializeOpml(map: Mindmap): string {
  function outline(n: Topic, level: number): string {
    const attributes = {
      ...n.attrs,
      text: n.text,
      type: n.type,
      zfyBody: n.body,
    };
    const attrs = Object.entries(attributes)
      .map(([k, v]) => {
        if (!/^[a-zA-Z_][\w.-]*$/.test(k))
          throw new Error("不支持的 OPML 属性");
        return ` ${k}="${attrEscape(v)}"`;
      })
      .join("");
    const indent = "  ".repeat(level);
    return n.children.length
      ? `${indent}<outline${attrs}>\n${n.children.map((c) => outline(c, level + 1)).join("\n")}\n${indent}</outline>`
      : `${indent}<outline${attrs} />`;
  }
  return `<?xml version="1.0" encoding="UTF-8"?>\n<opml version="2.0">\n  <head><title>${attrEscape(map.title)}</title></head>\n  <body>\n${outline(map.root, 2)}\n  </body>\n</opml>\n`;
}
export function parseOpml(xml: string): Mindmap {
  if (xml.length > 2_000_000 || /<!DOCTYPE|<!ENTITY|<!--/i.test(xml))
    throw new Error("原型不支持 DTD、实体声明或 XML 注释，原文未修改");
  if (XMLValidator.validate(xml) !== true) throw new Error("OPML XML 无效");
  const parsed = new XMLParser({
    ignoreAttributes: false,
    parseTagValue: false,
    trimValues: false,
    htmlEntities: true,
    isArray: (name) => name === "outline",
  }).parse(xml);
  if (Object.keys(parsed).some((k) => !["opml", "?xml"].includes(k)))
    throw new Error("不支持的 XML 顶层内容");
  const doc = parsed.opml;
  if (
    !doc ||
    doc["@_version"] !== "2.0" ||
    Object.keys(doc).some(
      (k) => !["head", "body", "@_version", "#text"].includes(k),
    )
  )
    throw new Error("不支持的 OPML 文档结构");
  if (
    !doc.head ||
    Object.keys(doc.head).some((k) => !["title", "#text"].includes(k)) ||
    typeof doc.head.title !== "string"
  )
    throw new Error("原型只支持含 title 的 OPML head，不会丢弃扩展字段");
  if (
    !doc.body ||
    Object.keys(doc.body).some((k) => !["outline", "#text"].includes(k)) ||
    doc.body.outline?.length !== 1
  )
    throw new Error("原型导图须有一个根节点");
  if (
    [doc, doc.head, doc.body].some(
      (n) => typeof n["#text"] === "string" && n["#text"].trim(),
    )
  )
    throw new Error("不支持的 OPML 混合正文");
  let count = 0;
  function read(raw: Record<string, unknown>, depth: number): Topic {
    if (++count > 2000 || depth > 64)
      throw new Error("导图超过原型节点/深度限制");
    if (typeof raw["@_text"] !== "string" || !raw["@_text"].trim())
      throw new Error("导图节点标题不能为空");
    const attrs: Record<string, string> = {};
    for (const [k, v] of Object.entries(raw)) {
      if (k.startsWith("@_")) {
        if (typeof v !== "string") throw new Error("OPML 属性必须是文本");
        attrs[k.slice(2)] = v;
      } else if (
        k !== "outline" &&
        !(k === "#text" && typeof v === "string" && !v.trim())
      )
        throw new Error("原型不支持此节点扩展，原文未修改");
    }
    const { text, zfyBody = "", type = "topic", ...extra } = attrs;
    return {
      text,
      body: zfyBody,
      type,
      attrs: extra,
      children: ((raw.outline ?? []) as Record<string, unknown>[]).map((c) =>
        read(c, depth + 1),
      ),
    };
  }
  return { title: doc.head.title, root: read(doc.body.outline[0], 0) };
}
export function parseRelations(text: string, map: Mindmap): Relation[] {
  if (!text.trim()) return [];
  const data = relationsSchema.parse(safeYaml(text));
  const paths = new Set(flatten(map).map((r) => r.path));
  if (data.relations.some((r) => !paths.has(r.from) || !paths.has(r.to)))
    throw new Error("关系指向不存在的节点，原型不会猜测修复");
  return data.relations;
}
export function serializeRelations(
  mapPath: string,
  relations: Relation[],
): string {
  return stringify({
    version: 1,
    map: `./${mapPath.split("/").pop()}`,
    relations,
  });
}
