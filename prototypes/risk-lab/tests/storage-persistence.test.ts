import { describe, expect, it, vi } from "vitest";
import { requestPersistentStorage } from "../src/storage-persistence";

describe("persistent browser storage request", () => {
  it("does not request again when storage is already persistent", async () => {
    const persist = vi.fn();
    await expect(requestPersistentStorage({ persisted: async () => true, persist })).resolves.toBe(true);
    expect(persist).not.toHaveBeenCalled();
  });
  it("requests persistence when it is not already granted", async () => {
    await expect(requestPersistentStorage({ persisted: async () => false, persist: async () => true })).resolves.toBe(true);
  });
  it("returns a safe denial result when the browser rejects the request", async () => {
    await expect(requestPersistentStorage({ persisted: async () => false, persist: async () => { throw new Error("denied"); } })).resolves.toBe(false);
    await expect(requestPersistentStorage(undefined)).resolves.toBeNull();
  });
});
