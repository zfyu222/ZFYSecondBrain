import { describe, expect, it } from "vitest";
import { attachmentPreviewKind } from "../src/AttachmentMedia";

describe("local attachment presentation boundary", () => {
  it("only previews locally supported stored media formats", () => {
    expect(attachmentPreviewKind("raw/Inbox/n.assets/image.png")).toBe("image");
    expect(attachmentPreviewKind("raw/Inbox/n.assets/movie.webm")).toBe("video");
    expect(attachmentPreviewKind("raw/Inbox/n.assets/audio.ogg")).toBe("audio");
    expect(attachmentPreviewKind("raw/Inbox/n.assets/readme.pdf")).toBe("pdf");
  });
  it("keeps ordinary links and unknown extensions download-only", () => {
    expect(attachmentPreviewKind("raw/Inbox/n.assets/readme.pdf", true)).toBe("download");
    expect(attachmentPreviewKind("raw/Inbox/n.assets/untrusted.svg")).toBe("download");
  });
});
