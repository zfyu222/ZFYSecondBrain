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
  const chunks = [`---\ntitle: ${JSON.stringify(map.title)}\n---`];
  const render = (node: Topic, depth: number) => {
    const heading = "#".repeat(Math.min(depth, 6));
    chunks.push(`${heading} ${headingText(node.text)}`);
    if (node.body.trim()) chunks.push(node.body.trim());
    for (const child of node.children) render(child, depth + 1);
  };
  render(map.root, 1);
  return chunks.join("\n\n") + "\n";
}
