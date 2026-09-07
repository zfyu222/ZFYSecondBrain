import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import AdminPanel from "../src/AdminPanel";

describe("administrator entry", () => {
  it("keeps local evidence search separate from an unavailable model answer", () => {
    const html = renderToStaticMarkup(
      <AdminPanel offline={false} onVaultChanged={() => {}} />,
    );
    expect(html).toContain("管理员与每日整理");
    expect(html).not.toContain("本地资料检索");
  });
});
