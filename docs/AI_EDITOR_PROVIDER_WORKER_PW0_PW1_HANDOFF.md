# AI Editor Provider Worker PW0/PW1 交接

更新时间：2026-07-20
分支：`codex/provider-worker-mvp`

## 已完成

- 从 Oscar 完整 Gateway/Edge/P0 基线创建独立工作树；
- 安全汇合 Black 最新三个账号导入提交；
- 增加 `provider-worker` 显式模式和固定本地端口 `47930`；
- 增加 Gateway ↔ Worker HMAC-SHA256 签名合同；
- 增加 timestamp、正文摘要、Gateway allowlist 和 nonce 防重放；
- 增加 Turn 幂等、已完成 SSE 重放、冲突检测、状态和取消；
- 增加分块 SSE Mock 和完成用量回报；
- 增加 Gateway `ProviderWorkerClient`，可转发模型目录、Responses 和 Chat Completions；
- 增加生产 mTLS 配置硬门禁和真实 CA/服务端/客户端证书握手测试；
- 开发脚本可同时启动 `47920` Gateway、`47921` Edge 和 `47930` Worker；
- 增加独立 Worker 发布白名单、制品构建和泄漏检查。

## 本地验证

```powershell
Set-Location 'D:\AI_prejoct\codex_proxy-provider-worker'

npm run test:provider-worker
npm run gateway:test
npm run test:dev-scripts
npm run provider-worker:release-check
npm run provider-worker:build-release
```

隔离三进程启动：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File `
  .\tools\start-ai-editor-dev.ps1 `
  -Mode all `
  -AuthenticationMode mock `
  -DataRoot 'D:\AI_prejoct\codex_proxy-provider-worker\.ai-editor-dev\provider-worker-manual'
```

预期：

```text
http://127.0.0.1:47920/live → mode=gateway
http://127.0.0.1:47921/live → mode=edge
http://127.0.0.1:47930/live → mode=provider-worker
```

停止：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File `
  .\tools\stop-ai-editor-dev.ps1 `
  -Mode all `
  -DataRoot 'D:\AI_prejoct\codex_proxy-provider-worker\.ai-editor-dev\provider-worker-manual'
```

## 当前边界

- Worker 仍使用 Mock Provider，不接触真实 Provider 账号或订阅 Token；
- 开发脚本使用仅存在于子进程内存的随机签名 Secret；
- 正式生产必须配置 mTLS，开发回环 HTTP 不可用于公网；
- Provider 管理配置尚未下沉到 Worker；
- 用量重放当前为内存实现，持久化 outbox/inbox 属于后续阶段；
- 不包含 KMS、信封加密、域名、备案、云主机或公网部署；
- 未停止、重启、迁移或修改共享 `127.0.0.1:47892`。

## 验证结果

- 根测试（standalone、Edge、Worker）：`148/148`
- Gateway：`111/111`
- Admin Web：`28/28`
- `npm run release:check`：通过
- `npm audit --audit-level=high`：`0 vulnerabilities`
- Worker 制品边界：`11` 个白名单源文件，最终 `12` 个运行文件
- Worker 制品烟测：
  - `/live=ok, mode=provider-worker`
  - `/ready=ready, transport=loopback-development`
- 共享 `47892`：
  - 验证前后 PID：`28676`
  - 验证前后 `/live=ok`
  - 未被停止或重启

## 下一阶段

PW2：

1. 把现有 Provider Runtime 抽取为共享内部模块；
2. 将 ChatGPT 订阅通道现有管理员开关、账号参与路由、自动冷却、故障摘除和试验标识
   原样迁移到 Worker；
3. 增加真实 Provider 但只使用专用测试凭据；
4. 增加持久化凭据引用和用量 outbox 合同。

进入真实远程联调前，需要 Oscar 决定 Provider 测试账号、Worker 云主机地区和相关
人工购买事项。
