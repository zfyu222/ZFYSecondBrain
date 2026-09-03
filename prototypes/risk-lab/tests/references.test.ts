import { describe, expect, it } from "vitest";
import { rewriteMarkdown, rewriteTarget, moveNote } from "../src/core/paths";
import { safeYaml, serializeOpml, topic } from "../src/core/formats";

const from = "raw/Inbox/a.md",
  to = "raw/Projects/b.md",
  owner = "raw/Areas/ref.md";
const moves = new Map([[from, to]]);
const rewrite = (text: string) => rewriteMarkdown(text, owner, owner, moves);
describe("source-position Markdown reference rewriting", () => {
  it("changes only the destination when labels and titles repeat it", () => {
    expect(
      rewrite('[../Inbox/a.md](../Inbox/a.md "title ]( ../Inbox/a.md")'),
    ).toBe('[../Inbox/a.md](../Projects/b.md "title ]( ../Inbox/a.md")');
  });
  it("handles colon-containing reference definitions and preserves CRLF", () => {
    const text =
      '[use][label:x]\r\n\r\n[label:x]: <../Inbox/a.md> "keep title"\r\n';
    expect(rewrite(text)).toBe(
      text.replace("<../Inbox/a.md>", "<../Projects/b.md>"),
    );
  });
  it("decodes escaped parentheses and safely encodes new destination syntax", () => {
    const result = rewriteMarkdown(
      '[x](../Inbox/a\\(b\\).md "keep")',
      owner,
      owner,
      new Map([["raw/Inbox/a(b).md", "raw/Projects/new (copy)#1.md"]]),
    );
    expect(result).toBe('[x](../Projects/new%20%28copy%29%231.md "keep")');
  });
  it("decodes entity references without changing other entity-containing text", () => {
    expect(
      rewriteMarkdown(
        "[&amp;](../Inbox/a&amp;b.md)",
        owner,
        owner,
        new Map([["raw/Inbox/a&b.md", "raw/Projects/c&d.md"]]),
      ),
    ).toBe("[&amp;](../Projects/c&amp;d.md)");
  });
  it("preserves query strings and fragments", () => {
    expect(rewrite("[x](../Inbox/a.md?view=1&mode=2#标题)")).toBe(
      "[x](../Projects/b.md?view=1&amp;mode=2#标题)",
    );
    expect(rewriteTarget("", from, to, moves)).toBe("");
    expect(rewriteTarget("?view=1", from, to, moves)).toBe("?view=1");
  });
  it("preserves encoded filename hashes instead of turning them into fragments", () => {
    expect(
      rewriteMarkdown(
        "[x](../Inbox/a%23b.md#part)",
        owner,
        owner,
        new Map([["raw/Inbox/a#b.md", "raw/Projects/c#d.md"]]),
      ),
    ).toBe("[x](../Projects/c%23d.md#part)");
  });
  it("does not change escaped wiki links, code blocks, inline code or link titles", () => {
    const source =
      '\\[[raw/Inbox/a]]\n\n`[[raw/Inbox/a]]`\n\n```md\n[[raw/Inbox/a]]\n```\n\n    [[raw/Inbox/a]]\n\n[x](https://example.com "[[raw/Inbox/a]]")\n\n[[raw/Inbox/a|actual]]';
    expect(rewrite(source)).toBe(
      source.replace("[[raw/Inbox/a|actual]]", "[[raw/Projects/b|actual]]"),
    );
  });
  it("handles links within GFM tables without reformatting surrounding cells", () => {
    const source =
      "| item | link |\n| --- | --- |\n|  a  | [x](../Inbox/a.md) |\n";
    expect(rewrite(source)).toBe(
      source.replace("../Inbox/a.md", "../Projects/b.md"),
    );
  });
  it("does not rewrite link-like text inside inline or display math", () => {
    const math =
      "$[[raw/Inbox/a]] + [x](../Inbox/a.md)$\n\n$$\n[[raw/Inbox/a]] + [x](../Inbox/a.md)\n$$";
    expect(rewrite(math + "\n\n[[raw/Inbox/a|real]]")).toBe(
      math + "\n\n[[raw/Projects/b|real]]",
    );
  });
  it("still rewrites real links next to escaped dollars and inside callouts/highlights", () => {
    const source =
      "> [!note]- 标题\r\n> ==[x](../Inbox/a.md)== 与 \\$ [[raw/Inbox/a|真实]] \\$";
    expect(rewrite(source)).toBe(
      source
        .replace("../Inbox/a.md", "../Projects/b.md")
        .replace("raw/Inbox/a|", "raw/Projects/b|"),
    );
  });
  it("keeps math paths literal even when the owning document moves", () => {
    const source = "$[[邻居]] + [x](邻居.md)$\n\n[[邻居]]";
    expect(rewriteMarkdown(source, from, to, moves)).toBe(
      "$[[邻居]] + [x](邻居.md)$\n\n[[../Inbox/邻居]]",
    );
  });
  it("preserves unchanged Markdown byte-for-byte", () => {
    const source =
      "# title\r\n\r\n[x](https://example.com)\r\n\r\n*  weird   spacing\r\n";
    expect(rewrite(source)).toBe(source);
  });
});

describe("Front Matter and unsupported HTML boundaries", () => {
  it("rewrites explicit metadata references and leaves values/comments/body intact", () => {
    const body = "\r\n# Body\r\n\r\n  Text with  spacing.\r\n";
    const source =
      '---\r\ntitle: Keep me # title comment\r\nfavorite: true\r\ntags: [one, two]\r\nrelated: "[[raw/Inbox/a|alias]]" # link comment\r\nlinks:\r\n  - ../Inbox/a.md#part\r\n---\r\n' +
      body;
    const result = rewrite(source);
    const yaml = /^---\r\n([\s\S]*?)\r\n---\r\n/.exec(result)![1];
    expect(safeYaml(yaml)).toEqual({
      title: "Keep me",
      favorite: true,
      tags: ["one", "two"],
      related: "[[raw/Projects/b|alias]]",
      links: ["../Projects/b.md#part"],
    });
    expect(result.endsWith(body)).toBe(true);
    expect(result).toContain("# title comment");
    expect(result).toContain("# link comment");
  });
  it("does not reprint metadata when no reference changes", () => {
    const source = "---\ntitle:   Keep me\ntags: [one,two]\n---\ntext";
    expect(rewrite(source)).toBe(source);
  });
  it("adjusts cover paths when their owner moves", () => {
    const source = "---\ncover: a.assets/image.jpg\n---\nbody";
    const files = moveNote(
      { [from]: source, "raw/Inbox/a.assets/image.jpg": "text-only fixture" },
      from,
      to,
    ).files;
    expect(files[to]).toContain("cover: b.assets/image.jpg");
  });
  it.each([
    '---\nrelated: &x "[[raw/Inbox/a]]"\nother: *x\n---\n',
    "---\ntitle: missing closing delimiter",
  ])("rejects unsafe or incomplete metadata before writing: %s", (text) => {
    expect(() => rewrite(text)).toThrow();
  });
  it("refuses unknown metadata path fields instead of guessing their meaning", () => {
    expect(() => rewrite("---\ncustom: raw/Inbox/a.md\n---\n")).toThrow(
      "未知字段",
    );
  });
  it.each([
    '<a href="../Inbox/a.md">a</a>',
    '<video src="../Inbox/a.md"></video>',
    '<img srcset="../Inbox/a.md 1x, other.jpg 2x">',
  ])("refuses relevant unsupported HTML resource references: %s", (text) => {
    expect(() => rewrite(text)).toThrow("HTML");
  });
  it("leaves external HTML resources untouched", () => {
    const text = '<video src="https://example.com/movie.mp4"></video>';
    expect(rewriteMarkdown(text, from, to, moves)).toBe(text);
  });
  it.each([
    ["derived/view.json", '{"target":"../raw/Inbox/a.md"}'],
    ["raw/Areas/view.yaml", "target: ../Inbox/a.md"],
  ])(
    "refuses relative references in unknown structured schemas: %s",
    (path, text) => {
      expect(() => moveNote({ [from]: "# A", [path]: text }, from, to)).toThrow(
        "schema",
      );
    },
  );
  it("refuses unknown OPML reference attributes but retains unrelated attributes", () => {
    const linked = serializeOpml({
      title: "x",
      root: { ...topic("x"), attrs: { customLink: "../Inbox/a.md" } },
    });
    expect(() =>
      moveNote({ [from]: "# A", "raw/Areas/other.opml": linked }, from, to),
    ).toThrow("schema");
    const plain = serializeOpml({
      title: "x",
      root: { ...topic("x"), attrs: { custom: "keep" } },
    });
    expect(
      moveNote({ [from]: "# A", "raw/Areas/other.opml": plain }, from, to)
        .files["raw/Areas/other.opml"],
    ).toBe(plain);
  });
});
