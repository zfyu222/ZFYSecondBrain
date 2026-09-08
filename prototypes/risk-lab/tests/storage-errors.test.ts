import { describe, expect, it } from "vitest";
import { describeStorageError } from "../src/core/storage-errors";

describe("local storage error messages", () => {
  it("explains quota exhaustion without exposing a raw browser exception", () => {
    expect(describeStorageError({ name: "QuotaExceededError", message: "quota" })).toContain("本机空间不足");
  });
  it("explains rejected private storage", () => {
    expect(describeStorageError(new Error("storage denied in private mode"))).toContain("拒绝本机存储");
  });
  it("keeps unrelated errors readable", () => {
    expect(describeStorageError(new Error("network unavailable"))).toBe("network unavailable");
  });
});
