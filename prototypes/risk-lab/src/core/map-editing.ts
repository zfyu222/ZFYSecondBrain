import { flatten, type Mindmap, type Topic } from "./formats";

export type TreeMove = "up" | "down" | "indent" | "outdent";
export function treeMoveOptions(map: Mindmap, selected: string) {
  const rows = flatten(map),
    row = rows.find((r) => r.path === selected);
  const parent = rows.find((r) => r.path === row?.parent);
  const index = row && parent ? parent.node.children.indexOf(row.node) : -1;
  return {
    up: index > 0,
    down: index >= 0 && index < parent!.node.children.length - 1,
    indent: index > 0,
    outdent: !!parent?.parent,
  };
}
/** Mutates only the cloned tree supplied by editMap, retaining topic identity. */
export function moveTreeNode(map: Mindmap, selected: string, move: TreeMove) {
  if (!treeMoveOptions(map, selected)[move]) return false;
  const rows = flatten(map),
    row = rows.find((r) => r.path === selected)!;
  const parent = rows.find((r) => r.path === row.parent)!;
  const siblings = parent.node.children,
    index = siblings.indexOf(row.node);
  if (move === "up" || move === "down") {
    const other = index + (move === "up" ? -1 : 1);
    [siblings[index], siblings[other]] = [siblings[other], siblings[index]];
  } else if (move === "indent") {
    const previous = siblings[index - 1];
    siblings.splice(index, 1);
    previous.children.push(row.node);
  } else {
    const grandparent = rows.find((r) => r.path === parent.parent)!.node;
    siblings.splice(index, 1);
    grandparent.children.splice(
      grandparent.children.indexOf(parent.node) + 1,
      0,
      row.node,
    );
  }
  return true;
}
export function remapPresentation(
  map: Mindmap,
  selected: Topic | undefined,
  collapsed: Topic[],
) {
  const rows = flatten(map);
  const selectedPath =
    rows.find((r) => r.node === selected)?.path ?? rows[0].path;
  const paths = collapsed.flatMap((node) => {
    const row = rows.find((r) => r.node === node);
    // The selected node must not disappear under a collapsed ancestor after moving.
    return row && !selectedPath.startsWith(row.path + "/") ? [row.path] : [];
  });
  return { selected: selectedPath, collapsed: paths };
}

export type MapSnapshot = {
  opml: string;
  relationsText?: string;
  selected: string;
  collapsed: string[];
};
const sameContent = (a: MapSnapshot, b: MapSnapshot) =>
  a.opml === b.opml && a.relationsText === b.relationsText;
export class MapHistory {
  private back: MapSnapshot[] = [];
  private forward: MapSnapshot[] = [];
  private expected?: MapSnapshot;
  private group?: string;
  private lastAt = 0;
  breakGroup() {
    this.group = undefined;
  }
  private clear() {
    this.back = [];
    this.forward = [];
    this.group = undefined;
  }
  record(
    before: MapSnapshot,
    after: MapSnapshot,
    group?: string,
    at = Date.now(),
  ) {
    if (this.expected && !sameContent(this.expected, before)) this.clear();
    if (sameContent(before, after)) return;
    if (
      !group ||
      this.group !== group ||
      at - this.lastAt > 750 ||
      this.forward.length
    ) {
      this.back.push(structuredClone(before));
      if (this.back.length > 100) this.back.shift();
    }
    this.forward = [];
    this.expected = structuredClone(after);
    this.group = group;
    this.lastAt = at;
  }
  travel(current: MapSnapshot, backwards: boolean): MapSnapshot | undefined {
    if (!this.expected || !sameContent(this.expected, current)) {
      this.clear();
      this.expected = undefined;
      return;
    }
    const source = backwards ? this.back : this.forward,
      target = backwards ? this.forward : this.back;
    const snapshot = source.pop();
    if (!snapshot) return;
    target.push(structuredClone(current));
    this.group = undefined;
    this.expected = structuredClone(snapshot);
    return structuredClone(snapshot);
  }
}

export function mapShortcut(
  event: {
    key: string;
    ctrlKey: boolean;
    metaKey: boolean;
    altKey: boolean;
    shiftKey: boolean;
    isComposing: boolean;
  },
  canvas: boolean,
): TreeMove | "undo" | "redo" | undefined {
  if (event.isComposing) return;
  const key = event.key.toLowerCase();
  if ((event.ctrlKey || event.metaKey) && !event.altKey) {
    if (key === "z") return event.shiftKey ? "redo" : "undo";
    if (key === "y") return "redo";
  }
  if (
    canvas &&
    event.altKey &&
    !event.ctrlKey &&
    !event.metaKey &&
    !event.shiftKey
  ) {
    const directions: Record<string, TreeMove | undefined> = {
      arrowup: "up",
      arrowdown: "down",
      arrowright: "indent",
      arrowleft: "outdent",
    };
    return directions[key];
  }
}
