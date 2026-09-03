import { describe, expect, it } from "vitest";
import {
  editMap,
  flatten,
  parseOpml,
  parseRelations,
  serializeOpml,
  serializeRelations,
  topic,
  type Relation,
} from "../src/core/formats";
import {
  MapHistory,
  mapShortcut,
  moveTreeNode,
  remapPresentation,
  treeMoveOptions,
  type MapSnapshot,
} from "../src/core/map-editing";

function fixture() {
  const map = {
    title: "结构",
    root: {
      ...topic("根"),
      children: [
        {
          ...topic("同名"),
          body: "第一份",
          attrs: { custom: "keep", url: "./引用.md" },
          children: [topic("细节")],
        },
        { ...topic("同名"), body: "第二份" },
        topic("第三个"),
      ],
    },
  };
  const rows = flatten(map);
  const relations: Relation[] = [
    { from: rows[1].path, to: rows[3].path, type: "相关", status: "confirmed" },
    { from: rows[2].path, to: rows[4].path, type: "例子", status: "confirmed" },
  ];
  return { map, relations };
}
describe("mindmap structural editing", () => {
  it("reorders duplicate siblings and keeps relations attached to the original topics", () => {
    const { map, relations } = fixture(),
      original = structuredClone(map);
    const edited = editMap(map, relations, (copy) => {
      expect(moveTreeNode(copy, "/根[1]/同名[2]", "up")).toBe(true);
    });
    expect(edited.map.root.children.map((n) => n.body)).toEqual([
      "第二份",
      "第一份",
      "",
    ]);
    expect(edited.relations[0]).toMatchObject({
      from: "/根[1]/同名[2]",
      to: "/根[1]/同名[1]",
    });
    expect(edited.relations[1].from).toBe("/根[1]/同名[2]/细节[1]");
    expect(edited.map.root.children[1].attrs).toEqual(
      original.root.children[0].attrs,
    );
    expect(map).toEqual(original);
    expect(
      parseRelations(
        serializeRelations("a.opml", edited.relations),
        parseOpml(serializeOpml(edited.map)),
      ),
    ).toEqual(edited.relations);
  });
  it("indents under the previous sibling then outdents to the original order", () => {
    const { map, relations } = fixture();
    const nested = editMap(map, relations, (copy) => {
      moveTreeNode(copy, "/根[1]/同名[2]", "indent");
    });
    expect(nested.relations[0].to).toBe("/根[1]/同名[1]/同名[1]");
    const restored = editMap(nested.map, nested.relations, (copy) => {
      moveTreeNode(copy, "/根[1]/同名[1]/同名[1]", "outdent");
    });
    expect(restored).toEqual({ map, relations });
  });
  it("moves the whole subtree down, preserving child order and all attributes", () => {
    const { map, relations } = fixture();
    const edited = editMap(map, relations, (copy) => {
      moveTreeNode(copy, "/根[1]/同名[1]", "down");
    });
    expect(edited.map.root.children[1]).toEqual(map.root.children[0]);
    expect(edited.relations[1].from).toBe("/根[1]/同名[2]/细节[1]");
  });
  it("refuses impossible root, first, last and top-level moves without mutation", () => {
    const { map } = fixture(),
      before = structuredClone(map);
    expect(treeMoveOptions(map, "/根[1]")).toEqual({
      up: false,
      down: false,
      indent: false,
      outdent: false,
    });
    expect(moveTreeNode(map, "/根[1]/同名[1]", "up")).toBe(false);
    expect(moveTreeNode(map, "/根[1]/同名[1]", "indent")).toBe(false);
    expect(moveTreeNode(map, "/根[1]/第三个[1]", "down")).toBe(false);
    expect(moveTreeNode(map, "/根[1]/第三个[1]", "outdent")).toBe(false);
    expect(moveTreeNode(map, "/missing", "up")).toBe(false);
    expect(map).toEqual(before);
  });
  it("remaps collapsed branches by identity and reveals the selected node after indent", () => {
    const { map } = fixture();
    const selected = map.root.children[1],
      folded = map.root.children[0];
    moveTreeNode(map, "/根[1]/同名[2]", "indent");
    expect(remapPresentation(map, selected, [folded])).toEqual({
      selected: "/根[1]/同名[1]/同名[1]",
      collapsed: [],
    });
    expect(remapPresentation(map, folded, [folded])).toEqual({
      selected: "/根[1]/同名[1]",
      collapsed: ["/根[1]/同名[1]"],
    });
  });
  it("preserves semantic edges and unknown attributes while changing a node type", () => {
    const { map, relations } = fixture();
    const edited = editMap(map, relations, (copy) => {
      copy.root.children[0].type = "example";
    });
    expect(parseOpml(serializeOpml(edited.map)).root.children[0].type).toBe(
      "example",
    );
    expect(edited.relations).toEqual(relations);
    expect(edited.map.root.children[0].attrs).toEqual(
      map.root.children[0].attrs,
    );
  });
});

const snapshot = (opml: string, relationsText?: string): MapSnapshot => ({
  opml,
  relationsText,
  selected: "/根[1]",
  collapsed: [],
});
describe("local grouped mindmap undo", () => {
  it("groups continuous typing, separates a pause and preserves redo", () => {
    const history = new MapHistory(),
      a = snapshot("a"),
      b = snapshot("ab"),
      c = snapshot("abc"),
      d = snapshot("abcd");
    history.record(a, b, "body", 0);
    history.record(b, c, "body", 200);
    history.record(c, d, "body", 1200);
    expect(history.travel(d, true)).toEqual(c);
    expect(history.travel(c, true)).toEqual(a);
    expect(history.travel(a, false)).toEqual(c);
    expect(history.travel(c, false)).toEqual(d);
  });
  it("keeps structural edits and new focus sessions separate from typing", () => {
    const history = new MapHistory(),
      a = snapshot("a"),
      b = snapshot("b"),
      c = snapshot("c"),
      d = snapshot("d");
    history.record(a, b, "title", 0);
    history.breakGroup();
    history.record(b, c, "title", 1);
    history.record(c, d, undefined, 2);
    expect(history.travel(d, true)).toEqual(c);
    expect(history.travel(c, true)).toEqual(b);
    expect(history.travel(b, true)).toEqual(a);
  });
  it("restores OPML, semantic edges, selection and the absence of a relation file together", () => {
    const history = new MapHistory(),
      a = snapshot("before"),
      b = {
        ...snapshot("after", "relations"),
        selected: "/根[1]/子[1]",
        collapsed: ["/根[1]/其他[1]"],
      };
    history.record(a, b);
    expect(history.travel(b, true)).toEqual(a);
    expect(history.travel(a, false)).toEqual(b);
    expect(a.relationsText).toBeUndefined();
  });
  it("does not undo changes loaded from a server or another tab", () => {
    const history = new MapHistory(),
      a = snapshot("a"),
      b = snapshot("b"),
      remote = snapshot("remote");
    history.record(a, b);
    expect(history.travel(remote, true)).toBeUndefined();
    history.record(remote, snapshot("new"));
    expect(history.travel(snapshot("new"), true)).toEqual(remote);
    expect(history.travel(remote, true)).toBeUndefined();
  });
  it("clears old history if the next edit follows an external replacement", () => {
    const history = new MapHistory();
    history.record(snapshot("a"), snapshot("b"));
    history.record(snapshot("remote"), snapshot("edited-remote"));
    expect(history.travel(snapshot("edited-remote"), true)).toEqual(
      snapshot("remote"),
    );
    expect(history.travel(snapshot("remote"), true)).toBeUndefined();
  });
  it("ignores no-op edits, discards redo after a new edit and bounds memory", () => {
    const history = new MapHistory();
    history.record(snapshot("a"), snapshot("a"));
    expect(history.travel(snapshot("a"), true)).toBeUndefined();
    history.record(snapshot("a"), snapshot("b"));
    history.travel(snapshot("b"), true);
    history.record(snapshot("a"), snapshot("c"));
    expect(history.travel(snapshot("c"), false)).toBeUndefined();
    const bounded = new MapHistory();
    for (let i = 0; i < 105; i++)
      bounded.record(snapshot(String(i)), snapshot(String(i + 1)));
    let current = snapshot("105"),
      count = 0,
      prior: MapSnapshot | undefined;
    while ((prior = bounded.travel(current, true))) {
      count++;
      current = prior;
    }
    expect(count).toBe(100);
  });
});

describe("canvas keyboard policy", () => {
  const key = {
    key: "",
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    shiftKey: false,
    isComposing: false,
  };
  it("supports Ctrl/Cmd undo, uppercase Shift+Z redo, and Ctrl+Y", () => {
    expect(mapShortcut({ ...key, key: "z", ctrlKey: true }, false)).toBe(
      "undo",
    );
    expect(
      mapShortcut({ ...key, key: "Z", metaKey: true, shiftKey: true }, false),
    ).toBe("redo");
    expect(mapShortcut({ ...key, key: "y", ctrlKey: true }, false)).toBe(
      "redo",
    );
  });
  it("only applies structural shortcuts to the focused canvas, never IME composition", () => {
    expect(mapShortcut({ ...key, key: "ArrowRight", altKey: true }, true)).toBe(
      "indent",
    );
    expect(mapShortcut({ ...key, key: "ArrowLeft", altKey: true }, true)).toBe(
      "outdent",
    );
    expect(mapShortcut({ ...key, key: "ArrowUp", altKey: true }, true)).toBe(
      "up",
    );
    expect(mapShortcut({ ...key, key: "ArrowDown", altKey: true }, true)).toBe(
      "down",
    );
    expect(
      mapShortcut({ ...key, key: "ArrowRight", altKey: true }, false),
    ).toBeUndefined();
    expect(
      mapShortcut({ ...key, key: "z", ctrlKey: true, isComposing: true }, true),
    ).toBeUndefined();
    expect(mapShortcut({ ...key, key: "Tab" }, true)).toBeUndefined();
  });
});
