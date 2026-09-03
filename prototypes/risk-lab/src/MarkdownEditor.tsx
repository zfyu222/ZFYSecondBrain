import React from "react";
import CodeMirror from "@uiw/react-codemirror";
import { markdown } from "@codemirror/lang-markdown";

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
  return (
    <CodeMirror
      aria-label="Markdown 编辑器"
      editable={!locked}
      readOnly={locked}
      value={value}
      height="420px"
      extensions={extensions}
      onChange={onChange}
      basicSetup={{ lineNumbers: true, foldGutter: false }}
    />
  );
}
