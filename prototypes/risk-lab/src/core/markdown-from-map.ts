import { type Mindmap, type Topic } from "./formats";

function headingText(value: string) {
  return value.replace(/[\r\n]+/g, " ").trim() || "未命名节点";
}

/**
 * Deterministic export for a missing Markdown companion. Relations deliberately
 * remain in their YAML sidecar: changing a map hierarchy is not a claim that a
 * sibling relationship is causal, evidential, or otherwise semantic.
 */
export function markdownFromMap(map: Mindmap) {
  const syntheticMarkdownRoot = map.root.attrs.zfySource === "markdown";
  let originalFrontMatter = "";
  if (syntheticMarkdownRoot && map.root.attrs.zfyFrontMatterRaw) {
    try {
      const binary = atob(map.root.attrs.zfyFrontMatterRaw);
      originalFrontMatter = new TextDecoder().decode(
        Uint8Array.from(binary, (unit) => unit.charCodeAt(0)),
      );
    } catch {
      throw new Error("导图中的 Markdown 元数据编码无效");
    }
  }
  const hasFrontMatter = map.root.attrs.zfyHasFrontMatter === "true" || map.root.attrs.zfyFrontMatter === "true";
  if (originalFrontMatter) originalFrontMatter = originalFrontMatter.replace(/\r?\n$/, "");
  const chunks = syntheticMarkdownRoot && !hasFrontMatter
    ? []
    : [originalFrontMatter || `---\ntitle: ${JSON.stringify(map.title)}\n---`];
  const render = (node: Topic, depth: number) => {
    const heading = "#".repeat(Math.min(depth, 6));
    chunks.push(`${heading} ${headingText(node.text)}`);
    if (node.body.trim()) chunks.push(node.body.trim());
    for (const child of node.children) render(child, depth + 1);
  };
  if (syntheticMarkdownRoot) {
    if (map.root.body.trim()) chunks.push(map.root.body.trim());
    for (const child of map.root.children) render(child, 1);
  } else render(map.root, 1);
  if (!chunks.length) return "";
  return chunks.join("\n\n") + "\n";
}
