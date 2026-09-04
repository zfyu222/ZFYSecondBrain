import React, { useMemo, useRef, useState } from "react";
import {
  ReactFlow,
  Background,
  Controls,
  Position,
  MarkerType,
  type Edge,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import {
  editMap,
  flatten,
  parseOpml,
  parseRelations,
  relationTypes,
  serializeOpml,
  serializeRelations,
  topic,
  type Mindmap,
  type Relation,
} from "./core/formats";
import {
  MapHistory,
  mapShortcut,
  moveTreeNode,
  remapPresentation,
  treeMoveOptions,
  type MapSnapshot,
  type TreeMove,
} from "./core/map-editing";

export default function MapEditor({
  opml,
  relationsText,
  stem,
  onChange,
  onOpenReference,
}: {
  opml: string;
  relationsText?: string;
  stem: string;
  onChange: (changes: Record<string, string | undefined>) => void;
  onOpenReference?: (target: string) => void;
}) {
  const parsed = useMemo(() => {
    try {
      const map = parseOpml(opml);
      return {
        map,
        relations: parseRelations(relationsText ?? "", map),
        error: "",
      };
    } catch (e) {
      return { map: null, relations: [] as Relation[], error: String(e) };
    }
  }, [opml, relationsText]);
  const [selected, setSelected] = useState("");
  const [linkType, setLinkType] = useState("相关");
  const [linkTarget, setLinkTarget] = useState("");
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [mapError, setMapError] = useState("");
  const history = useRef(new MapHistory());
  const canvas = useRef<HTMLDivElement>(null);
  const rows = parsed.map ? flatten(parsed.map) : [];
  const current = rows.find((r) => r.path === selected) ?? rows[0];
  const visible = rows.filter(
    (row) => ![...collapsed].some((p) => row.path.startsWith(p + "/")),
  );
  const nodes = visible.map((r, index) => ({
    id: r.path,
    position: { x: r.depth * 245, y: index * 90 },
    data: { label: r.node.text + (collapsed.has(r.path) ? " ＋" : "") },
    selected: current?.path === r.path,
    sourcePosition: Position.Right,
    targetPosition: Position.Left,
    style: {
      borderRadius: 12,
      border:
        current?.path === r.path ? "2px solid #296a5b" : "1px solid #d5ddd5",
      background: r.depth === 0 ? "#e6eee5" : "#fff",
      width: 190,
      padding: "16px 12px",
      color: "#243c32",
    },
  }));
  const edges: Edge[] = visible
    .filter((r) => r.parent)
    .map((r) => ({
      id: "tree:" + r.path,
      source: r.parent!,
      target: r.path,
      style: { stroke: "#abbcad" },
    }));
  for (const [index, relation] of parsed.relations.entries())
    if (
      visible.some((r) => r.path === relation.from) &&
      visible.some((r) => r.path === relation.to)
    )
      edges.push({
        id: "relation:" + index,
        source: relation.from,
        target: relation.to,
        label: relation.type,
        markerEnd:
          relationTypes.indexOf(relation.type) < 11
            ? { type: MarkerType.ArrowClosed }
            : undefined,
        style: {
          stroke: "#b6813f",
          strokeDasharray: relation.status === "unresolved" ? "5 4" : undefined,
        },
      });
  if (!parsed.map)
    return (
      <div className="notice error">
        {parsed.error}
        <p>原始数据未修改。请导出后检查。</p>
      </div>
    );
  function state(): MapSnapshot {
    return {
      opml,
      relationsText,
      selected: current.path,
      collapsed: [...collapsed],
    };
  }
  function save(
    map: Mindmap,
    relations: Relation[],
    presentation = { selected: current.path, collapsed: [...collapsed] },
    group?: string,
    relationOrigins?: number[],
  ) {
    try {
      const nextOpml = serializeOpml(map);
      const nextRelations =
        relationsText !== undefined || relations.length
          ? serializeRelations(
              `${stem}.opml`,
              relations,
              relationsText === undefined
                ? undefined
                : {
                    text: relationsText,
                    indices:
                      relationOrigins ??
                      relations.map((relation) => {
                        const index = parsed.relations.indexOf(relation);
                        return index < 0 ? null : index;
                      }),
                  },
            )
          : undefined;
      const checked = parseOpml(nextOpml);
      parseRelations(nextRelations ?? "", checked);
      history.current.record(
        state(),
        { opml: nextOpml, relationsText: nextRelations, ...presentation },
        group,
      );
      setSelected(presentation.selected);
      setCollapsed(new Set(presentation.collapsed));
      setMapError("");
      onChange({
        [`${stem}.opml`]: nextOpml,
        [`${stem}.relations.yaml`]: nextRelations,
      });
    } catch (error) {
      setMapError("操作未保存，原文保留：" + String(error));
    }
  }
  function change(
    action: (map: Mindmap, node: typeof current) => typeof current.node | void,
    group?: string,
  ) {
    let selectedNode: typeof current.node | undefined;
    let foldedNodes: (typeof current.node)[] = [];
    const result = editMap(parsed.map!, parsed.relations, (next) => {
      const nextRows = flatten(next);
      const row = nextRows.find((r) => r.path === current.path)!;
      foldedNodes = nextRows
        .filter((r) => collapsed.has(r.path))
        .map((r) => r.node);
      selectedNode = action(next, row) ?? row.node;
    });
    setLinkTarget("");
    save(
      result.map,
      result.relations,
      remapPresentation(result.map, selectedNode, foldedNodes),
      group,
      result.relationOrigins,
    );
  }
  function travel(back: boolean) {
    const entry = history.current.travel(state(), back);
    if (!entry) return;
    setSelected(entry.selected);
    setCollapsed(new Set(entry.collapsed));
    setLinkTarget("");
    setMapError("");
    onChange({
      [`${stem}.opml`]: entry.opml,
      [`${stem}.relations.yaml`]: entry.relationsText,
    });
  }
  function addSibling() {
    if (!current.parent) return;
    change((map, row) => {
      const siblings = flatten(map).find((r) => r.path === row.parent)!.node
        .children;
      const added = topic("新想法");
      siblings.splice(siblings.indexOf(row.node) + 1, 0, added);
      return added;
    });
  }
  const moveOptions = treeMoveOptions(parsed.map, current.path);
  function moveNode(direction: TreeMove) {
    if (moveOptions[direction])
      change((map, row) => {
        moveTreeNode(map, row.path, direction);
      });
  }
  return (
    <div
      className="map-editor"
      onKeyDown={(e) => {
        if (
          (e.target as HTMLElement).closest(
            "input,textarea,select,[contenteditable=true]",
          )
        )
          return;
        const action = mapShortcut(
          {
            key: e.key,
            ctrlKey: e.ctrlKey,
            metaKey: e.metaKey,
            altKey: e.altKey,
            shiftKey: e.shiftKey,
            isComposing: e.nativeEvent.isComposing,
          },
          e.target === canvas.current,
        );
        if (action) {
          e.preventDefault();
          e.stopPropagation();
          if (action === "undo" || action === "redo") travel(action === "undo");
          else moveNode(action);
        }
      }}
    >
      <div className="map-tools">
        <button
          onClick={() =>
            change((_map, row) => {
              const added = topic("新想法");
              row.node.children.push(added);
              return added;
            })
          }
        >
          ＋ 子节点
        </button>
        <button disabled={!current.parent} onClick={addSibling}>
          ＋ 兄弟节点
        </button>
        <button
          disabled={!current.parent}
          onClick={() =>
            change((map, row) => {
              const parent = flatten(map).find(
                (r) => r.path === row.parent,
              )!.node;
              parent.children = parent.children.filter((n) => n !== row.node);
              return parent;
            })
          }
        >
          删除节点
        </button>
        <button
          onClick={() =>
            setCollapsed((set) => {
              const next = new Set(set);
              next.has(current.path)
                ? next.delete(current.path)
                : next.add(current.path);
              return next;
            })
          }
        >
          折叠 / 展开
        </button>
        <button onClick={() => travel(true)}>撤销</button>
        <button onClick={() => travel(false)}>重做</button>
        <button disabled={!moveOptions.up} onClick={() => moveNode("up")}>
          上移
        </button>
        <button disabled={!moveOptions.down} onClick={() => moveNode("down")}>
          下移
        </button>
        <button
          disabled={!moveOptions.indent}
          onClick={() => moveNode("indent")}
        >
          缩进一级
        </button>
        <button
          disabled={!moveOptions.outdent}
          onClick={() => moveNode("outdent")}
        >
          提升一级
        </button>
      </div>
      {mapError && (
        <div className="notice error" role="alert">
          {mapError}
        </div>
      )}
      <p className="map-hint">
        选中：{current.node.text} · 画布聚焦时 Alt + ↑↓ 排序、←→ 改层级；Ctrl+Z
        / Ctrl+Y 撤销重做。
      </p>
      <div
        ref={canvas}
        tabIndex={0}
        className="map-canvas"
        aria-label="思维导图画布"
      >
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodesDraggable={false}
          nodesConnectable={false}
          onNodeClick={(_event, node) => {
            history.current.breakGroup();
            setSelected(node.id);
            canvas.current?.focus();
          }}
          fitView
          minZoom={0.2}
          deleteKeyCode={null}
        >
          <Background gap={22} color="#d9e1d7" />
          <Controls />
        </ReactFlow>
      </div>
      <div className="node-details">
        <label>
          节点标题
          <input
            aria-label="节点标题"
            value={current.node.text}
            onFocus={() => history.current.breakGroup()}
            onBlur={() => history.current.breakGroup()}
            onChange={(e) => {
              if (e.target.value.trim())
                change((_map, row) => {
                  row.node.text = e.target.value;
                }, "title");
            }}
          />
        </label>
        <label>
          节点正文
          <textarea
            aria-label="节点正文"
            value={current.node.body}
            onFocus={() => history.current.breakGroup()}
            onBlur={() => history.current.breakGroup()}
            onChange={(e) =>
              change((_map, row) => {
                row.node.body = e.target.value;
              }, "body")
            }
            placeholder="补充想法，支持 Markdown 文本"
          />
        </label>
        <label>
          节点类型
          <select
            aria-label="节点类型"
            value={current.node.type}
            onChange={(e) =>
              change((_map, row) => {
                row.node.type = e.target.value;
              })
            }
          >
            {!["topic", "heading", "claim", "example", "question", "reference"].includes(
              current.node.type,
            ) && (
              <option value={current.node.type}>
                {current.node.type}（已有类型）
              </option>
            )}
            <option value="topic">主题</option>
            <option value="heading">标题</option>
            <option value="claim">观点</option>
            <option value="example">例子</option>
            <option value="question">问题</option>
            <option value="reference">引用</option>
          </select>
        </label>
        <label>
          引用路径
          <input
            aria-label="引用路径"
            value={current.node.attrs.url ?? ""}
            onChange={(e) =>
              change((_map, row) => {
                const target = e.target.value.trim();
                if (target) row.node.attrs.url = target;
                else delete row.node.attrs.url;
              })
            }
            placeholder="raw/Areas/健康/睡眠#睡眠与食欲"
          />
        </label>
        <button
          disabled={!current.node.attrs.url || !onOpenReference}
          onClick={() => onOpenReference?.(current.node.attrs.url)}
        >
          打开引用
        </button>
        <div className="relation-controls">
          <select
            aria-label="语义关系类型"
            value={linkType}
            onChange={(e) => setLinkType(e.target.value)}
          >
            {relationTypes.map((t) => (
              <option key={t}>{t}</option>
            ))}
          </select>
          <select
            aria-label="关系目标"
            value={linkTarget}
            onChange={(e) => setLinkTarget(e.target.value)}
          >
            <option value="">选择目标节点</option>
            {rows
              .filter((r) => r.path !== current.path)
              .map((r) => (
                <option key={r.path} value={r.path}>
                  {r.node.text} · {r.path}
                </option>
              ))}
          </select>
          <button
            disabled={!linkTarget || linkTarget === current.path}
            onClick={() =>
              save(parsed.map!, [
                ...parsed.relations,
                {
                  from: current.path,
                  to: linkTarget,
                  type: linkType,
                  status: linkType === "未明确" ? "unresolved" : "confirmed",
                },
              ])
            }
          >
            添加关系
          </button>
        </div>
        {parsed.relations.map((r, index) => (
          <div className="relation-row" key={index}>
            <span>
              {r.from.split("/").pop()} → {r.type} → {r.to.split("/").pop()}
            </span>
            <button
              aria-label={`删除关系 ${index + 1}`}
              onClick={() =>
                save(
                  parsed.map!,
                  parsed.relations.filter((_r, i) => i !== index),
                )
              }
            >
              移除
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
