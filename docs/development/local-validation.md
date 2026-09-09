# 本地首版验证手册

本项目默认先在本机回环地址验证，远程服务器只用于最后的部署与网络条件验收。所有浏览器 smoke 都使用隔离数据目录和独立端口，不会读取默认 `127.0.0.1:4173` 的知识库。

## 启动

在仓库根目录执行（也可进入 `prototypes/risk-lab` 使用对应子项目脚本）：

```text
pnpm install
pnpm dev
```

开发页面地址为 `http://127.0.0.1:4173/`。生产构建先执行 `pnpm build`，再用 `pnpm start` 启动同一回环端口。

## 必跑门禁

```text
pnpm verify:local
```

发布前推荐直接运行：

```text
pnpm verify:release
```

它会在本地门禁完成后继续执行关键浏览器 smoke；密钥扫描仍需单独运行 gitleaks。

如需将本地门禁与远程临时数据验收串为一次可复现检查，运行：

```text
ZFY_REMOTE_ORIGIN=https://… ZFY_REMOTE_PASSWORD=… ZFY_REMOTE_ALLOW_SELF_SIGNED=1 pnpm verify:first-release
```

默认包含远程登录、双浏览器同步、附件预览与移动回归。设置 `ZFY_REMOTE_INCLUDE_AI=1` 才会追加一次会产生模型请求的只读问答回归。

提交前运行仓库级密钥扫描：

```text
gitleaks detect --source . --no-banner --redact
```

## 浏览器验收

```text
pnpm browser:smoke
pnpm browser:auth-smoke
pnpm browser:sync-smoke
pnpm browser:conflict-smoke
pnpm browser:move-smoke
pnpm browser:dual-view-smoke
pnpm browser:media-smoke
pnpm browser:tab-smoke
pnpm browser:memory-schedule-smoke
pnpm browser:offline-smoke
```

根目录 `pnpm verify:browser` 会自动启动或复用本地服务，并依次验证主页/PWA、认证保护、离线重开、跨客户端同步与冲突、路径事务、媒体预览、双视图增量同步、多标签页联动，以及服务晚启动时“错过计划但不自动补跑”的通知。各专项脚本仍可单独执行；测试服务结束后会清理其临时进程，失败时先保留输出，再检查端口是否被其他本地服务占用。

远程最后验收可运行 `ZFY_REMOTE_ORIGIN=https://… ZFY_REMOTE_PASSWORD=… ZFY_REMOTE_ALLOW_SELF_SIGNED=1 pnpm browser:remote-smoke`；该命令验证登录、主界面、390px 布局，并创建一篇随机标题的临时 Inbox 笔记及 GIF 附件、同步后移至 Areas，再由第二个独立浏览器读取新位置并预览附件，最后按版本号删除该专用笔记和附件。正式域名证书通过后省略自签名开关。

远程模型配置和只读问答可在确认成本上限后运行 `ZFY_REMOTE_ORIGIN=https://… ZFY_REMOTE_PASSWORD=… ZFY_REMOTE_ALLOW_SELF_SIGNED=1 pnpm browser:remote-ai-smoke`；它会检查模型配置、请求一次带引用回答并确认返回原文引用，不执行任何写入。

静态资源服务对非法 URL 编码和 NUL 路径会明确拒绝；Fastify 层统一返回 400，避免把请求格式错误误报为服务端 500。

## 远程验收顺序

远程测试必须在本地门禁全绿后进行：先确认容器持久目录和回环应用端口，再通过受信任域名/证书验证登录、同步、附件和移动端。IP 自签名 HTTPS 只能作为连通性测试，不作为正式证书验收；不得把测试凭据写入仓库或日志。
