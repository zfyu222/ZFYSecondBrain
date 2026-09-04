import { describe, expect, it } from "vitest";
import { appearsInFolder, folderTree } from "../src/core/folders";

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
  it("treats readable soft links as virtual folder entrances", () => {
    const markdown =
      "---\nsoft_links: [raw/Areas/健康/睡眠, raw/Projects/减脂]\n---\n正文";
    expect(appearsInFolder("raw/Inbox/记录", markdown, "raw/Areas")).toBe(true);
    expect(
      appearsInFolder("raw/Inbox/记录", markdown, "raw/Areas/健康/睡眠"),
    ).toBe(true);
    expect(appearsInFolder("raw/Inbox/记录", markdown, "raw/Archive")).toBe(
      false,
    );
    expect(
      appearsInFolder("raw/Areas/健康/实体", "---\nbad: [\n---", "raw/Areas"),
    ).toBe(true);
  });
  it("shows virtual-only soft-link folders in the portable tree", () => {
    expect(
      folderTree(["raw/Inbox/记录"], ["raw/Areas/健康/睡眠"]),
    ).toEqual([
      {
        path: "raw",
        name: "raw",
        children: [
          {
            path: "raw/Areas",
            name: "Areas",
            children: [
              {
                path: "raw/Areas/健康",
                name: "健康",
                children: [
                  { path: "raw/Areas/健康/睡眠", name: "睡眠", children: [] },
                ],
              },
            ],
          },
          { path: "raw/Inbox", name: "Inbox", children: [] },
        ],
      },
    ]);
  });
});
