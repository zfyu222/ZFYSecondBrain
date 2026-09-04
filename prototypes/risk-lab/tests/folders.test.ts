import { describe, expect, it } from "vitest";
import { folderTree } from "../src/core/folders";

describe("portable folder tree", () => {
  it("retains arbitrary nested directory paths", () => {
    expect(folderTree(["raw/Areas/健康/睡眠/记录", "raw/Projects/A/计划"])).toEqual([
      { path: "raw", name: "raw", children: [
        { path: "raw/Areas", name: "Areas", children: [
          { path: "raw/Areas/健康", name: "健康", children: [
            { path: "raw/Areas/健康/睡眠", name: "睡眠", children: [] },
          ] },
        ] },
        { path: "raw/Projects", name: "Projects", children: [
          { path: "raw/Projects/A", name: "A", children: [] },
        ] },
      ] },
    ]);
  });
});
