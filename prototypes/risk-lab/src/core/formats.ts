import { XMLParser, XMLValidator } from "fast-xml-parser";
import { parseDocument, stringify, isMap, isSeq, isScalar } from "yaml";
import { z } from "zod";

export type Topic = {
  text: string;
  body: string;
  type: string;
  children: Topic[];
  attrs: Record<string, string>;
};
export type Mindmap = {
  title: string;
  root: Topic;
  /** Opaque scalar head fields and document attributes are preserved, never executed. */
  head?: Record<string, string>;
  attributes?: Record<string, string>;
};
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
): { map: Mindmap; relations: Relation[]; relationOrigins: number[] } {
  const next = structuredClone(map);
  const oldPaths = new Map(flatten(next).map((row) => [row.node, row.path]));
  action(next);
  const remap = new Map(
    flatten(next).map((row) => [oldPaths.get(row.node), row.path]),
  );
  const surviving = relations
    .map((relation, index) => ({ relation, index }))
    .filter(
      ({ relation }) => remap.has(relation.from) && remap.has(relation.to),
    );
  return {
    map: next,
    relations: surviving.map(({ relation: r }) => ({
      ...r,
      from: remap.get(r.from)!,
      to: remap.get(r.to)!,
    })),
    relationOrigins: surviving.map(({ index }) => index),
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
const xmlName = /^[a-zA-Z_][\w.-]*(?::[a-zA-Z_][\w.-]*)?$/;
function xmlAttribute(name: string, value: string) {
  if (!xmlName.test(name) || typeof value !== "string")
    throw new Error("不支持的 OPML 属性");
  return ` ${name}="${attrEscape(value)}"`;
}
export function serializeOpml(map: Mindmap): string {
  function outline(n: Topic, level: number): string {
    const attributes = {
      ...n.attrs,
      text: n.text,
      type: n.type,
      zfyBody: n.body,
    };
    const attrs = Object.entries(attributes)
      .map(([k, v]) => xmlAttribute(k, v))
      .join("");
    const indent = "  ".repeat(level);
    return n.children.length
      ? `${indent}<outline${attrs}>\n${n.children.map((c) => outline(c, level + 1)).join("\n")}\n${indent}</outline>`
      : `${indent}<outline${attrs} />`;
  }
  const attributes = Object.entries(map.attributes ?? {})
    .map(([name, value]) => {
      if (name === "version") throw new Error("OPML 扩展属性不能覆盖版本");
      return xmlAttribute(name, value);
    })
    .join("");
  const head = Object.entries(map.head ?? {})
    .map(([name, value]) => {
      if (!xmlName.test(name) || name === "title" || typeof value !== "string")
        throw new Error("不支持的 OPML head 字段");
      return `<${name}>${attrEscape(value)}</${name}>`;
    })
    .join("");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<opml version="2.0"${attributes}>\n  <head><title>${attrEscape(map.title)}</title>${head}</head>\n  <body>\n${outline(map.root, 2)}\n  </body>\n</opml>\n`;
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
  const declaration = parsed["?xml"];
  if (
    declaration &&
    (Array.isArray(declaration) ||
      typeof declaration !== "object" ||
      Object.keys(declaration).some(
        (name) => !["@_version", "@_encoding"].includes(name),
      ) ||
      declaration["@_version"] !== "1.0" ||
      (declaration["@_encoding"] !== undefined &&
        !/^utf-?8$/i.test(declaration["@_encoding"])))
  )
    throw new Error("原型不重写未知 XML 声明或非 UTF-8 编码，原文未修改");
  const doc = parsed.opml;
  if (
    !doc ||
    doc["@_version"] !== "2.0" ||
    Object.keys(doc).some(
      (k) => !["head", "body", "#text"].includes(k) && !k.startsWith("@_"),
    )
  )
    throw new Error("不支持的 OPML 文档结构");
  if (!doc.head || typeof doc.head.title !== "string")
    throw new Error("原型需要唯一文本 title，不会猜测或丢弃 OPML head");
  const head: Record<string, string> = Object.create(null);
  for (const [name, value] of Object.entries(doc.head)) {
    if (["title", "#text"].includes(name)) continue;
    if (!xmlName.test(name) || typeof value !== "string")
      throw new Error("原型只保留单值文本 OPML head 字段，复杂扩展原文未修改");
    head[name] = value;
  }
  const attributes: Record<string, string> = Object.create(null);
  for (const [name, value] of Object.entries(doc)) {
    if (!name.startsWith("@_") || name === "@_version") continue;
    if (!xmlName.test(name.slice(2)) || typeof value !== "string")
      throw new Error("不支持的 OPML 文档属性");
    attributes[name.slice(2)] = value;
  }
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
    const attrs: Record<string, string> = Object.create(null);
    for (const [k, v] of Object.entries(raw)) {
      if (k.startsWith("@_")) {
        if (typeof v !== "string" || !xmlName.test(k.slice(2)))
          throw new Error("OPML 属性必须是受支持的文本属性");
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
  return {
    title: doc.head.title,
    root: read(doc.body.outline[0], 0),
    ...(Object.keys(head).length ? { head: { ...head } } : {}),
    ...(Object.keys(attributes).length
      ? { attributes: { ...attributes } }
      : {}),
  };
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
  source?: { text: string; indices: (number | null)[] },
): string {
  const desired = relationsSchema.parse({
    version: 1,
    map: `./${mapPath.split("/").pop()}`,
    relations,
  });
  if (!source) return stringify(desired);
  if (source.indices.length !== relations.length)
    throw new Error("关系来源数量不一致，原文未修改");
  if (!source.text.trim()) {
    if (source.indices.some((index) => index !== null))
      throw new Error("空关系文件没有可复用的来源");
    return relations.length ? stringify(desired) : source.text;
  }
  const original = relationsSchema.parse(safeYaml(source.text));
  const used = new Set<number>();
  for (const index of source.indices) {
    if (index === null) continue;
    if (
      !Number.isInteger(index) ||
      index < 0 ||
      index >= original.relations.length ||
      used.has(index)
    )
      throw new Error("关系来源无效或重复，原文未修改");
    used.add(index);
  }
  if (
    JSON.stringify(original) === JSON.stringify(desired) &&
    source.indices.every((index, position) => index === position)
  )
    return source.text;
  const doc = parseDocument(source.text);
  const sequence = doc.get("relations", true);
  if (!isSeq(sequence)) throw new Error("关系列表不是可保留的 YAML 序列");
  const oldItems = [...sequence.items];
  sequence.items = relations.map((relation, position) => {
    const index = source.indices[position];
    if (index === null) return doc.createNode(relation);
    const item = oldItems[index];
    if (!isMap(item)) throw new Error("关系项不是可保留的 YAML 映射");
    for (const field of ["from", "to", "type", "status"] as const) {
      const scalar = item.get(field, true);
      if (!isScalar(scalar)) throw new Error("关系字段不是可保留的标量");
      // Update values in place so inline comments, quoting and node comments survive.
      scalar.value = relation[field];
    }
    return item;
  });
  const mapNode = doc.get("map", true);
  if (!isScalar(mapNode)) throw new Error("关系 map 不是可保留的标量");
  mapNode.value = desired.map;
  const text = String(doc).replace(
    /\r?\n/g,
    source.text.includes("\r\n") ? "\r\n" : "\n",
  );
  if (
    JSON.stringify(relationsSchema.parse(safeYaml(text))) !==
    JSON.stringify(desired)
  )
    throw new Error("关系序列化校验失败，原文未修改");
  return text;
}
