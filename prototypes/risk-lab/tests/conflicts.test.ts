import { describe, expect, it } from "vitest";
import {
  conflictOptions,
  mergeFiles,
  resolveMerge,
  type Choices,
} from "../src/core/merge";
import {
  serializeOpml,
  serializeRelations,
  topic,
  type Relation,
} from "../src/core/formats";
import { validateFiles } from "../src/core/contracts";

const md = "raw/Inbox/conflict.md",
  opml = "raw/Inbox/map.opml",
  yaml = "raw/Inbox/map.relations.yaml";
const graph = (title = "A", body = "") =>
  serializeOpml({
    title: "Map",
    root: {
      ...topic("Root"),
      children: [{ ...topic(title), body }, topic("B")],
    },
  });
const edge = (from = "A", type = "相关"): Relation => ({
  from: `/Root[1]/${from}[1]`,
  to: "/Root[1]/B[1]",
  type,
  status: "confirmed",
});
const relations = (...edges: Relation[]) => serializeRelations(opml, edges);
const choicesFor = (
  result: ReturnType<typeof mergeFiles>,
  side: "local" | "remote",
): Choices =>
  Object.fromEntries(
    result.conflicts.flatMap((c) =>
      conflictOptions(c).map((o) => [o.key, side]),
    ),
  );

describe("Markdown conflict fragments", () => {
  const base = { [md]: "top\n\ngap1\n\nmiddle\n\ngap2\n\nbottom\n" };
  const local = {
    [md]: base[md]
      .replace("top", "LOCAL top")
      .replace("middle", "LOCAL middle"),
  };
  const remote = {
    [md]: base[md]
      .replace("middle", "REMOTE middle")
      .replace("bottom", "REMOTE bottom"),
  };
  it.each(["local", "remote"] as const)(
    "keeps both independent edits when choosing %s",
    (side) => {
      const result = mergeFiles(base, local, remote);
      expect(result.conflicts[0].kind).toBe("text");
      expect(conflictOptions(result.conflicts[0])).toHaveLength(1);
      const resolved = resolveMerge(result, choicesFor(result, side));
      expect(resolved[md]).toBe(
        local[md]
          .replace(
            "LOCAL middle",
            side === "local" ? "LOCAL middle" : "REMOTE middle",
          )
          .replace("bottom", "REMOTE bottom"),
      );
    },
  );
  it("allows separate choices for multiple conflicts within one document", () => {
    const b = "a\n\nstable1\n\nb\n\nstable2\n\nc";
    const result = mergeFiles(
      { [md]: b },
      { [md]: b.replace(/^a/, "A-local").replace(/c$/, "C-local") },
      { [md]: b.replace(/^a/, "A-remote").replace(/c$/, "C-remote") },
    );
    const options = conflictOptions(result.conflicts[0]);
    expect(options).toHaveLength(2);
    expect(
      resolveMerge(result, {
        [options[0].key]: "local",
        [options[1].key]: "remote",
      })[md],
    ).toBe(b.replace(/^a/, "A-local").replace(/c$/, "C-remote"));
  });
  it("refuses incomplete and invalid choices without mutating the plan", () => {
    const result = mergeFiles(base, local, remote),
      before = structuredClone(result);
    expect(() => resolveMerge(result, {})).toThrow("每个冲突项");
    const key = conflictOptions(result.conflicts[0])[0].key;
    expect(() =>
      resolveMerge(result, { [key]: "invalid" } as unknown as Choices),
    ).toThrow();
    expect(result).toEqual(before);
  });
  it("preserves CRLF, emoji, absent final newline and empty fragment choices", () => {
    const b = "before\r\n\r\n中😀\r\n\r\nafter";
    const result = mergeFiles(
      { [md]: b },
      { [md]: b.replace("中😀\r\n", "") },
      { [md]: b.replace("中😀", "改😀").replace("after", "after remote") },
    );
    expect(resolveMerge(result, choicesFor(result, "local"))[md]).toBe(
      b.replace("中😀\r\n", "").replace("after", "after remote"),
    );
  });
  it("keeps conservative whole-file choices for delete/edit and same-name creation", () => {
    const deleted = mergeFiles(
      { [md]: "base" },
      {},
      { [md]: "edit", "raw/Areas/other.md": "new" },
    );
    expect(deleted.conflicts[0].kind).toBe("file");
    expect(resolveMerge(deleted, { [md]: "local" })).toEqual({
      "raw/Areas/other.md": "new",
    });
    const created = mergeFiles({}, { [md]: "one" }, { [md]: "two" });
    expect(created.conflicts[0].kind).toBe("file");
    expect(resolveMerge(created, { [md]: "remote" })[md]).toBe("two");
  });
});

describe("OPML and relations consistency groups", () => {
  const base = { [opml]: graph(), [yaml]: relations(edge()) };
  it("groups renamed nodes against a relation edit instead of creating dangling endpoints", () => {
    const local = {
      [opml]: graph("Renamed"),
      [yaml]: relations(edge("Renamed")),
      [md]: "local note",
    };
    const remote = {
      ...base,
      [yaml]: relations(edge("A", "支持")),
      "raw/Areas/other.md": "remote note",
    };
    const result = mergeFiles(base, local, remote);
    expect(result.conflicts).toHaveLength(1);
    const c = result.conflicts[0];
    expect(c.kind).toBe("graph");
    expect(conflictOptions(c)).toHaveLength(1);
    expect(() => resolveMerge(result, { [yaml]: "remote" })).toThrow();
    for (const side of ["local", "remote"] as const) {
      const resolved = resolveMerge(result, { [opml]: side });
      expect(resolved[opml]).toBe(
        side === "local" ? local[opml] : remote[opml],
      );
      expect(resolved[yaml]).toBe(
        side === "local" ? local[yaml] : remote[yaml],
      );
      expect(resolved[md]).toBe("local note");
      expect(resolved["raw/Areas/other.md"]).toBe("remote note");
      expect(() => validateFiles(resolved)).not.toThrow();
    }
  });
  it("automatically combines a body-only edit and a compatible relation-only edit", () => {
    const local = { ...base, [opml]: graph("A", "new body") },
      remote = { ...base, [yaml]: relations(edge("A", "支持")) };
    const result = mergeFiles(base, local, remote);
    expect(result.conflicts).toEqual([]);
    expect(result.files).toEqual({ [opml]: local[opml], [yaml]: remote[yaml] });
  });
  it("groups component changes even without any single-file textual conflict", () => {
    const initial = { [opml]: graph() };
    const result = mergeFiles(
      initial,
      { [opml]: graph("Renamed") },
      { ...initial, [yaml]: relations(edge()) },
    );
    expect(result.conflicts[0].kind).toBe("graph");
    expect(resolveMerge(result, { [opml]: "local" })).toEqual({
      [opml]: graph("Renamed"),
    });
  });
  it("handles group deletion versus relationship edit without resurrecting half a group", () => {
    const result = mergeFiles(
      base,
      {},
      { ...base, [yaml]: relations(edge("A", "支持")) },
    );
    expect(result.conflicts).toHaveLength(1);
    expect(resolveMerge(result, { [opml]: "local" })).toEqual({});
    expect(resolveMerge(result, { [opml]: "remote" })[opml]).toBe(base[opml]);
  });
  it("chooses a complete graph for identical new tree but divergent new relations", () => {
    const result = mergeFiles({}, base, {
      ...base,
      [yaml]: relations(edge("A", "支持")),
    });
    expect(result.conflicts).toHaveLength(1);
    expect(resolveMerge(result, { [opml]: "local" })).toEqual(base);
  });
  it("rejects a malformed chosen branch without modifying the merge result", () => {
    const result = mergeFiles(
      base,
      { ...base, [yaml]: relations(edge("Missing")) },
      { ...base, [yaml]: relations(edge("A", "支持")) },
    );
    const before = structuredClone(result);
    expect(() => resolveMerge(result, { [opml]: "local" })).toThrow("不存在");
    expect(result).toEqual(before);
    expect(() => resolveMerge(result, { [opml]: "remote" })).not.toThrow();
  });
  it("keeps separate maps independently selectable", () => {
    const q = "raw/Areas/other.opml";
    const result = mergeFiles(
      { ...base, [q]: graph() },
      { ...base, [opml]: graph("A", "L"), [q]: graph("A", "L") },
      { ...base, [opml]: graph("A", "R"), [q]: graph("A", "R") },
    );
    expect(result.conflicts).toHaveLength(2);
    const resolved = resolveMerge(result, { [opml]: "local", [q]: "remote" });
    expect(resolved[opml]).toBe(graph("A", "L"));
    expect(resolved[q]).toBe(graph("A", "R"));
  });
});
