# 本地首版验证手册

本项目默认先在本机回环地址验证，远程服务器只用于最后的部署与网络条件验收。所有浏览器 smoke 都使用隔离数据目录和独立端口，不会读取默认 `127.0.0.1:4173` 的知识库。

## 启动

在 `prototypes/risk-lab` 目录执行：

```text
pnpm install
pnpm dev
```

开发页面地址为 `http://127.0.0.1:4173/`。生产构建先执行 `pnpm build`，再用 `pnpm start` 启动同一回环端口。

## 必跑门禁

```text
pnpm typecheck
pnpm test
pnpm build
pnpm check:build
```

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
pnpm browser:offline-smoke
```

其中 `browser:tab-smoke` 验证同一浏览器的标签页版本广播，`browser:dual-view-smoke` 验证共同基线下的非重叠增量合并，`browser:media-smoke` 验证桌面 Chrome 和 390px 窄屏的媒体预览。测试服务结束后会清理其临时进程；失败时先保留输出，再检查端口是否被其他本地服务占用。

## 远程验收顺序

远程测试必须在本地门禁全绿后进行：先确认容器持久目录和回环应用端口，再通过受信任域名/证书验证登录、同步、附件和移动端。IP 自签名 HTTPS 只能作为连通性测试，不作为正式证书验收；不得把测试凭据写入仓库或日志。
