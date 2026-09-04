import { safeYaml } from "./formats";

export type DualViewState = {
  version: 1;
  markdown: string;
  opml: string;
  recordedAt: string;
};

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
  return `version: 1\nmarkdown: ${contentFingerprint(markdown)}\nopml: ${contentFingerprint(opml)}\nrecorded_at: ${JSON.stringify(recordedAt)}\n`;
}

export function readDualView(text: string): DualViewState | null {
  if (!text) return null;
  const value = safeYaml(text);
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("双视图记录必须是 YAML 对象");
  const data = value as Record<string, unknown>;
  if (data.version !== 1 || typeof data.markdown !== "string" || typeof data.opml !== "string" || typeof data.recorded_at !== "string")
    throw new Error("双视图记录格式无效");
  return { version: 1, markdown: data.markdown, opml: data.opml, recordedAt: data.recorded_at };
}

export function dualViewChanges(state: DualViewState | null, markdown: string, opml: string) {
  if (!state) return { markdown: true, opml: true, known: false };
  return { markdown: state.markdown !== contentFingerprint(markdown), opml: state.opml !== contentFingerprint(opml), known: true };
}
