import React, { lazy, Suspense, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { conflictOptions } from "./core/merge";
import {
  attachmentChoiceKey,
  attachmentSize,
  attachmentLimits,
  mediaTypes,
} from "./core/attachments";
import { downloadAttachment } from "./attachment-files";
import { EditorBoundary } from "./EditorBoundary";
import { observeOfflineStatus, offlineStatusText } from "./offline-status";
import {
  LocalVault,
  moveDocument,
  resolveConflicts,
  synchronize,
  hasUnsyncedChanges,
  type LocalState,
  addAttachment,
  recentDocuments,
  rememberRecent,
  saveFilesWithHistory,
  documentHistory,
  restoreHistoryPoint,
  type HistoryPoint,
  moveToTrash,
  restoreTrashEntry,
  type TrashEntry,
  restoreEmergencyExport,
} from "./local";
import { parseOpml, serializeOpml, setMapTitle, topic } from "./core/formats";
import { documentTitle } from "./core/document-title";
import { mapFromMarkdown } from "./core/map-from-markdown";
import { markdownFromMap } from "./core/markdown-from-map";
import { dualViewChanges, readDualView, recordDualView } from "./core/dual-view";
import {
  isFavorite,
  noteTags,
  setFavorite,
  setNoteTags,
  setSoftLinks,
  softLinks,
  noteTitle,
  setNoteTitle,
} from "./core/note-metadata";
import { matchesNoteSearch } from "./core/search";
import { isTemplateStem, templateName } from "./core/templates";
import { appearsInFolder, folderTree, type FolderNode } from "./core/folders";
import "./style.css";

const MapEditor = lazy(() => import("./MapEditor"));
const MarkdownEditor = lazy(() => import("./MarkdownEditor"));
const MarkdownPreview = lazy(() =>
  import("./MarkdownPreview").then((module) => ({
    default: module.MarkdownPreview,
  })),
);

const db = new LocalVault();
const spaces = [
  ["all", "全部"],
  ["Inbox", "收件箱"],
  ["Projects", "项目"],
  ["Areas", "领域"],
  ["Archive", "归档"],
] as const;
type Space = (typeof spaces)[number][0];
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
function FolderTree({
  nodes,
  current,
  onPick,
}: {
  nodes: FolderNode[];
  current: string;
  onPick: (path: string) => void;
}) {
  return nodes.map((node) => (
    <details key={node.path} open={current.startsWith(node.path + "/")}>
      <summary>
        <button
          className={current === node.path ? "selected" : ""}
          onClick={(event) => {
            event.preventDefault();
            onPick(node.path);
          }}
        >
          {node.name}
        </button>
      </summary>
      {node.children.length > 0 && (
        <div className="folder-children">
          <FolderTree nodes={node.children} current={current} onPick={onPick} />
        </div>
      )}
    </details>
  ));
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
  const [lastCheckedAt, setLastCheckedAt] = useState<Date | null>(null);
  const [offlineNotice, setOfflineNotice] = useState("");
  const [busy, setBusy] = useState(false),
    [offline, setOffline] = useState(false),
    [query, setQuery] = useState("");
  const [includeArchive, setIncludeArchive] = useState(false);
  const [space, setSpace] = useState<Space>("all");
  const [folderPrefix, setFolderPrefix] = useState("");
  const [selectedTemplate, setSelectedTemplate] = useState("");
  const [tagDraft, setTagDraft] = useState("");
  const [softLinkDraft, setSoftLinkDraft] = useState("");
  const [historyPoints, setHistoryPoints] = useState<HistoryPoint[]>([]);
  const [backlinks, setBacklinks] = useState<{ source: string; heading?: string }[]>([]);
  const [trashEntries, setTrashEntries] = useState<TrashEntry[]>([]);
  const [destination, setDestination] = useState("raw/Areas/开始使用.md");
  const [folderDestination, setFolderDestination] = useState("");
  const [jump, setJump] = useState<{ path: string; heading: string } | null>(
    null,
  );
  function openLinkedNote(path: string, heading?: string) {
    openNote(
      path.replace(/\.(md|opml)$/, ""),
      path.endsWith(".opml") ? "map" : "markdown",
    );
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
  const emergencyImport = useRef<HTMLInputElement>(null);
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
    rememberOpened(active);
    saveFailure.current = false;
    setError("");
    if (!offline && navigator.onLine) {
      setMessage("已载入本机数据 · 正在自动同步…");
      void sync();
    } else {
      setMessage("已载入本机数据 · 等待网络同步");
    }
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
    if (offline) return;
    const timer = window.setInterval(() => void sync(), 30_000);
    return () => window.clearInterval(timer);
  }, [offline]);
  useEffect(() => {
    if (!import.meta.env.PROD || !("serviceWorker" in navigator)) return;
    let cancelled = false;
    let cleanup: (() => void) | undefined;
    void navigator.serviceWorker
      .register("/sw.js", { updateViaCache: "none" })
      .then((registration) => {
        if (!cancelled)
          cleanup = observeOfflineStatus(registration, (status) =>
            setOfflineNotice(offlineStatusText[status]),
          );
      })
      .catch(() => {
        if (!cancelled) setOfflineNotice(offlineStatusText.failed);
      });
    return () => {
      cancelled = true;
      cleanup?.();
    };
  }, []);
  function update(changes: Record<string, string | undefined>) {
    const nextFiles = { ...filesRef.current };
    for (const [path, value] of Object.entries(changes)) {
      if (value === undefined) delete nextFiles[path];
      else nextFiles[path] = value;
    }
    filesRef.current = nextFiles;
    setFiles(nextFiles);
    setMessage("正在保存本机…");
    writeQueue.current = writeQueue.current
      .then(async () => {
        if (!rowRef.current) return;
        const saved = await saveFilesWithHistory(
          db,
          rowRef.current.version,
          nextFiles,
        );
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
      const before = rowRef.current;
      const hadLocalChanges = before ? hasUnsyncedChanges(before) : false;
      const next = await synchronize(db);
      accept(next);
      setLastCheckedAt(new Date());
      setMessage(
        next.conflict
          ? "检测到冲突 · 请保留一版"
          : !hadLocalChanges &&
              before?.base?.revision !== next.base?.revision
            ? "已载入外部文件修改"
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
  async function restoreHistory(id: string) {
    if (operationBusy.current || !rowRef.current) return;
    operationBusy.current = true;
    setBusy(true);
    try {
      await writeQueue.current;
      accept(await restoreHistoryPoint(db, rowRef.current.version, id));
      setMessage("已恢复历史版本；恢复前内容已保留为恢复副本");
    } catch (error) {
      setError(String(error));
    } finally {
      operationBusy.current = false;
      setBusy(false);
    }
  }
  async function trashCurrent() {
    if (operationBusy.current || !rowRef.current || (!hasMd && !hasMap)) return;
    operationBusy.current = true;
    setBusy(true);
    setError("");
    try {
      await writeQueue.current;
      if (saveFailure.current) throw new Error("请先处理本机保存错误");
      const next = await moveToTrash(db, rowRef.current.version, active);
      accept(next);
      const remaining = [...new Set(
        Object.keys(next.files)
          .filter((path) => /\.(md|opml)$/.test(path))
          .map((path) => path.replace(/\.(md|opml)$/, "")),
      )];
      if (remaining.length) {
        setActive(remaining[0]);
        setView(next.files[remaining[0] + ".md"] ? "markdown" : "map");
      }
      setMessage("已移入回收站；原始文件和附件均可恢复");
    } catch (error) {
      setError(String(error));
    } finally {
      operationBusy.current = false;
      setBusy(false);
    }
  }
  async function restoreTrash(id: string) {
    if (operationBusy.current || !rowRef.current) return;
    const entry = trashEntries.find((item) => item.id === id);
    if (!entry) return;
    operationBusy.current = true;
    setBusy(true);
    setError("");
    try {
      await writeQueue.current;
      const next = await restoreTrashEntry(db, rowRef.current.version, id);
      accept(next);
      setActive(entry.stem);
      setView(entry.files[entry.stem + ".md"] ? "markdown" : "map");
      setMessage("已从回收站恢复；现有文件没有被覆盖");
    } catch (error) {
      setError(String(error));
    } finally {
      operationBusy.current = false;
      setBusy(false);
    }
  }
  async function move(target = destination) {
    if (operationBusy.current) return;
    operationBusy.current = true;
    setBusy(true);
    setError("");
    try {
      await writeQueue.current;
      if (saveFailure.current)
        throw new Error("请先导出未保存草稿，再重新载入");
      accept(await moveDocument(db, active + ".md", target));
      setActive(target.slice(0, -3));
      setMessage("已移动并更新受支持的 Markdown 引用");
    } catch (e) {
      setError(String(e));
      if (!saveFailure.current) accept(await db.read());
    } finally {
      operationBusy.current = false;
      setBusy(false);
    }
  }
  async function moveSelectedFolder() {
    const source = folderPrefix,
      target = folderDestination.trim();
    if (operationBusy.current || source.split("/").length < 3 || !target)
      return;
    operationBusy.current = true;
    setBusy(true);
    setError("");
    try {
      await writeQueue.current;
      if (saveFailure.current)
        throw new Error("请先导出未保存草稿，再重新载入");
      accept(await moveDocument(db, source, target));
      if (active === source || active.startsWith(source + "/"))
        setActive(target + active.slice(source.length));
      setFolderPrefix(target);
      setFolderDestination("");
      setMessage("目录已移动并更新受支持的 Markdown 引用");
    } catch (e) {
      setError(String(e));
      if (!saveFailure.current) accept(await db.read());
    } finally {
      operationBusy.current = false;
      setBusy(false);
    }
  }
  function archiveCurrent() {
    const name = active.split("/").pop();
    if (!name) return;
    void move(`raw/Archive/${name}.md`);
  }
  async function importMedia(file: File) {
    if (operationBusy.current || !rowRef.current) return;
    operationBusy.current = true;
    setBusy(true);
    setError("");
    const owner = active + ".md";
    try {
      if (file.size > attachmentLimits.single)
        throw new Error("原型单附件限制 1 MB，请使用小型测试文件");
      await writeQueue.current;
      if (saveFailure.current) throw new Error("请先处理本机保存错误");
      const bytes = new Uint8Array(await file.arrayBuffer());
      accept(
        await addAttachment(
          db,
          rowRef.current!.version,
          owner,
          file.name,
          bytes,
        ),
      );
      setMessage("附件和引用已保存本机 · 待同步");
    } catch (e) {
      setError(String(e));
    } finally {
      operationBusy.current = false;
      setBusy(false);
    }
  }
  async function importEmergencyExport(file: File) {
    if (operationBusy.current || !rowRef.current) return;
    operationBusy.current = true;
    setBusy(true);
    setError("");
    try {
      // The validated payload is smaller; bound the raw upload before decoding it.
      if (file.size > 12_000_000)
        throw new Error("应急草稿超过 12 MB 原型导入限制");
      await writeQueue.current;
      if (saveFailure.current) throw new Error("请先处理本机保存错误");
      const exported = JSON.parse(await file.text()) as unknown;
      accept(
        await restoreEmergencyExport(db, rowRef.current.version, exported),
      );
      setMessage("已恢复到本机；旧同步请求未恢复，请检查后再同步");
    } catch (e) {
      setError(String(e));
    } finally {
      operationBusy.current = false;
      setBusy(false);
      if (emergencyImport.current) emergencyImport.current.value = "";
    }
  }
  function newNote(kind: "markdown" | "map") {
    if (rowRef.current?.conflict || rowRef.current?.pendingMove) return;
    // Inbox remains the default, but a selected ordinary folder is an explicit
    // navigation context for deliberate organization. Archive is never a creation target.
    const parent =
      folderPrefix.startsWith("raw/") && !folderPrefix.startsWith("raw/Archive")
        ? folderPrefix
        : "raw/Inbox";
    const stem = `${parent}/随手记-${new Date()
      .toISOString()
      .replace(/[-:TZ.]/g, "")
      .slice(0, 17)}`;
    setActive(stem);
    setView(kind);
    update(
      kind === "markdown"
        ? {
            [`${stem}.md`]:
              selectedTemplate && filesRef.current[selectedTemplate + ".md"]
                ? filesRef.current[selectedTemplate + ".md"]
                : "# 随手记\n\n",
          }
        : {
            [`${stem}.opml`]: serializeOpml({
              title: "随手记",
              root: topic("随手记"),
            }),
          },
    );
    rememberOpened(stem);
  }
  function newTemplate() {
    if (rowRef.current?.conflict || rowRef.current?.pendingMove) return;
    const stem = `raw/Areas/_templates/模板-${new Date()
      .toISOString()
      .replace(/[-:TZ.]/g, "")
      .slice(0, 17)}`;
    setActive(stem);
    setView("markdown");
    update({ [`${stem}.md`]: "# 新模板\n\n在这里写下新笔记的起点。\n" });
    rememberOpened(stem);
  }
  function rememberOpened(path: string) {
    writeQueue.current = writeQueue.current
      .then(async () => {
        if (!rowRef.current) return;
        accept(await rememberRecent(db, rowRef.current.version, path));
      })
      .catch((error) => setError(String(error)));
  }
  function openNote(path: string, nextView: "markdown" | "map") {
    setActive(path);
    setView(nextView);
    rememberOpened(path);
  }
  function toggleFavorite() {
    const path = active + ".md";
    try {
      update({
        [path]: setFavorite(
          filesRef.current[path],
          !isFavorite(filesRef.current[path]),
        ),
      });
    } catch (error) {
      setError(String(error));
    }
  }
  function changeTags(nextTags: string[]) {
    const path = active + ".md";
    try {
      update({ [path]: setNoteTags(filesRef.current[path], nextTags) });
    } catch (error) {
      setError(String(error));
    }
  }
  function addTag() {
    const tag = tagDraft.trim().replace(/^#/, "");
    if (!tag) return;
    try {
      changeTags([...noteTags(filesRef.current[active + ".md"]), tag]);
      setTagDraft("");
    } catch (error) {
      setError(String(error));
    }
  }
  function changeTitle(value: string) {
    try {
      update({ [active + ".md"]: setNoteTitle(filesRef.current[active + ".md"], value) });
    } catch (error) {
      setError(String(error));
    }
  }
  function changeMapTitle(value: string) {
    try {
      update({
        [active + ".opml"]: setMapTitle(filesRef.current[active + ".opml"], value),
      });
    } catch (error) {
      setError(String(error));
    }
  }
  function enableMapView() {
    if (!hasMd || hasMap || editingLocked) return;
    let mapTitle = active.split("/").pop() ?? "未命名";
    try {
      mapTitle = noteTitle(filesRef.current[active + ".md"]) ?? mapTitle;
    } catch {
      // A malformed optional title must not prevent the user from keeping a map.
    }
    update({
      [`${active}.opml`]: serializeOpml(
        mapFromMarkdown(mapTitle, filesRef.current[active + ".md"]),
      ),
    });
    setView("map");
  }
  function enableMarkdownView() {
    if (!hasMap || hasMd || editingLocked) return;
    try {
      update({
        [`${active}.md`]: markdownFromMap(
          parseOpml(filesRef.current[active + ".opml"]),
        ),
      });
      setView("markdown");
    } catch (error) {
      setError(String(error));
    }
  }
  function recordDualBaseline() {
    if (!hasMd || !hasMap || editingLocked) return;
    update({
      [active + ".note.yaml"]: recordDualView(
        filesRef.current[active + ".md"],
        filesRef.current[active + ".opml"],
        new Date().toISOString(),
      ),
    });
  }
  function changeSoftLinks(nextLinks: string[]) {
    const path = active + ".md";
    try {
      update({ [path]: setSoftLinks(filesRef.current[path], nextLinks) });
    } catch (error) {
      setError(String(error));
    }
  }
  function addSoftLink() {
    const link = softLinkDraft.trim();
    if (!link) return;
    try {
      changeSoftLinks([...softLinks(filesRef.current[active + ".md"]), link]);
      setSoftLinkDraft("");
    } catch (error) {
      setError(String(error));
    }
  }
  const allMarkdownStems = Object.keys(files)
    .filter((path) => path.endsWith(".md"))
    .map((path) => path.slice(0, -3));
  const templateStems = allMarkdownStems.filter(isTemplateStem);
  const notes = [
    ...new Set(
      Object.keys(files)
        .filter((p) => /\.(md|opml)$/.test(p))
        .map((p) => p.replace(/\.(md|opml)$/, "")),
    ),
  ].filter((stem) => !isTemplateStem(stem));
  const fileTitle = active.split("/").pop() ?? "未命名";
  const hasMd = `${active}.md` in files,
    hasMap = `${active}.opml` in files;
  let dualStatus = "";
  if (hasMd && hasMap) {
    try {
      const changes = dualViewChanges(
        readDualView(files[active + ".note.yaml"] ?? ""),
        files[active + ".md"],
        files[active + ".opml"],
      );
      dualStatus = !changes.known ? "双视图尚未建立共同版本" : !changes.markdown && !changes.opml ? "双视图已记录为一致" : `待同步：${changes.markdown ? "Markdown" : ""}${changes.markdown && changes.opml ? "、" : ""}${changes.opml ? "导图" : ""}`;
    } catch { dualStatus = "双视图记录无效，原文未修改"; }
  }
  const favoriteNotes = notes.filter((path) => {
    try {
      return isFavorite(files[path + ".md"] ?? "");
    } catch {
      return false;
    }
  });
  const activeFavorite = hasMd && favoriteNotes.includes(active);
  let activeTags: string[] = [];
  let activeSoftLinks: string[] = [];
  if (hasMd) {
    try {
      activeTags = noteTags(files[active + ".md"]);
    } catch {
      // Keep the editor usable; save actions show the precise metadata error.
    }
  }
  let title = fileTitle;
  try {
    title = documentTitle(files, active);
  } catch {
    // Keep source editable if user-provided metadata or map is malformed.
  }
  if (hasMd) {
    try {
      activeSoftLinks = softLinks(files[active + ".md"]);
    } catch {
      // Keep editing available; the explicit update reports malformed metadata.
    }
  }
  const recentNotes = row
    ? recentDocuments(row).filter((path) => notes.includes(path))
    : [];
  const displayTitle = (stem: string) => {
    try {
      return documentTitle(files, stem);
    } catch {
      return stem.split("/").pop() ?? "未命名";
    }
  };
  const editingLocked = busy || !!row?.conflict || !!row?.pendingMove;
  const matchesSearch = (stem: string) =>
    matchesNoteSearch(
      stem,
      files[stem + ".md"] ?? "",
      query,
      includeArchive,
    );
  const matchesCurrentFolder = (stem: string) =>
    appearsInFolder(stem, files[stem + ".md"], folderPrefix);
  const matchesSpace = (stem: string) =>
    space === "all" ||
    stem.startsWith(`raw/${space}/`) ||
    (!!folderPrefix && matchesCurrentFolder(stem));
  const matchesFolder = (stem: string) =>
    matchesCurrentFolder(stem);
  const visibleNotes = notes
    .filter(matchesSpace)
    .filter(matchesFolder)
    .filter(matchesSearch);
  const virtualFolders = notes.flatMap((stem) => {
    try {
      return softLinks(files[stem + ".md"] ?? "");
    } catch {
      // Invalid front matter is surfaced by the explicit metadata controls.
      return [];
    }
  });
  const folders = folderTree(notes, virtualFolders);
  useEffect(() => {
    setChoices({});
  }, [row?.conflict]);
  useEffect(() => {
    if (!hasMd && !hasMap && notes.length) {
      setActive(notes[0]);
      setView(files[notes[0] + ".md"] !== undefined ? "markdown" : "map");
    }
  }, [files, active]);
  useEffect(() => {
    if (!hasMd) return setHistoryPoints([]);
    void documentHistory(db, active + ".md")
      .then(setHistoryPoints)
      .catch((error) => setError(String(error)));
  }, [active, hasMd, row?.version]);
  useEffect(() => {
    let cancelled = false;
    void import("./core/preview")
      .then(({ backlinksFor }) => {
        if (!cancelled)
          setBacklinks(
            backlinksFor(active + (hasMd ? ".md" : ".opml"), files).filter(
              (item) => item.source !== active + ".md",
            ),
          );
      })
      .catch((error) => !cancelled && setError(String(error)));
    return () => {
      cancelled = true;
    };
  }, [active, hasMd, hasMap, row?.version]);
  useEffect(() => {
    void db.trash
      .orderBy("at")
      .reverse()
      .toArray()
      .then(setTrashEntries)
      .catch((error) => setError(String(error)));
  }, [row?.version]);
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
          <button disabled={editingLocked} onClick={newTemplate}>
            ＋ 模板
          </button>
        </div>
        <div className="template-picker">
          <select
            aria-label="新笔记模板"
            value={selectedTemplate}
            disabled={editingLocked}
            onChange={(event) => setSelectedTemplate(event.target.value)}
          >
            <option value="">空白笔记</option>
            {templateStems.map((stem) => (
              <option key={stem} value={stem}>
                模板：{templateName(stem)}
              </option>
            ))}
          </select>
          {selectedTemplate && (
            <button
              disabled={editingLocked}
              onClick={() => openNote(selectedTemplate, "markdown")}
            >
              编辑模板
            </button>
          )}
        </div>
        <input
          className="search"
          aria-label="搜索本机笔记"
          placeholder="搜索本机笔记…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        {query.trim() && (
          <label className="archive-search">
            <input
              type="checkbox"
              checked={includeArchive}
              onChange={(event) => setIncludeArchive(event.target.checked)}
            />
            包含归档
          </label>
        )}
        <div className="space-filters" aria-label="文件夹空间">
          {spaces.map(([key, label]) => (
            <button
              key={key}
              className={space === key ? "selected" : ""}
              onClick={() => {
                setSpace(key);
                setFolderPrefix(key === "all" ? "" : `raw/${key}`);
              }}
            >
              {label}
            </button>
          ))}
        </div>
        <details className="folder-tree">
          <summary>目录树{folderPrefix ? ` · ${folderPrefix.split("/").pop()}` : ""}</summary>
          {folderPrefix && (
            <button className="clear-folder" onClick={() => setFolderPrefix("")}>
              显示所有目录
            </button>
          )}
          <FolderTree
            nodes={folders[0]?.children ?? []}
            current={folderPrefix}
            onPick={(path) => setFolderPrefix(path)}
          />
        </details>
        <div className="section-label">
          本机文档 <span>{visibleNotes.length}</span>
        </div>
        <nav>
          {visibleNotes.map((n) => (
            <button
              className={n === active ? "note active" : "note"}
              key={n}
              disabled={busy}
              onClick={() => {
                openNote(
                  n,
                  files[n + ".md"] !== undefined ? "markdown" : "map",
                );
              }}
            >
              <span>{displayTitle(n)}</span>
              <small>{n.split("/").slice(1, -1).join(" / ")}</small>
            </button>
          ))}
        </nav>
        {recentNotes.length > 0 && (
          <>
            <div className="section-label">
              最近文档 <span>{recentNotes.length}</span>
            </div>
            <nav>
              {recentNotes.map((n) => (
                <button
                  className={n === active ? "note active" : "note"}
                  key={n}
                  disabled={busy}
                  onClick={() =>
                    openNote(
                      n,
                      files[n + ".md"] !== undefined ? "markdown" : "map",
                    )
                  }
                >
                  <span>{displayTitle(n)}</span>
                  <small>{n.split("/").slice(1, -1).join(" / ")}</small>
                </button>
              ))}
            </nav>
          </>
        )}
        {favoriteNotes.length > 0 && (
          <>
            <div className="section-label">
              最喜爱 <span>{favoriteNotes.length}</span>
            </div>
            <nav>
              {favoriteNotes.map((n) => (
                <button
                  className={n === active ? "note active" : "note"}
                  key={n}
                  disabled={busy}
                  onClick={() => {
                    openNote(n, "markdown");
                  }}
                >
                  <span>★ {displayTitle(n)}</span>
                  <small>{n.split("/").slice(1, -1).join(" / ")}</small>
                </button>
              ))}
            </nav>
          </>
        )}
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
            {hasMd || hasMap ? (
              <input
                className="note-title"
                aria-label="文档标题"
                value={title}
                disabled={editingLocked}
                onChange={(event) =>
                  hasMd
                    ? changeTitle(event.target.value)
                    : changeMapTitle(event.target.value)
                }
              />
            ) : (
              <h1>{title}</h1>
            )}
            {hasMd && activeTags.length > 0 && (
              <div className="note-tags" aria-label="当前标签">
                {activeTags.map((tag) => (
                  <button
                    key={tag}
                    disabled={editingLocked}
                    onClick={() =>
                      changeTags(activeTags.filter((item) => item !== tag))
                    }
                  >
                    #{tag} ×
                  </button>
                ))}
              </div>
            )}
            {hasMd && activeSoftLinks.length > 0 && (
              <div className="soft-links" aria-label="软链接入口">
                额外入口：
                {activeSoftLinks.map((link) => (
                  <span key={link} className="soft-link-chip">
                    <button
                      type="button"
                      className="note-link"
                      disabled={busy}
                      onClick={() => {
                        setSpace("all");
                        setFolderPrefix(link);
                      }}
                    >
                      {link}
                    </button>
                    <button
                      type="button"
                      aria-label={`移除软链接 ${link}`}
                      disabled={editingLocked}
                      onClick={() =>
                        changeSoftLinks(
                          activeSoftLinks.filter((item) => item !== link),
                        )
                      }
                    >
                      ×
                    </button>
                  </span>
                ))}
              </div>
            )}
            {backlinks.length > 0 && (
              <div className="backlinks" aria-label="反向链接">
                被引用于：
                {backlinks.map((item) => (
                  <button
                    key={item.source}
                    disabled={busy}
                    onClick={() => openNote(item.source.slice(0, -3), "markdown")}
                  >
                    {item.source.split("/").pop()}
                    {item.heading ? ` · ${item.heading}` : ""}
                  </button>
                ))}
              </div>
            )}
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
            <button disabled={editingLocked || !hasMd} onClick={toggleFavorite}>
              {activeFavorite ? "★ 已喜爱" : "☆ 喜爱"}
            </button>
            <button
              disabled={editingLocked || (!hasMd && !hasMap)}
              onClick={() => void trashCurrent()}
            >
              移入回收站
            </button>
            <button
              disabled={offline || editingLocked || !hasMd || active.startsWith("raw/Archive/")}
              onClick={archiveCurrent}
            >
              归档
            </button>
            {hasMd && (
              <div className="tag-entry">
                <input
                  aria-label="添加标签"
                  placeholder="添加标签"
                  value={tagDraft}
                  disabled={editingLocked}
                  onChange={(event) => setTagDraft(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      addTag();
                    }
                  }}
                />
                <button
                  disabled={editingLocked || !tagDraft.trim()}
                  onClick={addTag}
                >
                  标签
                </button>
              </div>
            )}
            {hasMd && (
              <div className="soft-link-entry">
                <input
                  aria-label="添加软链接入口"
                  placeholder="raw/Projects/项目"
                  value={softLinkDraft}
                  disabled={editingLocked}
                  onChange={(event) => setSoftLinkDraft(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      addSoftLink();
                    }
                  }}
                />
                <button
                  disabled={editingLocked || !softLinkDraft.trim()}
                  onClick={addSoftLink}
                >
                  软链接
                </button>
              </div>
            )}
            <button
              className="primary"
              disabled={busy || offline || !row || !!row.conflict}
              onClick={() => void sync()}
            >
              {busy ? "处理中…" : "同步并检查外部变更"}
            </button>
          </div>
        </header>
        <div className="status" role="status">
          <span className="dot" />
          {message}
          <span className="status-hint">
            {lastCheckedAt
              ? `上次检查 ${lastCheckedAt.toLocaleTimeString()} · 每 30 秒检查外部文件变更`
              : "每 30 秒检查外部文件变更"}
            <br />
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
        {offlineNotice && (
          <div className="notice" role="status">
            {offlineNotice}
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
          {hasMd && !hasMap && (
            <button disabled={editingLocked} onClick={enableMapView}>
              为本文启用导图
            </button>
          )}
          {hasMap && !hasMd && (
            <button disabled={editingLocked} onClick={enableMarkdownView}>
              为本文生成 Markdown
            </button>
          )}
          {hasMd && hasMap && (
            <button disabled={editingLocked} onClick={recordDualBaseline}>
              记录当前双视图基线
            </button>
          )}
          <span>独立编辑与保存 · AI 双视图同步尚未实现</span>
          {dualStatus && <span>{dualStatus}</span>}
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
                <label className="attachment-picker">
                  添加图片、音视频或 PDF（原型 ≤ 1 MB）
                  <input
                    type="file"
                    aria-label="添加本机附件"
                    accept={Object.keys(mediaTypes)
                      .map((ext) => "." + ext)
                      .join(",")}
                    onChange={(event) => {
                      const file = event.currentTarget.files?.[0];
                      event.currentTarget.value = "";
                      if (file) void importMedia(file);
                    }}
                  />
                </label>
                <EditorBoundary key={active}>
                  <Suspense
                    fallback={
                      <p className="notice">
                        正在加载 Markdown 编辑器，原文已保留…
                      </p>
                    }
                  >
                    <MarkdownEditor
                      locked={editingLocked}
                      value={files[active + ".md"]}
                      onChange={(value) => update({ [active + ".md"]: value })}
                    />
                  </Suspense>
                </EditorBoundary>
              </section>
              <section className="preview">
                <div className="pane-label">阅读 / PREVIEW · OFM 子集</div>
                <EditorBoundary key={active}>
                  <Suspense
                    fallback={<p className="notice">正在加载阅读视图…</p>}
                  >
                    <MarkdownPreview
                      source={files[active + ".md"]}
                      owner={active + ".md"}
                      files={files}
                      attachments={row?.attachments}
                      onOpen={openLinkedNote}
                    />
                  </Suspense>
                </EditorBoundary>
              </section>
            </div>
          )}
          {view === "map" && hasMap && (
            <EditorBoundary key={active}>
              <Suspense
                fallback={
                  <p className="notice">正在加载导图编辑器，原文已保留…</p>
                }
              >
                <MapEditor
                  key={active}
                  opml={files[active + ".opml"]}
                  relationsText={files[active + ".relations.yaml"]}
                  stem={active}
                  onChange={update}
                />
              </Suspense>
            </EditorBoundary>
          )}
        </fieldset>
        {row?.conflict && (
          <section className="conflicts">
            <h2>保留哪一版？</h2>
            <p>
              Markdown
              只选择冲突片段，其余修改自动保留。导图与关系文件整组选择；附件整文件二选一，不拼接二进制。确认前自动保存双方恢复副本。
            </p>
            <button
              onClick={() =>
                download(
                  "冲突双方.json",
                  JSON.stringify(
                    {
                      local: row.files,
                      attachments: row.attachments,
                      conflict: row.conflict,
                    },
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
            {(row.conflict.attachmentItems ?? []).map((item) => (
              <div
                className="conflict-item"
                key={attachmentChoiceKey(item.path)}
              >
                <h3>{item.path} · 附件冲突</h3>
                <div className="conflict-grid">
                  {(["local", "remote"] as const).map((side) => (
                    <label key={side}>
                      <input
                        type="radio"
                        disabled={busy}
                        name={attachmentChoiceKey(item.path)}
                        checked={
                          choices[attachmentChoiceKey(item.path)] === side
                        }
                        onChange={() =>
                          setChoices({
                            ...choices,
                            [attachmentChoiceKey(item.path)]: side,
                          })
                        }
                      />
                      {side === "local" ? "保留本机" : "保留服务端"}
                      <p>
                        {item[side]
                          ? `${attachmentSize(item[side]!)} 字节`
                          : "（附件已删除）"}
                      </p>
                      {item[side] && (
                        <button
                          type="button"
                          onClick={() =>
                            downloadAttachment(item.path, item[side]!)
                          }
                        >
                          下载此版本检查
                        </button>
                      )}
                    </label>
                  ))}
                </div>
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
              当前原型验证文本和受限二进制附件；不是正式 NAS
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
                    JSON.stringify(
                      {
                        protocolVersion: 2,
                        files: filesRef.current,
                        attachments: rowRef.current?.attachments ?? {},
                      },
                      null,
                      2,
                    ),
                  )
                }
              >
                应急导出全部草稿
              </button>
              <input
                ref={emergencyImport}
                className="visually-hidden"
                type="file"
                accept="application/json,.json"
                onChange={(event) => {
                  const file = event.currentTarget.files?.[0];
                  if (file) void importEmergencyExport(file);
                }}
              />
              <button
                disabled={busy}
                onClick={() => emergencyImport.current?.click()}
              >
                恢复应急草稿
              </button>
              {Object.entries(row?.attachments ?? {})
                .filter(([path]) => path.startsWith(active + ".assets/"))
                .map(([path, value]) => (
                  <button
                    key={path}
                    onClick={() => downloadAttachment(path, value)}
                  >
                    下载 {path.split("/").pop()}
                  </button>
                ))}
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
            {hasMd && historyPoints.length > 0 && (
              <div className="history-points">
                <p>本机历史恢复点（恢复前内容会保留）：</p>
                {historyPoints.map((point) => (
                  <button
                    key={point.id}
                    disabled={busy}
                    onClick={() => void restoreHistory(point.id)}
                  >
                    恢复 {new Date(point.at).toLocaleString()} · {point.source ?? "旧历史"}
                  </button>
                ))}
              </div>
            )}
            {trashEntries.length > 0 && (
              <div className="trash-entries">
                <p>回收站（恢复不会覆盖现有路径）：</p>
                {trashEntries.map((entry) => (
                  <button
                    key={entry.id}
                    disabled={busy}
                    onClick={() => void restoreTrash(entry.id)}
                  >
                    恢复 {entry.stem.split("/").pop()} · {new Date(entry.at).toLocaleString()}
                  </button>
                ))}
              </div>
            )}
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
            {folderPrefix.split("/").length >= 3 && (
              <div className="tool-row">
                <input
                  aria-label="目录移动目标路径"
                  placeholder="raw/Projects/新目录"
                  value={folderDestination}
                  onChange={(e) => setFolderDestination(e.target.value)}
                />
                <button
                  disabled={offline || editingLocked || !folderDestination.trim()}
                  onClick={() => void moveSelectedFolder()}
                >
                  移动当前目录
                </button>
              </div>
            )}
            <p>
              支持移动单篇笔记或当前任意层级子目录；受支持的引用随事务更新。
              复杂 OFM、未知结构化引用、根目录移动和同名覆盖均会被拒绝。
            </p>
          </details>
        </footer>
      </main>
    </div>
  );
}
createRoot(document.getElementById("root")!).render(<App />);
