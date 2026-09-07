import { describe, expect, it, vi } from "vitest";
import { callCil, cilEndpoint, cilInputLimit } from "../server/cil-client";

describe("CIL command-line HTTP client", () => {
  it("posts JSON only to the fixed local endpoint", async () => {
    const request = vi.fn(async () =>
      new Response(JSON.stringify({ sourceRevision: "abc", result: {} }), {
        status: 200,
      }),
    );
    const input = { version: 1, command: "read" };
    await expect(callCil(JSON.stringify(input), request)).resolves.toEqual({
      sourceRevision: "abc",
      result: {},
    });
    expect(request).toHaveBeenCalledWith(cilEndpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    });
  });

  it("rejects empty, malformed and oversized standard input before fetch", async () => {
    const request = vi.fn();
    await expect(callCil("", request)).rejects.toThrow("标准输入");
    await expect(callCil("{", request)).rejects.toThrow("有效 JSON");
    await expect(callCil('"' + "界".repeat(cilInputLimit) + '"', request)).rejects.toThrow(
      "3 MB",
    );
    expect(request).not.toHaveBeenCalled();
  });

  it("preserves a JSON service rejection without printing a successful result", async () => {
    await expect(
      callCil("{}", async () =>
        new Response(JSON.stringify({ error: "未经明确授权" }), { status: 400 }),
      ),
    ).rejects.toThrow("未经明确授权");
  });

  it("rejects non-JSON service responses", async () => {
    await expect(
      callCil("{}", async () => new Response("bad gateway", { status: 502 })),
    ).rejects.toThrow("非 JSON");
  });
});
