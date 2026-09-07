import { describe, expect, it } from "vitest";
import { canPerformAction } from "../src/core/offline-policy";

describe("Web first-release offline policy", () => {
  it("keeps cached reading, editing and Inbox creation local", () => {
    expect(canPerformAction(true, "create-inbox")).toBe(true);
    expect(canPerformAction(true, "edit-cached")).toBe(true);
    expect(canPerformAction(true, "search-cached")).toBe(true);
  });

  it("requires a connection before changing structure or uploading attachments", () => {
    expect(canPerformAction(true, "attachment-upload")).toBe(false);
    expect(canPerformAction(true, "structure-change")).toBe(false);
    expect(canPerformAction(true, "server-processing")).toBe(false);
    expect(canPerformAction(false, "attachment-upload")).toBe(true);
  });
});
