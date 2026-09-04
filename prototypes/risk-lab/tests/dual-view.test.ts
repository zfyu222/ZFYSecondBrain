import { describe, expect, it } from "vitest";
import { dualViewChanges, readDualView, recordDualView } from "../src/core/dual-view";

describe("portable dual-view baselines", () => {
  it("records readable content fingerprints and finds each changed view", () => {
    const state = readDualView(recordDualView("# A", "<opml />", "2026-09-04T03:00:00.000Z"));
    expect(dualViewChanges(state, "# A", "<opml />")).toEqual({ markdown: false, opml: false, known: true });
    expect(dualViewChanges(state, "# B", "<opml />")).toMatchObject({ markdown: true, opml: false });
  });
  it("rejects malformed sidecars instead of guessing a baseline", () => {
    expect(() => readDualView("version: 2\n")).toThrow("格式");
  });
});
