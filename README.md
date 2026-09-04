# ZFY Second Brain

一个处于关键风险原型验证阶段的个人第二大脑/笔记软件项目。

## 当前状态

项目仓库已完成初始化、首版范围和技术设计；现有独立本地原型可体验 Markdown/导图编辑、持久化、同步与部分路径移动。尚不是正式首版，不连接真实知识库、AI 或 Linux 服务器。

目标客户端为 Web、安卓和 Windows，优先支持 Web；服务端计划自托管于用户自己的 Linux 服务器。

首版限定单用户、单知识库，包含 Markdown/思维导图编辑、必要离线与同步、独立 AI 管理员及每日记忆整理。完整分层图谱、原生客户端和安卓控件后续实施，不混入可选想法池。

技术基线：React + TypeScript + Vite 共享前端，Node.js/Fastify 知识库服务，原格式文件 + 可重建 SQLite 索引；原型暂未使用 SQLite，原生端 Tauri 2 和管理员 nanobot 适配器需验证。不能把原型子集当作完整首版。

## 运行原型

使用 Node.js 24、pnpm 11，在仓库根目录执行：

```sh
pnpm install --frozen-lockfile
pnpm test
pnpm build
pnpm preview:prototype
```

访问 <http://127.0.0.1:4173/>，仅使用独立测试数据。启动说明和限制见[原型说明](prototypes/risk-lab/README.md)，实际结果见[验证报告](docs/architecture/prototype-validation.md)。

## 资料

- [需求总览与查漏补缺（从这里开始）](docs/requirements/overview.md)
- [Web 首版范围与离线边界](docs/requirements/web-first-release.md)
- [整体架构与技术选型方案](docs/architecture/technical-design.md)
- [技术验证与开发里程碑](docs/architecture/validation-and-milestones.md)
- [M0 原型格式与接口契约](docs/architecture/prototype-contracts.md)
- [M0 原型验证记录与剩余门槛](docs/architecture/prototype-validation.md)
- [初始需求草图](docs/requirements/initial-idea.md)
- [知识组织方式](docs/requirements/knowledge-organization.md)
- [笔记双视图](docs/requirements/dual-view-notes.md)
- [数据可迁移原则](docs/requirements/data-portability.md)
- [分层知识图谱与文档地图](docs/requirements/hierarchical-knowledge-graph.md)
- [AI 知识管理员](docs/requirements/ai-knowledge-manager.md)
- [多端同步与离线使用](docs/requirements/multi-device-sync.md)
- [笔记模板](docs/requirements/note-templates.md)
- [安卓今日 Inbox 桌面控件](docs/requirements/android-inbox-widget.md)
- [撤销、历史记录与备份恢复](docs/requirements/history-and-recovery.md)
- [客户端平台与 Linux 服务器部署](docs/requirements/platforms-and-deployment.md)
- [进阶想法池：候选方向，不承诺实现](docs/advanced-ideas.md)

## 原则

- 需求先于实现
- 技术选型服务于产品目标
- 原始数据使用开放、可读、可迁移的形式保存
- 知识库独立于可替换的 AI 知识管理员运行
- 重要决策通过文档记录
