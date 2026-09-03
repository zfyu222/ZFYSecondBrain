import React, { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { conflictOptions } from "./core/merge";
import CodeMirror from "@uiw/react-codemirror";
import { markdown } from "@codemirror/lang-markdown";
import { MarkdownPreview } from "./MarkdownPreview";
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
  LocalVault,
  moveDocument,
  resolveConflicts,
  synchronize,
  hasUnsyncedChanges,
  type LocalState,
} from "./local";
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
import "./style.css";

const db = new LocalVault();
function download(name: string, text: string) {
  const url = URL.createObjectURL(
    new Blob([text], { type: "text/plain;charset=utf-8" }),
  );
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function MapEditor({
  opml,
  relationsText,
  stem,
  onChange,
}: {
  opml: string;
  relationsText: string;
  stem: string;
  onChange: (changes: Record<string, string>) => void;
}) {
  const parsed = useMemo(() => {
    try {
      const map = parseOpml(opml);
      return { map, relations: parseRelations(relationsText, map), error: "" };
    } catch (e) {
      return { map: null, relations: [], error: String(e) };
    }
  }, [opml, relationsText]);
  const [selected, setSelected] = useState("");
  const [linkType, setLinkType] = useState("相关");
  const [linkTarget, setLinkTarget] = useState("");
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const undo = useRef<{ opml: string; relationsText: string }[]>([]),
    redo = useRef<typeof undo.current>([]);
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
  function save(map: Mindmap, relations: Relation[]) {
    undo.current.push({ opml, relationsText });
    redo.current = [];
    const changes = { [`${stem}.opml`]: serializeOpml(map) };
    if (relationsText || relations.length)
      changes[`${stem}.relations.yaml`] = serializeRelations(
        `${stem}.opml`,
        relations,
      );
    onChange(changes);
  }
  function change(action: (map: Mindmap, node: typeof current) => void) {
    let selectedNode: typeof current.node | undefined;
    const result = editMap(parsed.map!, parsed.relations, (next) => {
      const row = flatten(next).find((r) => r.path === current.path)!;
      selectedNode = row.node;
      action(next, row);
    });
    setSelected(
      flatten(result.map).find((r) => r.node === selectedNode)?.path ?? "",
    );
    setLinkTarget("");
    save(result.map, result.relations);
  }
  function travel(back: boolean) {
    const source = back ? undo : redo,
      target = back ? redo : undo;
    const entry = source.current.pop();
    if (!entry) return;
    target.current.push({ opml, relationsText });
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
      siblings.splice(siblings.indexOf(row.node) + 1, 0, topic("新想法"));
    });
  }
  return (
    <div
      className="map-editor"
      onKeyDown={(e) => {
        if ((e.target as HTMLElement).matches("input,textarea,select")) return;
        if ((e.ctrlKey || e.metaKey) && (e.key === "z" || e.key === "y")) {
          e.preventDefault();
          travel(e.key === "z");
        }
      }}
    >
      <div className="map-tools">
        <button
          onClick={() =>
            change((_map, row) => row.node.children.push(topic("新想法")))
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
      </div>
      <div className="map-canvas" aria-label="思维导图画布">
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodesDraggable={false}
          nodesConnectable={false}
          onNodeClick={(_event, node) => setSelected(node.id)}
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
            onChange={(e) => {
              if (e.target.value.trim())
                change((_map, row) => {
                  row.node.text = e.target.value;
                });
            }}
          />
        </label>
        <label>
          节点正文
          <textarea
            aria-label="节点正文"
            value={current.node.body}
            onChange={(e) =>
              change((_map, row) => {
                row.node.body = e.target.value;
              })
            }
            placeholder="补充想法，支持 Markdown 文本"
          />
        </label>
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
function App() {
  const [row, setRow] = useState<LocalState | null>(null),
    rowRef = useRef<LocalState | null>(null);
  const [files, setFiles] = useState<Record<string, string>>({}),
    filesRef = useRef(files);
  const [active, setActive] = useState("raw/Inbox/开始使用"),
    [view, setView] = useState<"markdown" | "map">("markdown");
  const [message, setMessage] = useState("正在打开本机数据…"),
    [error, setError] = useState("");
  const [busy, setBusy] = useState(false),
    [offline, setOffline] = useState(false),
    [query, setQuery] = useState("");
  const [destination, setDestination] = useState("raw/Areas/开始使用.md");
  const [jump, setJump] = useState<{ path: string; heading: string } | null>(
    null,
  );
  function openLinkedNote(path: string, heading?: string) {
    setActive(path.replace(/\.(md|opml)$/, ""));
    setView(path.endsWith(".opml") ? "map" : "markdown");
    setJump(heading === undefined ? null : { path, heading });
  }
  useEffect(() => {
    if (!jump || view !== "markdown" || active + ".md" !== jump.path) return;
    const frame = requestAnimationFrame(() =>
      document
        .getElementById("user-content-" + jump.heading)
        ?.scrollIntoView({ block: "start" }),
    );
    return () => cancelAnimationFrame(frame);
  }, [jump, active, view]);
  const [choices, setChoices] = useState<Record<string, "local" | "remote">>(
    {},
  );
  const writeQueue = useRef(Promise.resolve());
  const saveFailure = useRef(false);
  const operationBusy = useRef(false);
  function accept(next: LocalState) {
    rowRef.current = next;
    setRow(next);
    filesRef.current = next.files;
    setFiles(next.files);
  }
  async function reload() {
    if (saveFailure.current)
      download(
        "重新载入前草稿.json",
        JSON.stringify(filesRef.current, null, 2),
      );
    accept(await db.read());
    saveFailure.current = false;
    setError("");
    setMessage("已载入本机数据");
  }
  useEffect(() => {
    void reload().catch((e) => setError(String(e)));
  }, []);
  useEffect(() => {
    const onOnline = () => {
      if (!offline) void sync();
    };
    window.addEventListener("online", onOnline);
    return () => window.removeEventListener("online", onOnline);
  }, [offline]);
  useEffect(() => {
    if (import.meta.env.PROD && "serviceWorker" in navigator)
      void navigator.serviceWorker
        .register("/sw.js")
        .catch((e) => setError("离线界面缓存失败：" + e));
  }, []);
  function update(changes: Record<string, string>) {
    const nextFiles = { ...filesRef.current, ...changes };
    filesRef.current = nextFiles;
    setFiles(nextFiles);
    setMessage("正在保存本机…");
    writeQueue.current = writeQueue.current
      .then(async () => {
        if (!rowRef.current) return;
        const saved = await db.update(rowRef.current.version, (r) => ({
          ...r,
          files: nextFiles,
        }));
        rowRef.current = saved;
        setRow(saved);
        setMessage("已保存本机 · 待同步");
      })
      .catch((e) => {
        saveFailure.current = true;
        setError(String(e));
        setMessage("本机保存失败 · 请导出草稿");
      });
  }
  async function sync() {
    if (offline) {
      setMessage("模拟断网中，修改仅保存本机");
      return;
    }
    if (operationBusy.current) return;
    operationBusy.current = true;
    setBusy(true);
    setError("");
    try {
      await writeQueue.current;
      if (saveFailure.current) throw new Error("请先处理本机保存错误");
      const next = await synchronize(db);
      accept(next);
      setMessage(
        next.conflict
          ? "检测到冲突 · 请保留一版"
          : hasUnsyncedChanges(next)
            ? "已收到服务端确认 · 本机仍有修改待同步"
            : "已同步本地测试服务",
      );
    } catch (e) {
      setError(String(e));
      setMessage("同步失败 · 本机数据保留");
      if (!saveFailure.current) accept(await db.read());
    } finally {
      operationBusy.current = false;
      setBusy(false);
    }
  }
  async function confirmConflicts() {
    if (operationBusy.current || !rowRef.current?.conflict) return;
    operationBusy.current = true;
    setBusy(true);
    setError("");
    try {
      const next = await resolveConflicts(db, rowRef.current, choices);
      accept(next);
      setMessage("选择已保存，请再次同步");
    } catch (e) {
      setError(String(e));
    } finally {
      operationBusy.current = false;
      setBusy(false);
    }
  }
  async function move() {
    if (operationBusy.current) return;
    operationBusy.current = true;
    setBusy(true);
    setError("");
    try {
      await writeQueue.current;
      if (saveFailure.current)
        throw new Error("请先导出未保存草稿，再重新载入");
      accept(await moveDocument(db, active + ".md", destination));
      setActive(destination.slice(0, -3));
      setMessage("已移动并更新受支持的 Markdown 引用");
    } catch (e) {
      setError(String(e));
      if (!saveFailure.current) accept(await db.read());
    } finally {
      operationBusy.current = false;
      setBusy(false);
    }
  }
  function newNote(kind: "markdown" | "map") {
    if (rowRef.current?.conflict || rowRef.current?.pendingMove) return;
    const stem = `raw/Inbox/随手记-${new Date()
      .toISOString()
      .replace(/[-:TZ.]/g, "")
      .slice(0, 17)}`;
    setActive(stem);
    setView(kind);
    update(
      kind === "markdown"
        ? { [`${stem}.md`]: "# 随手记\n\n" }
        : {
            [`${stem}.opml`]: serializeOpml({
              title: "随手记",
              root: topic("随手记"),
            }),
          },
    );
  }
  const notes = [
    ...new Set(
      Object.keys(files)
        .filter((p) => /\.(md|opml)$/.test(p))
        .map((p) => p.replace(/\.(md|opml)$/, "")),
    ),
  ];
  const title = active.split("/").pop();
  const hasMd = `${active}.md` in files,
    hasMap = `${active}.opml` in files;
  const editingLocked = busy || !!row?.conflict || !!row?.pendingMove;
  useEffect(() => {
    setChoices({});
  }, [row?.conflict]);
  useEffect(() => {
    if (!hasMd && !hasMap && notes.length) {
      setActive(notes[0]);
      setView(files[notes[0] + ".md"] !== undefined ? "markdown" : "map");
    }
  }, [files, active]);
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark">知</span>
          <div>
            第二大脑<small>本地技术实验室</small>
          </div>
        </div>
        <div className="new-buttons">
          <button disabled={editingLocked} onClick={() => newNote("markdown")}>
            ＋ 笔记
          </button>
          <button disabled={editingLocked} onClick={() => newNote("map")}>
            ＋ 导图
          </button>
        </div>
        <input
          className="search"
          aria-label="搜索本机笔记"
          placeholder="搜索本机笔记…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <div className="section-label">
          本机文档 <span>{notes.length}</span>
        </div>
        <nav>
          {notes
            .filter((n) => (n + (files[n + ".md"] ?? "")).includes(query))
            .map((n) => (
              <button
                className={n === active ? "note active" : "note"}
                key={n}
                disabled={busy}
                onClick={() => {
                  setActive(n);
                  setView(files[n + ".md"] !== undefined ? "markdown" : "map");
                }}
              >
                <span>{n.split("/").pop()}</span>
                <small>{n.split("/").slice(1, -1).join(" / ")}</small>
              </button>
            ))}
        </nav>
        <div className="sidebar-footer">
          <span className="dot" /> 原始文件，不锁在应用里
          <p>Markdown · OPML · YAML</p>
          <small>仅测试数据 · 暂未接入 AI</small>
        </div>
      </aside>
      <main>
        <header>
          <div>
            <div className="breadcrumb">
              {active.split("/").slice(0, -1).join(" / ")}
            </div>
            <h1>{title}</h1>
          </div>
          <div className="status-actions">
            <label className="offline-toggle">
              <input
                type="checkbox"
                checked={offline}
                onChange={(e) => setOffline(e.target.checked)}
              />
              模拟断网
            </label>
            <button
              className="primary"
              disabled={busy || offline || !row || !!row.conflict}
              onClick={() => void sync()}
            >
              {busy ? "处理中…" : "同步测试服务"}
            </button>
          </div>
        </header>
        <div className="status" role="status">
          <span className="dot" />
          {message}
          <span className="status-hint">
            UI 在本机浏览器运行 · API 仅 localhost
          </span>
        </div>
        {error && (
          <div className="notice error" role="alert">
            {error}
            <button disabled={busy} onClick={() => void reload()}>
              重新载入已保存数据
            </button>
          </div>
        )}
        <div className="tabs">
          <button
            className={view === "markdown" ? "selected" : ""}
            disabled={!hasMd}
            onClick={() => setView("markdown")}
          >
            Markdown
          </button>
          <button
            className={view === "map" ? "selected" : ""}
            disabled={!hasMap}
            onClick={() => setView("map")}
          >
            思维导图
          </button>
          <span>独立编辑与保存 · AI 双视图同步尚未实现</span>
        </div>
        {row?.pendingMove && (
          <div className="notice">
            移动结果待确认，编辑暂时锁定；请点击同步重试。原始请求已保存在本机。
          </div>
        )}
        <fieldset disabled={editingLocked} className="editing-area">
          {view === "markdown" && hasMd && (
            <div className="markdown-grid">
              <section>
                <div className="pane-label">原文 / SOURCE</div>
                <CodeMirror
                  aria-label="Markdown 编辑器"
                  editable={!editingLocked}
                  readOnly={editingLocked}
                  value={files[active + ".md"]}
                  height="420px"
                  extensions={[markdown()]}
                  onChange={(value) => update({ [active + ".md"]: value })}
                  basicSetup={{ lineNumbers: true, foldGutter: false }}
                />
              </section>
              <section className="preview">
                <div className="pane-label">阅读 / PREVIEW · OFM 子集</div>
                <MarkdownPreview
                  source={files[active + ".md"]}
                  owner={active + ".md"}
                  files={files}
                  onOpen={openLinkedNote}
                />
              </section>
            </div>
          )}
          {view === "map" && hasMap && (
            <MapEditor
              key={active}
              opml={files[active + ".opml"]}
              relationsText={files[active + ".relations.yaml"] ?? ""}
              stem={active}
              onChange={update}
            />
          )}
        </fieldset>
        {row?.conflict && (
          <section className="conflicts">
            <h2>保留哪一版？</h2>
            <p>
              Markdown
              只选择冲突片段，其余修改自动保留。导图与关系文件整组选择，不能混选。确认前自动保存双方恢复副本。
            </p>
            <button
              onClick={() =>
                download(
                  "冲突双方.json",
                  JSON.stringify(
                    { local: row.files, conflict: row.conflict },
                    null,
                    2,
                  ),
                )
              }
            >
              导出冲突双方
            </button>
            {row.conflict.items.map((c) => (
              <div className="conflict-item" key={c.path}>
                <h3>{c.path}</h3>
                {conflictOptions(c).map((option) => (
                  <div key={option.key}>
                    <h4>{option.label}</h4>
                    <div className="conflict-grid">
                      {(["local", "remote"] as const).map((side) => (
                        <label key={side}>
                          <input
                            type="radio"
                            disabled={busy}
                            name={option.key}
                            aria-label={`${side === "local" ? "保留本机" : "保留服务端"}：${c.path} · ${option.label}`}
                            checked={choices[option.key] === side}
                            onChange={() =>
                              setChoices({ ...choices, [option.key]: side })
                            }
                          />
                          {side === "local" ? "保留本机" : "保留服务端"}
                          <pre>
                            {option[side] === null
                              ? "（文件已删除）"
                              : option[side] || "（空片段）"}
                          </pre>
                        </label>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            ))}
            <button
              className="primary"
              disabled={busy}
              onClick={() => void confirmConflicts()}
            >
              保存选择
            </button>
          </section>
        )}
        <footer className="lab-tools">
          <details>
            <summary>验证工具与原始文件</summary>
            <p>
              当前原型只验证文本文件；不是正式 NAS
              服务。模拟断网仅暂停同步，真正断网刷新请使用构建后的预览。
            </p>
            <div className="tool-row">
              {[".md", ".opml", ".relations.yaml"]
                .filter((ext) => active + ext in files)
                .map((ext) => (
                  <button
                    key={ext}
                    onClick={() => download(title + ext, files[active + ext])}
                  >
                    下载 {ext}
                  </button>
                ))}
              <button
                onClick={() =>
                  download(
                    "原型全部草稿.json",
                    JSON.stringify(filesRef.current, null, 2),
                  )
                }
              >
                应急导出全部草稿
              </button>
              <button
                onClick={() =>
                  void db.recovery
                    .toArray()
                    .then((entries) =>
                      download(
                        "冲突恢复副本.json",
                        JSON.stringify(entries, null, 2),
                      ),
                    )
                }
              >
                导出冲突恢复副本
              </button>
              <button
                onClick={() =>
                  void navigator.storage
                    ?.persist()
                    .then((granted) =>
                      setMessage(
                        granted
                          ? "浏览器已授予持久存储"
                          : "浏览器未授予持久存储，建议及时同步或导出",
                      ),
                    )
                }
              >
                申请持久存储
              </button>
            </div>
            <div className="tool-row">
              <input
                aria-label="移动目标路径"
                value={destination}
                onChange={(e) => setDestination(e.target.value)}
              />
              <button
                disabled={offline || editingLocked || !hasMd}
                onClick={() => void move()}
              >
                移动当前笔记
              </button>
            </div>
            <p>
              已支持部分 Markdown 引用重写；结构化引用、复杂 OFM
              语法仍有待验证。根目录移动和同名覆盖均被拒绝。
            </p>
          </details>
        </footer>
      </main>
    </div>
  );
}
createRoot(document.getElementById("root")!).render(<App />);
