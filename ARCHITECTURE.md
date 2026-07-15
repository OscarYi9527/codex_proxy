# Codex Proxy 架构说明

本文描述默认监听 `127.0.0.1:47892` 的当前实现。主入口是 `src/server.js`。

## 组件

```mermaid
flowchart LR
    C[Codex CLI / VS Code] -->|Responses API| S[src/server.js]
    A[本地管理后台] -->|localhost admin API| S
    S --> R{模型路由}
    R --> G[ChatGPT 订阅账号池]
    R --> O[OpenAI API]
    R --> D[DeepSeek 协议适配]
    R --> X[OpenAI 兼容中转节点]
    G --> Q[账号调度器]
    Q --> L[公平队列 / 自适应并发 / 租约]
    Q --> U[额度 / Token / 双层冷却]
    S --> ST[原子统计与健康矩阵]
    W[Windows Watchdog] -->|/live 与恢复| S
```

| 文件 | 职责 |
|---|---|
| `src/server.js` | HTTP 服务、路由分发、管理 API、单实例和优雅关闭 |
| `src/routes/chatgpt-sub.js` | ChatGPT 请求、账号轮换、公平队列和取消联动 |
| `src/chatgpt-accounts.js` | OAuth Token、额度、预测、租约、自适应并发和冷却 |
| `src/routes/openai-api.js` | OpenAI Responses / Chat Completions |
| `src/routes/deepseek.js` | Responses 与 Anthropic Messages 双向转换 |
| `src/routes/relay.js` | OpenAI 兼容中转节点 |
| `src/config.js` | 配置加载、原子写入、快照和回滚 |
| `src/credential-store.js` | Windows DPAPI 密钥封装与 AES-256-GCM 凭据加密 |
| `src/route-decisions.js` | 最近路由决策的内存环形记录 |
| `src/provider-health.js` | Provider 最近结果、错误和延迟的轻量持久化 |
| `src/stats.js` | Provider/模型/账号健康统计与近期窗口 |
| `src/circuit-breaker.js` | Provider 级熔断和半开恢复 |
| `src/error-guide.js` | HTTP 错误分类、原因和处理建议查找表 |
| `src/diagnostics.js` | 账号池/Provider/熔断联合诊断、结论与上下文操作 |
| `src/smart-routing.js` | 显式回退计划、虚拟模型评分和错误响应延迟提交 |
| `src/pricing.js` | 本地可更新模型价格目录与单请求成本估算 |
| `src/cost-governance.js` | Provider 日/月成本汇总和预算门禁 |
| `src/runtime-info.js` | 运行路径、版本、Commit 和工作区/安装副本一致性 |
| `src/admin.js` | 本机管理 API、隔离登录、诊断和运维操作 |
| `src/admin_app.js` | 管理后台交互与零基础教程 |

## 请求路由

```mermaid
flowchart TD
    I[POST /v1/responses] --> M{body.model}
    M -->|relay-*| R[Relay]
    M -->|openai-api-*| O[OpenAI API]
    M -->|gpt-*| G[ChatGPT 账号池]
    M -->|其他| D[DeepSeek]
```

默认不会在不同 Provider 之间静默切换。ChatGPT 账号池内部可以按策略切换账号；
跨 Provider 回退必须由用户明确配置或启动参数显式启用。

请求级智能路由由 `src/smart-routing.js` 统一执行：

1. 普通模型先按模型前缀确定初始 Provider；默认计划只有一个目标。
2. 用户显式开启后，按 `fallback_chain` 追加具体 Provider + 模型。
3. `auto*` 虚拟模型本身代表用户明确授权，根据健康、额度、延迟和价格排序可用目标。
4. 成功响应一旦写出即保持流式直通；错误响应先在本地缓冲，只有状态和错误类型允许时才丢弃并进入下一目标。
5. 401/402/403、参数和权限错误硬性禁止跨 Provider 回退。
6. 调用上游前检查实际 Provider 预算；`fallback` 跳过超预算线路，`stop` 返回 402。

## ChatGPT 账号生命周期

1. 管理后台通过隔离的 `CODEX_HOME` 启动官方 `codex app-server` OAuth。
2. 登录结果写入账号池，不覆盖当前 `%USERPROFILE%\.codex\auth.json`。
3. 新账号默认“仅保存”；用户启用后才参与路由。
4. Token 刷新采用单飞锁；网络错误可重试，永久凭据错误标记为需要重新登录。
5. 当前本机账号优先从真实 Codex `auth.json` 同步，避免 Refresh Token 双重轮换。
6. 额度从普通模型响应头或低频 usage 请求更新；并发额度刷新会自动合并。
7. 新账号加入后立即尝试首次额度同步；账号名称只作为本地备注，可随时修改。

## 调度与请求连续性

- 路由策略：`priority`、`round-robin`、`headroom`、`least-used`、`latency`、
  `reliable`、`weighted`、`random`、`lkgp`。
- `lkgp` 按 `session-id` / `thread-id` 粘住最后成功账号。
- 单账号并发上限为 3，并根据成功、429、网络错误和高延迟自适应到 1～3。
- 超限请求进入 FIFO 公平队列，最多等待约 60 秒。
- 账号占用使用可续期租约；过期租约每分钟回收。
- 客户端断开会取消上游请求并释放租约。
- OpenAI、Relay 与 DeepSeek 同样继承客户端取消信号，避免断开后继续消耗。
- 每个请求最多尝试 2 个账号；429 不会在同一账号上重复重试。

响应会附带：

- `X-Codex-Proxy-Request-Id`
- `X-Codex-Proxy-Provider`
- `X-Codex-Proxy-Account`
- `X-Codex-Proxy-Model`
- `X-Codex-Proxy-Latency-Ms`
- `X-Codex-Proxy-Fallback-Attempts`
- `X-Codex-Proxy-Queue-Wait-Ms`
- `X-Codex-Proxy-Queue-Position`

## 额度与冷却

- 默认在剩余 10% 时停止使用账号，安全余量是硬限制。
- 账号可覆盖全局安全余量，并设置北京时间自然日请求/Token 上限。
- 账号可按模型或会话 ID 专用预留；存在匹配预留时优先进入专用账号子池。
- 紧急继续使用以带到期时间的账号字段临时绕过余量和每日上限，最长 24 小时，到期自动失效。
- 用量历史最多保留 7 天/200 个样本，并预测到达安全余量的时间。
- 普通模型限流只冷却“账号 + 模型”；账户/套餐级限流冷却整个账号。
- 冷却最长 7 天，明显异常或过期状态会自动修复。
- 429 不计入 Provider 熔断；网络错误、408 和 5xx 由 Provider 熔断器处理。
- 实际请求与手动 ping 都更新 Provider 健康记录；客户端主动取消不会计为上游故障。
- Provider 与账号事件保留 7 天，按 1h/24h/7d 计算成功率、429 和 P95；熔断开启与账号切换使用独立运维事件统计。
- 自动诊断把账号状态、每日策略、Provider 健康、熔断和 HTTP 错误指南合并为可执行结论。
- `recordUsage` 使用 `model-prices.json` 为每次完成请求增加估算成本，并累计到 Provider、模型和北京时间自然日。
- 价格目录只影响本地估算和预算，不读取真实账单；Relay 与 OpenAI-over-Relay 按实际 Provider 归集。

## 持久化与安全

- `codex-proxy-config.json` 和统计文件使用临时文件、`fsync`、`rename` 原子写入。
- Windows 首次启动生成随机 AES-256-GCM 数据密钥，再由当前用户 DPAPI 保护；配置和账号备份中的 Token/API Key 只落盘密文。
- 设置快照不包含账号、Token 或 API Key；回滚只恢复模型、端点和路由设置。
- 账号删除和恢复前创建独立加密备份；恢复只补回缺失账号，不覆盖当前有效 Token。
- 安装目录 ACL 仅允许当前用户、SYSTEM 和 Administrators。
- 管理写接口要求回环地址，并校验 localhost Host/Origin。
- 请求日志脱敏 Authorization、API Key、Refresh Token 和 JWT，并按 10 MiB 轮转。
- 启动器强制启用 TLS 证书校验。
- 诊断报告不包含 Token、API Key、账号标签或邮箱。

## 存活、就绪与恢复

| 接口 | 含义 |
|---|---|
| `/live` | Node 进程能够响应 |
| `/ready` | 至少有一个已配置上游 |
| `/health` | 向后兼容的 `/ready` |

全局实例锁位于 `%USERPROFILE%\.codex-proxy-instance.json`，防止工作区和安装目录
同时监听端口。收到 `SIGTERM` 后服务停止接收新请求，最长等待约 5 分钟完成现有
连接；Watchdog 使用 `/live` 检测并启动新实例。

## 版本一致性与安全部署

- `runtime-files.json` 是安装器、运行树对比和更新脚本共享的唯一文件清单，运行数据不在其中。
- 安装器和更新脚本生成 `.release-manifest.json`，记录版本、Commit、来源目录、部署时间和逐文件 SHA-256。
- `src/runtime-info.js` 在运行时报告真实入口、PID、启动时间和角色，并逐文件比较工作区与安装目录。
- `update-codex-proxy.ps1` 先备份变化文件，再原子部署并请求优雅重启。
- 部署健康门禁同时校验 `/live`、实际运行路径、Commit 和文件同步状态；任一失败即恢复文件及旧 manifest，并重启旧副本。
- `.last-deployment.json` 记录最近成功或回滚结果，便于后台和脱敏诊断展示。
- 官方登录前分别探测每个 Codex 候选的 `--version` 与 `app-server --help`，同时检查私密浏览器；不再把仅输出 Node.js 版本的损坏 npm 启动器当作可用 CLI。

## 管理与诊断接口

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/admin/api/diagnostics` | 脱敏运行诊断 |
| `GET` | `/admin/api/diagnosis` | 实时自动诊断、趋势和上下文操作 |
| `GET/PUT` | `/admin/api/prices` | 查询/更新本地模型价格目录 |
| `GET` | `/admin/api/costs` | 成本汇总和预算状态 |
| `GET` | `/admin/api/runtime-info` | 运行版本、路径和部署一致性 |
| `POST` | `/admin/api/deploy-update` | 启动本机安全部署流程 |
| `GET` | `/admin/api/chatgpt-login/preflight` | CLI、OAuth app-server 与浏览器预检 |
| `GET` | `/admin/api/config-snapshots` | 配置快照列表 |
| `POST` | `/admin/api/config-rollback` | 回滚快照 |
| `GET` | `/admin/api/account-backups` | 加密账号备份列表 |
| `POST` | `/admin/api/account-backups/restore` | 合并恢复缺失账号 |
| `GET` | `/admin/api/resilience` | Provider 熔断状态 |
| `DELETE` | `/admin/api/resilience` | 重置 Provider 熔断状态 |
| `POST` | `/admin/api/runtime-repair` | 修复异常冷却/租约 |
| `POST` | `/admin/api/proxy/restart` | 优雅重启 |
| `GET/DELETE` | `/admin/api/stats` | 查询/清空统计 |

## 验证

```powershell
npm test
npm run check
git diff --check

Invoke-RestMethod http://127.0.0.1:47892/live
Invoke-RestMethod http://127.0.0.1:47892/ready
Invoke-RestMethod http://127.0.0.1:47892/admin/api/diagnostics
```

自动化测试使用本地 mock，不消耗真实模型额度。
