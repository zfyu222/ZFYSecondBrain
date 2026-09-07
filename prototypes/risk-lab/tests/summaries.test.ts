import { describe, expect, it } from "vitest";
import {
  parseSummary,
  serializeSummary,
  summaryPath,
  type SummaryDocument,
  validateSummary,
} from "../src/core/summaries";

const revision = "a".repeat(64);
const source = "x".repeat(1_000);
const summary: SummaryDocument = {
  version: 1,
  source_path: "raw/Areas/健康/睡眠.md",
  source_revision: revision,
  generated_at: "2026-09-07T03:00:00.000Z",
  layers: [
    { text: "眠", source: "ai" },
    { text: "睡眠规律需要保证每天", source: "ai" },
    { text: "原文摘要".repeat(25), source: "user-confirmed" },
  ],
};

describe("portable multi-level summaries", () => {
  it("maps raw source paths to readable derived summary files", () => {
    expect(summaryPath("raw/Areas/健康/睡眠.md")).toBe(
      "derived/summaries/Areas/健康/睡眠.summary.yaml",
    );
    expect(() => summaryPath("raw/Archive/旧.md")).toThrow("未归档");
  });
  it("round-trips plain YAML with source provenance", () => {
    const text = serializeSummary(summary);
    expect(parseSummary(text, source)).toEqual(summary);
  });
  it("enforces top-level and per-level compression limits", () => {
    expect(() => validateSummary({ ...summary, layers: [{ text: "超过十个字的标题摘要内容", source: "ai" }] })).toThrow("10 字");
    expect(() => validateSummary({ ...summary, layers: [{ text: "十个字符摘要", source: "ai" }, { text: "短", source: "ai" }] })).toThrow("十分之一");
    expect(() => validateSummary(summary, "短原文")).toThrow("原文的十分之一");
  });
  it("requires an explicit source state for every layer", () => {
    expect(() => validateSummary({ ...summary, layers: [{ text: "睡眠", source: "unknown" }] })).toThrow("摘要层");
  });
});
