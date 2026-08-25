# ZFY Markdown 格式

## 1. 定位

ZFY Markdown 是第二大脑使用的原始文档格式。文件扩展名保持为 `.md`，语法以 [Obsidian Flavored Markdown](https://obsidian.md/help/obsidian-flavored-markdown) 为兼容目标，并遵守[数据可迁移原则](./data-portability.md)。

选择该格式是为了在普通 Markdown 的基础上获得知识管理所需的内部链接、文件嵌入、属性、Callout、数学公式和其他成熟能力，同时避免创造只有本项目能够解析的私有语法。

## 2. 兼容基础

ZFY Markdown 支持：

- CommonMark 基础语法。
- GitHub Flavored Markdown 的表格、任务列表、删除线和自动链接。
- LaTeX 数学公式。
- YAML Front Matter 属性。
- Wiki Link 和标题链接。
- 文件嵌入。
- Callout、脚注、高亮和代码块。

## 3. 内部链接

内部链接使用知识库根目录下的可读路径：

```markdown
[[健康/睡眠质量]]
[[健康/睡眠质量#睡眠与食欲]]
```

- 不使用不透明 ID 定位笔记、标题或段落。
- 不使用 Obsidian 的 `^block-id` 作为内容定位方式。
- 文件或标题在应用内改名时，系统自动更新受影响的链接。
- 系统支持将内部链接批量转换为标准 Markdown 相对链接。

## 4. 属性

笔记属性保存在文件顶部的 YAML Front Matter 中：

```yaml
---
title: 睡眠质量
tags:
  - 健康
  - 减脂
favorite: true
created: 2026-08-25
---
```

属性只保存简短、结构化且适合人工维护的信息。复杂关系和大段正文不放入 Front Matter。

## 5. 图片和其他媒体

图片、视频、音频和 PDF 都保留为知识库中的原始附件文件，并通过可读路径嵌入：

```markdown
![[睡眠质量.assets/睡眠趋势.png]]
![[睡眠质量.assets/访谈.mp4]]
![[睡眠质量.assets/录音.mp3]]
![[睡眠质量.assets/研究报告.pdf]]
```

- 客户端根据文件类型显示图片、播放器或文档预览。
- 嵌入只引用原始文件，不把二进制内容编码进 Markdown。
- 导出到标准 Markdown 时，转换为目标格式可理解的图片语法或普通文件链接。
- 附件丢失后保留原始路径并显示失效提示，不静默删除引用。

## 6. 明确排除

核心数据不依赖以下能力：

- `^block-id` 和其他不透明内容 ID。
- `obsidian://` 专属 URI。
- Dataview、Templater 等插件私有语法。
- Obsidian Canvas 作为思维导图原始格式。
- MDX、JSX 或笔记中的可执行 JavaScript。
- 只有配合特定主题 CSS 才能理解的内容语义。

系统可以导入这些内容，但不得要求用户使用它们才能保存或迁移核心知识。

## 7. 兼容与导出

- 原始文件可以直接使用普通文本编辑器维护。
- 知识库可以直接使用 Obsidian 打开并读取主要语法。
- 系统提供标准 Markdown 导出，将 Wiki Link、媒体嵌入和其他扩展转换为标准链接或可理解的文本。
- 即使目标工具不支持某项增强渲染，原始路径、标题和正文仍然保持可读。
