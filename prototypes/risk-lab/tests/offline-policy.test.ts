import { describe, expect, it } from "vitest";
import { canPerformAction, newNoteParent } from "../src/core/offline-policy";

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

  it("always places offline drafts in Inbox instead of inferring a structural destination", () => {
    expect(newNoteParent(true, "raw/Projects/项目 A")).toBe("raw/Inbox");
    expect(newNoteParent(false, "raw/Projects/项目 A")).toBe("raw/Projects/项目 A");
    expect(newNoteParent(false, "raw/Archive")).toBe("raw/Inbox");
  });
});
