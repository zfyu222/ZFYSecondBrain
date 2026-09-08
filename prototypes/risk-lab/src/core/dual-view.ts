import { safeYaml } from "./formats";

export type DualViewState = {
  version: 1 | 2;
  markdown: string;
  opml: string;
  recordedAt: string;
  /** Exact common conversion point. Version 1 sidecars only had fingerprints. */
  baselineMarkdown?: string;
  baselineOpml?: string;
};

function base64Encode(value: string) {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64Decode(value: string) {
  const binary = atob(value);
  const bytes = Uint8Array.from(binary, (unit) => unit.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

// Stable non-secret content fingerprint for change detection, not an identity or
// integrity boundary. The original Markdown/OPML remain the source of truth.
export function contentFingerprint(text: string) {
  let value = 2166136261;
  for (const unit of text) {
    value ^= unit.charCodeAt(0);
    value = Math.imul(value, 16777619);
  }
  return `fnv1a-${(value >>> 0).toString(16).padStart(8, "0")}`;
}

export function recordDualView(markdown: string, opml: string, recordedAt: string) {
  // Base64 keeps multiline Markdown/XML opaque to YAML and to portable-path
  // rewrites. These are a sync baseline, never a second editable document.
  return `version: 2\nmarkdown: ${contentFingerprint(markdown)}\nopml: ${contentFingerprint(opml)}\nrecorded_at: ${JSON.stringify(recordedAt)}\nbaseline_markdown: ${JSON.stringify(base64Encode(markdown))}\nbaseline_opml: ${JSON.stringify(base64Encode(opml))}\n`;
}

export function readDualView(text: string): DualViewState | null {
  if (!text) return null;
  const value = safeYaml(text);
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("双视图记录必须是 YAML 对象");
  const data = value as Record<string, unknown>;
  if ((data.version !== 1 && data.version !== 2) || typeof data.markdown !== "string" || typeof data.opml !== "string" || typeof data.recorded_at !== "string")
    throw new Error("双视图记录格式无效");
  if (data.version === 1)
    return { version: 1, markdown: data.markdown, opml: data.opml, recordedAt: data.recorded_at };
  if (typeof data.baseline_markdown !== "string" || typeof data.baseline_opml !== "string")
    throw new Error("双视图记录缺少增量同步基线");
  try {
    return {
      version: 2,
      markdown: data.markdown,
      opml: data.opml,
      recordedAt: data.recorded_at,
      baselineMarkdown: base64Decode(data.baseline_markdown),
      baselineOpml: base64Decode(data.baseline_opml),
    };
  } catch {
    throw new Error("双视图记录的增量同步基线无效");
  }
}

export function dualViewChanges(state: DualViewState | null, markdown: string, opml: string) {
  if (!state) return { markdown: true, opml: true, known: false };
  return { markdown: state.markdown !== contentFingerprint(markdown), opml: state.opml !== contentFingerprint(opml), known: true };
}
