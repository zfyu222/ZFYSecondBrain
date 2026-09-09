import React, { useRef, useState } from "react";
import CodeMirror, { type ReactCodeMirrorRef } from "@uiw/react-codemirror";
import { markdown } from "@codemirror/lang-markdown";
import { redo, redoDepth, undo, undoDepth } from "@codemirror/commands";
import type { EditorView } from "@codemirror/view";

const extensions = [markdown()];
export default function MarkdownEditor({
  value,
  locked,
  onChange,
}: {
  value: string;
  locked: boolean;
  onChange: (value: string) => void;
}) {
  const editor = useRef<ReactCodeMirrorRef>(null);
  const [history, setHistory] = useState({ undo: false, redo: false });
  const refreshHistory = (view: EditorView | undefined) => {
    if (!view) return;
    setHistory({ undo: undoDepth(view.state) > 0, redo: redoDepth(view.state) > 0 });
  };
  const travel = (direction: "undo" | "redo") => {
    const view = editor.current?.view;
    if (!view || locked) return;
    (direction === "undo" ? undo : redo)(view);
    refreshHistory(view);
    view.focus();
  };
  const replaceSelection = (before: string, after: string, placeholder: string) => {
    const view = editor.current?.view;
    if (!view || locked) return;
    const { from, to } = view.state.selection.main;
    const selected = view.state.sliceDoc(from, to) || placeholder;
    view.dispatch({
      changes: { from, to, insert: `${before}${selected}${after}` },
      selection: { anchor: from + before.length, head: from + before.length + selected.length },
      userEvent: "input.complete",
    });
    refreshHistory(view);
    view.focus();
  };
  const insertTask = () => {
    const view = editor.current?.view;
    if (!view || locked) return;
    const { from, to } = view.state.selection.main;
    const selected = view.state.sliceDoc(from, to);
    const prefix = from > 0 && view.state.sliceDoc(from - 1, from) !== "\n" ? "\n" : "";
    view.dispatch({
      changes: { from, to, insert: `${prefix}- [ ] ${selected}` },
      selection: { anchor: from + prefix.length + 6, head: from + prefix.length + 6 + selected.length },
      userEvent: "input.complete",
    });
    refreshHistory(view);
    view.focus();
  };
  return (
    <div className="markdown-editor-shell">
      <div className="markdown-editor-actions" aria-label="Markdown 编辑历史">
        <button type="button" disabled={locked || !history.undo} onClick={() => travel("undo")}>撤销</button>
        <button type="button" disabled={locked || !history.redo} onClick={() => travel("redo")}>重做</button>
        <button type="button" disabled={locked} onClick={() => replaceSelection("**", "**", "粗体文字")}>粗体</button>
        <button type="button" disabled={locked} onClick={insertTask}>插入待办</button>
        <button type="button" disabled={locked} onClick={() => replaceSelection("[", "](https://)", "链接文字")}>插入链接</button>
        <span>Ctrl/Cmd + Z、Ctrl/Cmd + Shift + Z</span>
      </div>
      <CodeMirror
        ref={editor}
        aria-label="Markdown 编辑器"
        editable={!locked}
        readOnly={locked}
        value={value}
        height="420px"
        extensions={extensions}
        onCreateEditor={(view) => refreshHistory(view)}
        onUpdate={(update) => refreshHistory(update.view)}
        onChange={onChange}
        basicSetup={{ lineNumbers: true, foldGutter: false }}
      />
    </div>
  );
}
