# AI Editor Provider Worker：ChatGPT 订阅账号池交接

更新时间：2026-07-20
分支：`codex/provider-worker-mvp`
阶段：PW2 / T133–T134

## 本轮完成

1. Gateway `ProviderWorkerClient` 新增签名运行时同步：
   - `PUT /internal/v1/runtime/chatgpt-sub`
   - 只发送 ChatGPT 订阅账号、订阅模型和账号池策略；
   - 不发送 DeepSeek、OpenAI API 或 Relay 凭据。
2. Worker 新增 `chatgpt-sub` 执行器：
   - 直接动态复用 `src/routes/chatgpt-sub.js`；
   - 复用现有账号选择、并发租约、Token 刷新、额度保护、429 冷却、
     401/403 摘除、故障轮换和 SSE 透传；
   - 复用 `src/convert/tool-ids.js`，继续保证
     `function_call.id=fc_*` 且原始 `call_id` 不变；
   - 支持 Responses 和 Chat Completions。
3. Worker 新增一级管理员所需的签名内部接口：
   - 动态模型目录；
   - 账号池脱敏状态；
   - Provider/熔断脱敏诊断；
   - 指定账号用量刷新。
4. 管理页面明确标记 ChatGPT 订阅为“试验通道”，继续保留：
   - Provider 总开关；
   - 单账号是否参与路由；
   - 路由策略；
   - 自动冷却、登录失效摘除和额度保护。
5. 隔离与发布边界：
   - Worker 不读取或复制共享 `127.0.0.1:47892`；
   - 同步凭据只保存在 Worker 内存，不生成明文
     `codex-proxy-config.json`；
   - Worker 请求日志改到 Worker 独立数据目录；
   - 发布清单只加入订阅执行所需的共享 Provider Runtime 文件；
   - 发布检查会验证相对 import 全部存在并禁止加入其他 route。

## 开发运行

真实账号服务模式默认启用订阅执行器：

```powershell
Set-Location 'D:\AI_prejoct\codex_proxy-provider-worker'

powershell -NoProfile -ExecutionPolicy Bypass -File `
  .\tools\start-ai-editor-dev.ps1 `
  -Mode all `
  -AuthenticationMode real `
  -DataRoot 'D:\AI_prejoct\codex_proxy-provider-worker\.ai-editor-dev\chatgpt-pool'
```

Mock 模式仍显式保持 Mock Worker：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File `
  .\tools\start-ai-editor-dev.ps1 `
  -Mode all `
  -AuthenticationMode mock `
  -DataRoot 'D:\AI_prejoct\codex_proxy-provider-worker\.ai-editor-dev\chatgpt-pool-mock'
```

停止：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File `
  .\tools\stop-ai-editor-dev.ps1 `
  -Mode all `
  -DataRoot 'D:\AI_prejoct\codex_proxy-provider-worker\.ai-editor-dev\chatgpt-pool'
```

## 自动化验收

- 根测试：`149/149`
- Gateway：`112/112`
- Admin Web：`28/28`
- Provider Worker 专项：
  - 两账号 429 冷却和轮换；
  - 401 登录失效摘除和轮换；
  - `routing_enabled=false` 不参与路由；
  - Responses SSE 与实际用量；
  - 旧 `tool_*` item ID 修复为 `fc_*`，原始 `call_id` 保留；
  - Worker 账号配置不落明文文件。
- `npm run release:check`：通过
- `npm audit --audit-level=high`：`0 vulnerabilities`
- Worker 发布制品：`27` 个白名单源文件、`28` 个最终文件
- 三进程脚本测试结束后 `47920/47921/47930` 均释放
- 共享 `47892` 验证前后均为 PID `26404`、`/live=ok`

## 尚未完成

1. T135：持久化 execution/outbox、用量对账和 Gateway 签名确认。
2. Worker 重启后的刷新 Token 安全持久化：
   - 当前不允许把明文 Token 写入磁盘；
   - Worker 进程内刷新后的滚动 Refresh Token 会保留在内存；
   - 在 T135/PW3 的安全凭据存储完成前，不做公网发布。
3. 专用真实 ChatGPT 测试账号联合验收：
   - 必须由一级管理员通过隔离 Gateway 管理页导入；
   - 不得把 Token、密码、订阅 URL 或 `auth.json` 发到聊天或提交到 Git。
4. KMS/信封加密、境外 Worker、生产 mTLS 证书和公网部署属于 PW3/PW4。

## 下一阶段人工门禁

- 需要 Oscar 操作的购买/订阅：当前不需要购买；真实联合验收需要一个获授权的专用
  ChatGPT 测试订阅账号。
- 最迟完成时间：开始真实 Provider 联调前。
- 未完成时被阻断的任务：真实 ChatGPT 回应验收；不阻断 T135 自动化开发。
- 当前是否需要付款：否。
