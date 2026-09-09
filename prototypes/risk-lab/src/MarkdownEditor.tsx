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
  return (
    <div className="markdown-editor-shell">
      <div className="markdown-editor-actions" aria-label="Markdown 编辑历史">
        <button type="button" disabled={locked || !history.undo} onClick={() => travel("undo")}>撤销</button>
        <button type="button" disabled={locked || !history.redo} onClick={() => travel("redo")}>重做</button>
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
