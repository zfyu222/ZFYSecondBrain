import { serializeOpml, serializeRelations, topic, flatten } from "./formats";

export function sampleFiles(): Record<string, string> {
  const root = topic("第二大脑");
  root.children = [topic("自由记录"), topic("保持可迁移"), topic("可靠保存")];
  root.children[0].body = "用导图组织思路，用 Markdown 阅读。";
  root.children[1].body = "原始文件使用 Markdown、OPML 和 YAML。";
  const map = { title: "开始使用", root };
  const rows = flatten(map);
  return {
    "raw/Inbox/开始使用.md":
      "# 第二大脑，先从一条笔记开始\n\n这是独立的技术原型，暂不接入 AI。\n\n## 今天想验证什么\n\n- [ ] 编辑 Markdown，刷新后仍然存在\n- [ ] 在导图里添加一个想法\n- [ ] 同步到本地测试服务\n\n> 两个视图独立保存，尚未启用 AI 语义同步。\n",
    "raw/Inbox/开始使用.opml": serializeOpml(map),
    "raw/Inbox/开始使用.relations.yaml": serializeRelations("开始使用.opml", [
      {
        from: rows[2].path,
        to: rows[3].path,
        type: "支持",
        status: "confirmed",
      },
    ]),
    "raw/Areas/原型说明.md":
      "# 原型说明\n\n返回 [[raw/Inbox/开始使用#今天想验证什么|开始使用]]。\n\n本地服务只允许 localhost 访问，不连接真实 Linux 服务器。\n",
  };
}
