import { describe, expect, it } from "vitest";
import {
  isTemplateStem,
  templateDirectory,
  templateName,
} from "../src/core/templates";

describe("portable note templates", () => {
  it("keeps templates in a readable raw subdirectory without creating a fifth space", () => {
    expect(templateDirectory).toBe("raw/Areas/_templates/");
    expect(isTemplateStem("raw/Areas/_templates/会议记录")).toBe(true);
    expect(isTemplateStem("raw/Areas/会议记录")).toBe(false);
    expect(templateName("raw/Areas/_templates/会议记录")).toBe("会议记录");
  });
});
