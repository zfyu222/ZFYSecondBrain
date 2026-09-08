import { describe, expect, it } from "vitest";
import { dualViewChanges, readDualView, recordDualView } from "../src/core/dual-view";
import {
  incrementalDualSync,
  mergeMarkdownProjection,
  mergeOpmlProjection,
} from "../src/core/incremental-dual-view";
import { mapFromMarkdown } from "../src/core/map-from-markdown";
import { markdownFromMap } from "../src/core/markdown-from-map";
import { parseOpml, serializeOpml } from "../src/core/formats";

describe("portable dual-view baselines", () => {
  it("records readable content fingerprints and finds each changed view", () => {
    const state = readDualView(recordDualView("# A", "<opml />", "2026-09-04T03:00:00.000Z"));
    expect(state).toMatchObject({ version: 2, baselineMarkdown: "# A", baselineOpml: "<opml />" });
    expect(dualViewChanges(state, "# A", "<opml />")).toEqual({ markdown: false, opml: false, known: true });
    expect(dualViewChanges(state, "# B", "<opml />")).toMatchObject({ markdown: true, opml: false });
  });
  it("rejects malformed sidecars instead of guessing a baseline", () => {
    expect(() => readDualView("version: 2\n")).toThrow("格式");
  });

  it("merges a Markdown delta into an independently annotated map", () => {
    const markdown = "# Root\n\n旧内容\n";
    const opml = serializeOpml(mapFromMarkdown("Root", markdown));
    const state = readDualView(recordDualView(markdown, opml, "2026-09-04T03:00:00.000Z"))!;
    const mapWithNote = opml.replace("</title>", "</title><owner>me</owner>");
    const result = incrementalDualSync({
      state,
      source: "markdown",
      sourceCurrent: "# Root\n\n旧内容\n\n## 新节点\n\n增量内容\n",
      targetCurrent: mapWithNote,
      convert: () => serializeOpml(mapFromMarkdown("Root", "# Root\n\n旧内容\n\n## 新节点\n\n增量内容\n")),
      validateTarget: parseOpml,
    });
    expect(result).toMatchObject({ kind: "synced" });
    if (result.kind !== "synced") throw new Error("expected synced");
    expect(result.content).toContain("<owner>me</owner>");
    expect(parseOpml(result.content).root.children[0].children[0].text).toBe("新节点");
  });

  it("merges a map delta without replacing an independent Markdown section", () => {
    const map = mapFromMarkdown("Root", "# Root\n\n旧内容\n");
    const opml = serializeOpml(map);
    const markdown = markdownFromMap(map);
    const state = readDualView(recordDualView(markdown, opml, "2026-09-04T03:00:00.000Z"))!;
    const changedMap = structuredClone(map);
    changedMap.root.body = "来自导图的新内容";
    const changedOpml = serializeOpml(changedMap);
    const result = incrementalDualSync({
      state,
      source: "opml",
      sourceCurrent: changedOpml,
      targetCurrent: markdown + "\n## 手工附注\n\n这段不应丢失。\n",
      convert: () => markdownFromMap(parseOpml(changedOpml)),
    });
    expect(result).toMatchObject({ kind: "synced" });
    if (result.kind !== "synced") throw new Error("expected synced");
    expect(result.content).toContain("来自导图的新内容");
    expect(result.content).toContain("## 手工附注");
    expect(result.content.indexOf("## 手工附注")).toBeGreaterThan(
      result.content.indexOf("# Root"),
    );
  });

  it("advances the baseline when a source-only edit projects to the old target", () => {
    const markdown = "# Root\n\n正文\n";
    const opml = serializeOpml(mapFromMarkdown("Root", markdown));
    const state = readDualView(recordDualView(markdown, opml, "2026-09-04T03:00:00.000Z"))!;
    const sourceCurrent = "# Root\n\n正文\n\n<!-- local annotation -->\n";
    const targetCurrent = opml.replace("</head>", "<owner>me</owner></head>");
    const result = incrementalDualSync({
      state,
      source: "markdown",
      sourceCurrent,
      targetCurrent,
      convert: () => opml,
      validateTarget: parseOpml,
      mergeStructured: mergeOpmlProjection,
    });
    expect(result).toEqual({ kind: "synced", content: targetCurrent, changed: false });
  });

  it("keeps an independently edited map node body while Markdown adds a child", () => {
    const markdown = "# Root\n\n初始正文\n";
    const opml = serializeOpml(mapFromMarkdown("笔记", markdown));
    const state = readDualView(recordDualView(markdown, opml, "2026-09-04T03:00:00.000Z"))!;
    const manuallyEdited = parseOpml(opml);
    manuallyEdited.root.body = "导图独立备注";
    const sourceCurrent = "# Root\n\n初始正文\n\n## 增量节点\n\n增量内容\n";
    const result = incrementalDualSync({
      state,
      source: "markdown",
      sourceCurrent,
      targetCurrent: serializeOpml(manuallyEdited),
      convert: () => serializeOpml(mapFromMarkdown("笔记", sourceCurrent)),
      validateTarget: parseOpml,
      mergeStructured: mergeOpmlProjection,
    });
    expect(result).toMatchObject({ kind: "synced" });
    if (result.kind !== "synced") throw new Error("expected synced");
    const merged = parseOpml(result.content);
    expect(merged.root.body).toBe("导图独立备注");
    expect(merged.root.children[0].children[0].text).toBe("增量节点");
  });

  it("merges a map root-body edit with a Markdown child insertion", () => {
    const markdown = "# Root\n";
    const map = mapFromMarkdown("笔记", markdown);
    const opml = serializeOpml(map);
    const state = readDualView(recordDualView(markdown, opml, "2026-09-04T03:00:00.000Z"))!;
    const changedMap = structuredClone(map);
    changedMap.root.body = "导图记下的前置说明";
    const changedOpml = serializeOpml(changedMap);
    const result = incrementalDualSync({
      state,
      source: "opml",
      sourceCurrent: changedOpml,
      targetCurrent: "# Root\n\n## Markdown 子节点\n\n保留这段。\n",
      convert: () => markdownFromMap(parseOpml(changedOpml)),
      mergeStructured: mergeMarkdownProjection,
    });
    expect(result).toMatchObject({ kind: "synced" });
    if (result.kind !== "synced") throw new Error("expected synced");
    expect(result.content).toContain("导图记下的前置说明");
    expect(result.content).toContain("## Markdown 子节点");
  });

  it("refuses overlapping edits and legacy baselines with a changed target", () => {
    const state = readDualView(recordDualView("# Root\n\n旧内容\n", "<opml />", "2026-09-04T03:00:00.000Z"))!;
    const conflict = incrementalDualSync({
      state,
      source: "markdown",
      sourceCurrent: "# Root\n\n来源改动\n",
      targetCurrent: "<opml>目标改动</opml>",
      convert: () => "<opml>来源改动</opml>",
    });
    expect(conflict.kind).toBe("conflict");
    const legacy = readDualView("version: 1\nmarkdown: fnv1a-00000000\nopml: fnv1a-00000000\nrecorded_at: 2026-09-04T03:00:00.000Z\n")!;
    expect(incrementalDualSync({
      state: legacy,
      source: "markdown",
      sourceCurrent: "# A",
      targetCurrent: "<opml>manually changed</opml>",
      convert: () => "<opml>new</opml>",
    }).kind).toBe("baseline-required");
  });

  it("preserves a target-only node deletion while rejecting deletion of an edited node", () => {
    const baseMap = {
      title: "Root",
      root: { text: "Root", body: "", type: "topic", attrs: {}, children: [
        { text: "节点", body: "正文", type: "topic", attrs: {}, children: [] },
      ] },
    };
    const base = serializeOpml(baseMap);
    const state = readDualView(recordDualView("# Root\n", base, "2026-09-04T03:00:00.000Z"))!;
    const deleted = structuredClone(baseMap);
    deleted.root.children = [];
    const sourceMap = structuredClone(baseMap);
    sourceMap.root.body = "来源备注";
    const safe = incrementalDualSync({
      state,
      source: "markdown",
      sourceCurrent: "# Root\n\n来源备注\n",
      targetCurrent: serializeOpml(deleted),
      convert: () => serializeOpml(sourceMap),
      validateTarget: parseOpml,
      mergeStructured: mergeOpmlProjection,
    });
    expect(safe.kind).toBe("synced");
    if (safe.kind !== "synced") throw new Error("expected synced");
    expect(parseOpml(safe.content).root.children).toHaveLength(0);

    const edited = structuredClone(baseMap);
    edited.root.children[0].body = "导图备注";
    const sourceDeleted = structuredClone(baseMap);
    sourceDeleted.root.children = [];
    const conflict = incrementalDualSync({
      state,
      source: "markdown",
      sourceCurrent: "# Root\n\n来源删除节点\n",
      targetCurrent: serializeOpml(edited),
      convert: () => serializeOpml(sourceDeleted),
      validateTarget: parseOpml,
      mergeStructured: mergeOpmlProjection,
    });
    expect(conflict.kind).toBe("conflict");
  });
});
