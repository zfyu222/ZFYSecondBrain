import { describe, expect, it } from "vitest";
import { serializeOpml, topic } from "../src/core/formats";
import { documentTitle } from "../src/core/document-title";

describe("portable document titles", () => {
  it("uses an explicit Markdown title before the readable path", () => {
    expect(
      documentTitle(
        { "raw/Inbox/record.md": "---\ntitle: 睡眠记录\n---\n正文" },
        "raw/Inbox/record",
      ),
    ).toBe("睡眠记录");
  });

  it("uses the OPML head title for a map-only document", () => {
    expect(
      documentTitle(
        {
          "raw/Areas/health.opml": serializeOpml({
            title: "健康全景",
            root: topic("健康"),
          }),
        },
        "raw/Areas/health",
      ),
    ).toBe("健康全景");
  });

  it("keeps the readable filename when no title is available", () => {
    expect(documentTitle({}, "raw/Inbox/未命名记录")).toBe("未命名记录");
  });
});
