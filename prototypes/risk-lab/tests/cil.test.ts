import { describe, expect, it } from "vitest";
import { executeCilRequest, validateCilRequest } from "../src/core/cil";

describe("controlled CIL boundary", () => {
  it("accepts fixed read-only commands", () => {
    expect(
      validateCilRequest({
        version: 1,
        task: "问答",
        command: "search",
        paths: ["raw/Areas"],
        query: "睡眠",
        authorization: "read",
      }).command,
    ).toBe("search");
  });
  it("rejects shell-like commands and unapproved change proposals", () => {
    expect(() =>
      validateCilRequest({
        version: 1,
        task: "x",
        command: "shell",
        paths: ["raw/Inbox"],
        authorization: "read",
      }),
    ).toThrow();
    expect(() =>
      validateCilRequest({
        version: 1,
        task: "x",
        command: "propose-change",
        paths: ["raw/Inbox/a.md"],
        authorization: "read",
      }),
    ).toThrow("未经明确授权");
  });
  it("searches only the explicitly scoped raw snapshot and excludes Archive", () => {
    const result = executeCilRequest(
      {
        version: 1,
        task: "问答",
        command: "search",
        paths: ["raw/Areas"],
        query: "睡眠",
        authorization: "read",
      },
      {
        "raw/Areas/健康.md": "# 睡眠\n建议规律作息",
        "raw/Archive/旧研究.md": "# 睡眠\n旧结论",
        "raw/Inbox/随手.md": "睡眠",
      },
    );
    expect(result).toEqual({
      command: "search",
      matches: [{ path: "raw/Areas/健康.md", excerpt: "# 睡眠 建议规律作息" }],
    });
  });
  it("accepts an authorized, version-bound proposal without writing it", () => {
    const proposal = {
      path: "raw/Inbox/a.md",
      baseRevision: "a".repeat(64),
      content: "# 已整理",
      rationale: "用户明确要求改写",
    };
    expect(
      executeCilRequest(
        {
          version: 1,
          task: "受托编辑",
          command: "propose-change",
          paths: ["raw/Inbox"],
          authorization: "propose-change",
          proposal,
        },
        { "raw/Inbox/a.md": "# 原文" },
      ),
    ).toEqual({ command: "propose-change", accepted: true, proposal });
  });
  it("rejects proposals outside their authorized scope", () => {
    expect(() =>
      validateCilRequest({
        version: 1,
        task: "受托编辑",
        command: "propose-change",
        paths: ["raw/Inbox"],
        authorization: "propose-change",
        proposal: {
          path: "raw/Areas/a.md",
          baseRevision: "a".repeat(64),
          content: "# 变更",
          rationale: "越界",
        },
      }),
    ).toThrow("超出任务授权路径范围");
  });
});
