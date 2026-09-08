import { diff3Merge } from "node-diff3";
import { contentFingerprint, type DualViewState } from "./dual-view";
import { parseOpml, serializeOpml, type Mindmap, type Topic } from "./formats";

const splitLines = (value: string) => value.match(/[^\n]*\n|[^\n]+$/g) ?? [];

export type IncrementalSyncResult =
  | { kind: "synced"; content: string; changed: boolean }
  | { kind: "unchanged"; content: string }
  | { kind: "baseline-required"; message: string }
  | { kind: "conflict"; message: string };

function same(value: unknown, other: unknown) {
  return JSON.stringify(value) === JSON.stringify(other);
}

function mergeValue<T>(base: T, target: T, converted: T): T {
  if (!same(target, base) && !same(converted, base) && !same(target, converted))
    throw new Error("overlap");
  return same(converted, base) && !same(target, base) ? target : converted;
}

function mergeRecord(
  base: Record<string, string> | undefined,
  target: Record<string, string> | undefined,
  converted: Record<string, string> | undefined,
) {
  const result: Record<string, string> = {};
  for (const key of new Set([
    ...Object.keys(base ?? {}),
    ...Object.keys(target ?? {}),
    ...Object.keys(converted ?? {}),
  ])) {
    const value = mergeValue(base?.[key], target?.[key], converted?.[key]);
    if (value !== undefined) result[key] = value;
  }
  return Object.keys(result).length ? result : undefined;
}

function nodeKeys(nodes: Topic[]) {
  const counts = new Map<string, number>();
  return new Map(nodes.map((node) => {
    const index = (counts.get(node.text) ?? 0) + 1;
    counts.set(node.text, index);
    return [`${node.text}\u0000${index}`, node] as const;
  }));
}

function mergeTopic(base: Topic, target: Topic, converted: Topic): Topic {
  const merged: Topic = {
    text: mergeValue(base.text, target.text, converted.text),
    body: mergeValue(base.body, target.body, converted.body),
    type: mergeValue(base.type, target.type, converted.type),
    attrs: mergeRecord(base.attrs, target.attrs, converted.attrs) ?? {},
    children: [],
  };
  const baseChildren = nodeKeys(base.children);
  const targetChildren = nodeKeys(target.children);
  const convertedChildren = nodeKeys(converted.children);
  for (const [key, candidate] of convertedChildren) {
    const prior = baseChildren.get(key);
    const edited = targetChildren.get(key);
    if (!prior) {
      if (edited) throw new Error("same-name concurrent addition");
      merged.children.push(structuredClone(candidate));
      continue;
    }
    if (!edited) {
      // A target-side deletion is retained only while the source still has the
      // exact baseline node. Recreating a source-edited deleted node would be
      // an unannounced destructive decision.
      if (same(candidate, prior)) continue;
      throw new Error("deleted source-edited node");
    }
    merged.children.push(mergeTopic(prior, edited, candidate));
  }
  for (const [key, edited] of targetChildren) {
    if (!baseChildren.has(key) && !convertedChildren.has(key))
      merged.children.push(structuredClone(edited));
  }
  for (const [key, prior] of baseChildren) {
    if (convertedChildren.has(key) || !targetChildren.has(key)) continue;
    if (!same(targetChildren.get(key), prior))
      throw new Error("source deletion overlaps target edit");
  }
  return merged;
}

/** Merge OPML by nodes before falling back to textual diff3. It lets a
 * Markdown structural addition coexist with independent map-node body/type/
 * attribute edits, while rejecting ambiguous renames or competing edits. */
export function mergeOpmlProjection(baseText: string, targetText: string, convertedText: string) {
  const base = parseOpml(baseText);
  const target = parseOpml(targetText);
  const converted = parseOpml(convertedText);
  const merged: Mindmap = {
    title: mergeValue(base.title, target.title, converted.title),
    root: mergeTopic(base.root, target.root, converted.root),
    head: mergeRecord(base.head, target.head, converted.head),
    attributes: mergeRecord(base.attributes, target.attributes, converted.attributes),
  };
  return serializeOpml(merged);
}

type MarkdownBlock = { key: string; lines: string[] };

function markdownBlocks(value: string): MarkdownBlock[] {
  const lines = splitLines(value);
  const blocks: MarkdownBlock[] = [];
  let current: MarkdownBlock = { key: "\u0000preamble", lines: [] };
  const counts = new Map<string, number>();
  for (const line of lines) {
    const match = /^(#{1,6})[ \t]+(.+?)[ \t]*\n?$/.exec(line);
    if (match) {
      if (current.lines.length) blocks.push(current);
      const identity = `${match[1].length}\u0000${match[2]}`;
      const ordinal = (counts.get(identity) ?? 0) + 1;
      counts.set(identity, ordinal);
      current = { key: `${identity}\u0000${ordinal}`, lines: [line] };
    } else current.lines.push(line);
  }
  if (current.lines.length || !blocks.length) blocks.push(current);
  return blocks;
}

function mergeMarkdownBlock(
  base: string[] | undefined,
  target: string[] | undefined,
  converted: string[] | undefined,
): string[] | null {
  if (!base) {
    if (!target) return converted ? [...converted] : null;
    if (!converted) return [...target];
    if (same(target, converted)) return [...target];
    throw new Error("same markdown block added twice");
  }
  if (!target) {
    if (converted && !same(converted, base)) throw new Error("deleted markdown block edited");
    return null;
  }
  if (!converted) {
    if (!same(target, base)) throw new Error("source deleted edited markdown block");
    return null;
  }
  if (same(target, base)) return [...converted];
  if (same(converted, base)) return [...target];
  if (same(target, converted)) return [...target];
  const parts = diff3Merge(target, base, converted);
  if (parts.some((part) => part.conflict)) throw new Error("overlapping markdown block");
  return parts.flatMap((part) => part.ok ?? []);
}

/** Merge Markdown by independent preamble/heading blocks. This avoids treating
 * a map-root body insertion and a Markdown child-heading insertion as one text
 * conflict, while still rejecting edits to the same block or ambiguous renames.
 */
export function mergeMarkdownProjection(
  baseText: string,
  targetText: string,
  convertedText: string,
) {
  const base = new Map(markdownBlocks(baseText).map((block) => [block.key, block.lines]));
  const target = new Map(markdownBlocks(targetText).map((block) => [block.key, block.lines]));
  const converted = new Map(markdownBlocks(convertedText).map((block) => [block.key, block.lines]));
  const order = [
    ...markdownBlocks(targetText).map((block) => block.key),
    ...markdownBlocks(convertedText).map((block) => block.key),
    ...markdownBlocks(baseText).map((block) => block.key),
  ].filter((key, index, all) => all.indexOf(key) === index);
  return order
    .flatMap((key) => mergeMarkdownBlock(base.get(key), target.get(key), converted.get(key)) ?? [])
    .join("");
}

/**
 * Merge a freshly converted projection into its existing companion using the
 * last successful conversion as a common base. A conflict is deliberately not
 * written: the user keeps both representations intact instead of losing map
 * layout/body edits that are important for recall.
 */
export function incrementalDualSync(options: {
  state: DualViewState | null;
  source: "markdown" | "opml";
  sourceCurrent: string;
  targetCurrent: string;
  convert: () => string;
  validateTarget?: (value: string) => void;
  mergeStructured?: (base: string, target: string, converted: string) => string;
}): IncrementalSyncResult {
  const { state, source, sourceCurrent, targetCurrent, convert, validateTarget, mergeStructured } = options;
  const sourceBaseline = source === "markdown" ? state?.baselineMarkdown : state?.baselineOpml;
  const targetBaseline = source === "markdown" ? state?.baselineOpml : state?.baselineMarkdown;
  const targetFingerprint = source === "markdown" ? state?.opml : state?.markdown;

  if (!state || !sourceBaseline || !targetBaseline) {
    // A legacy fingerprint-only sidecar can still be safely upgraded when the
    // target has not changed since it was recorded. Otherwise there is no base
    // from which to distinguish user edits from generated content.
    if (state && targetFingerprint === contentFingerprint(targetCurrent)) {
      const content = convert();
      validateTarget?.(content);
      return { kind: "synced", content, changed: content !== targetCurrent };
    }
    return {
      kind: "baseline-required",
      message: "缺少可用的共同基线；另一视图已有改动，未进行可能覆盖内容的完整重建。请先记录当前双视图基线。",
    };
  }

  if (sourceCurrent === sourceBaseline)
    return { kind: "unchanged", content: targetCurrent };

  const converted = convert();
  if (targetCurrent === targetBaseline) {
    validateTarget?.(converted);
    return { kind: "synced", content: converted, changed: converted !== targetCurrent };
  }
  if (converted === targetBaseline)
    // The source changed, but its projection has no effect on the target.
    // Still return a successful result so the caller records a fresh common
    // baseline; otherwise the same harmless source edit is reported forever.
    return { kind: "synced", content: targetCurrent, changed: false };

  if (mergeStructured) {
    try {
      const content = mergeStructured(targetBaseline, targetCurrent, converted);
      validateTarget?.(content);
      return { kind: "synced", content, changed: content !== targetCurrent };
    } catch {
      return {
        kind: "conflict",
        message: "检测到两侧对同一导图结构的重叠修改，未覆盖任何一侧。请手动处理后记录新的双视图基线。",
      };
    }
  }

  const parts = diff3Merge(
    splitLines(targetCurrent),
    splitLines(targetBaseline),
    splitLines(converted),
  );
  if (parts.some((part) => part.conflict))
    return {
      kind: "conflict",
      message: "检测到两侧对同一内容的重叠修改，未覆盖任何一侧。请手动处理后记录新的双视图基线。",
    };
  const content = parts.map((part) => part.ok!.join("")).join("");
  try {
    validateTarget?.(content);
  } catch {
    return {
      kind: "conflict",
      message: "增量合并会产生无效的结构化内容，未覆盖任何一侧。请手动处理后记录新的双视图基线。",
    };
  }
  return { kind: "synced", content, changed: content !== targetCurrent };
}
