import { describe, expect, it } from "vitest";
import { validateCilRequest } from "../src/core/cil";

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
});
