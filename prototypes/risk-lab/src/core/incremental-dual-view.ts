import { diff3Merge } from "node-diff3";
import { contentFingerprint, type DualViewState } from "./dual-view";

const splitLines = (value: string) => value.match(/[^\n]*\n|[^\n]+$/g) ?? [];

export type IncrementalSyncResult =
  | { kind: "synced"; content: string; changed: boolean }
  | { kind: "unchanged"; content: string }
  | { kind: "baseline-required"; message: string }
  | { kind: "conflict"; message: string };

/**
 * Merge a freshly converted projection into its existing companion using the
 * last successful conversion as a common base. A conflict is deliberately not
 * written: the user keeps both representations intact instead of losing map
 * layout/body edits that are important for recall.
 */
export function incrementalDualSync(options: {
  state: DualViewState | null;
  source: "markdown" | "opml";
  sourceCurrent: string;
  targetCurrent: string;
  convert: () => string;
  validateTarget?: (value: string) => void;
}): IncrementalSyncResult {
  const { state, source, sourceCurrent, targetCurrent, convert, validateTarget } = options;
  const sourceBaseline = source === "markdown" ? state?.baselineMarkdown : state?.baselineOpml;
  const targetBaseline = source === "markdown" ? state?.baselineOpml : state?.baselineMarkdown;
  const targetFingerprint = source === "markdown" ? state?.opml : state?.markdown;

  if (!state || !sourceBaseline || !targetBaseline) {
    // A legacy fingerprint-only sidecar can still be safely upgraded when the
    // target has not changed since it was recorded. Otherwise there is no base
    // from which to distinguish user edits from generated content.
    if (state && targetFingerprint === contentFingerprint(targetCurrent)) {
      const content = convert();
      validateTarget?.(content);
      return { kind: "synced", content, changed: content !== targetCurrent };
    }
    return {
      kind: "baseline-required",
      message: "缺少可用的共同基线；另一视图已有改动，未进行可能覆盖内容的完整重建。请先记录当前双视图基线。",
    };
  }

  if (sourceCurrent === sourceBaseline)
    return { kind: "unchanged", content: targetCurrent };

  const converted = convert();
  if (targetCurrent === targetBaseline) {
    validateTarget?.(converted);
    return { kind: "synced", content: converted, changed: converted !== targetCurrent };
  }
  if (converted === targetBaseline)
    return { kind: "unchanged", content: targetCurrent };

  const parts = diff3Merge(
    splitLines(targetCurrent),
    splitLines(targetBaseline),
    splitLines(converted),
  );
  if (parts.some((part) => part.conflict))
    return {
      kind: "conflict",
      message: "检测到两侧对同一内容的重叠修改，未覆盖任何一侧。请手动处理后记录新的双视图基线。",
    };
  const content = parts.map((part) => part.ok!.join("")).join("");
  try {
    validateTarget?.(content);
  } catch {
    return {
      kind: "conflict",
      message: "增量合并会产生无效的结构化内容，未覆盖任何一侧。请手动处理后记录新的双视图基线。",
    };
  }
  return { kind: "synced", content, changed: content !== targetCurrent };
}
