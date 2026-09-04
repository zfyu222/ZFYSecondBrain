import { type Mindmap, topic } from "./formats";

type StackEntry = { level: number; node: ReturnType<typeof topic> };

/**
 * Create a deliberately structural map from Markdown headings. This is a
 * manual fallback, not an AI interpretation: prose is retained in node bodies
 * and no semantic relation is invented from sibling order or heading depth.
 */
export function mapFromMarkdown(title: string, source: string): Mindmap {
  const root = topic(title);
  const stack: StackEntry[] = [{ level: 0, node: root }];
  const body = new Map<ReturnType<typeof topic>, string[]>();
  body.set(root, []);
  let fenced = false;
  const content = source.replace(/^\uFEFF?---\r?\n[\s\S]*?\r?\n(?:---|\.\.\.)(?:\r?\n|$)/, "");

  for (const line of content.split(/\r?\n/)) {
    if (/^\s*(```|~~~)/.test(line)) fenced = !fenced;
    const match = fenced ? null : /^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (!match) {
      body.get(stack.at(-1)!.node)!.push(line);
      continue;
    }
    const level = match[1].length;
    while (stack.length > 1 && stack.at(-1)!.level >= level) stack.pop();
    const node = topic(match[2]);
    stack.at(-1)!.node.children.push(node);
    stack.push({ level, node });
    body.set(node, []);
  }
  for (const [node, lines] of body) {
    node.body = lines.join("\n").trim();
  }
  return { title, root };
}
