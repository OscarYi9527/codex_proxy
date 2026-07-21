# Codex Proxy 下一阶段开发需求深挖与路线图

> 实际执行状态、依赖和验收证据统一维护在
> [`DEVELOPMENT_EXECUTION_PLAN.md`](DEVELOPMENT_EXECUTION_PLAN.md)；本文保留需求背景和设计细节。

日期：2026-07-21<br>
审计基线：`feature/ai-editor-account-gateway@c75dcd9`<br>
适用范围：standalone 账号池、AI Editor Gateway/Edge、React 管理端、运维与安全门禁

## 1. 结论摘要

下一阶段不应继续堆叠零散页面功能，而应先补齐四条主链路：

1. **standalone 大号池治理正在从“同步 HTTP 请求 + 整份 JSON 重写”升级为完整健康状态机。**
   N001/N002 已完成可恢复任务、进度/取消 API 和每批一次的账号 patch；下一步是 N003/N004
   的连续失败、置信度、恢复状态机和 usage/reset-credit 四态语义。
2. **Gateway 的积分、Turn 风险和结算是当前最大的产品功能缺口。**
   数据表已经存在，但请求预检只验证登录、设备、Turn ID 和模型；Responses 完成后没有
   风险释放、实际/估算用量落库或幂等结算。管理页面显示的积分仍是固定零值。
3. **Gateway 生产化仍被 `plaintext-v1` Provider 凭据阻塞。**
   当前策略会拒绝在 production 或非回环地址启动明文凭据，这是正确的 fail-closed 行为；
   但在 `envelope-v1`、主密钥轮换和迁移工具完成前，Gateway 不能视为可生产部署。
4. **组织/RBAC 和审计保留必须与积分结算一起完成，而不是只补页面。**
   Level-2 的组织用户、邀请码页面仍是占位；跨组织强制 `403`、最后一个 Level-1 保护、
   管理员正文查看审计和正文到期清理尚未形成完整服务层。

建议按“standalone 运维加固 → Gateway 安全阻塞项 → 组织与积分事务 → 中央账号池迁移 →
真实联合验收”的顺序推进。

## 2. 本次审计证据

| 发现 | 代码证据 | 影响 |
|---|---|---|
| 全账号检查曾是同步长请求（N001 已修复） | `POST /admin/api/chatgpt-accounts/check-all` 现创建持久化任务 | 当前可查询进度、取消，并从最后提交批次恢复 |
| 账号状态曾多次重写整份配置（N002 已修复） | `JsonAccountStore` 捕获 patch，每 20 个账号 flush | 当前每批最多一次敏感配置写入，并保留并发更新字段 |
| 状态只有最后一次快照 | 每账号仅保存一个 `health_check` | 无法判断连续失败次数、首次发生时间、恢复趋势和自动处置置信度 |
| 用量与重置次数已能独立同步 | `refreshAccountQuotaSnapshot()` 分别保存 usage/reset-credit 成功与错误 | 基础语义正确，下一步需要“不支持/失败/陈旧”三态和独立调度周期 |
| Gateway 积分仍为占位 | `AccountService.status()`、`me()` 返回固定 `0.000000` | 前端显示不代表真实可用余额 |
| Turn 没有风险预留 | `RequestPreflight.verify()` 只检查身份、设备、Turn ID、模型 | 并发请求可能在未来接入结算时透支或重复扣费 |
| Responses 没有结算 hook | `ResponsesGateway.handle()` 直接转发 adapter | 客户端断开、上游完成、估算用量和重试尚未进入统一事务 |
| 积分/风险表尚无业务 repository | `organization_credit_periods`、`user_credit_allocations`、`risk_policies`、`turn_risks` 仅在 schema/migration 出现 | 数据模型已预留，但核心服务未实现 |
| 组织管理页面仍是占位 | React `PlaceholderPage` 覆盖 `organization`、`invitations` | Level-2 管理闭环未形成 |
| Provider 凭据只能明文开发 | `ProviderService.addCredential()` 固定写入 `plaintext-v1` | production/non-loopback 启动被安全策略拒绝 |
| Gateway 仍复用进程内 standalone adapter | `StandaloneRouteAdapter` 动态导入 `src/server.js` 并复制 `chatgptAccounts` | 新增的分级、健康和账号历史没有中央数据库边界 |
| Gateway 测试分支覆盖率不足 | 2026-07-21：statements 88.80%，branches 70.23%；`account-usage-routes`、`management-shell`、登录异常分支偏低 | “新增代码覆盖率 80%”若包含分支覆盖率，当前尚未达标 |
| 审计时开发 shell 继承了禁用 TLS 的环境变量（N006 已修复） | Gateway/Edge 配置、开发脚本和发布门禁均显式保护 TLS 校验 | 禁用证书验证时启动/发布检查 fail-closed |

## 3. P0：standalone 大号池运维加固

### N001：异步账号检查任务

将同步 `check-all` 演进为任务 API：

```text
POST   /admin/api/chatgpt-accounts/check-all
GET    /admin/api/chatgpt-accounts/check-tasks
GET    /admin/api/chatgpt-accounts/check-tasks/:taskId
POST   /admin/api/chatgpt-accounts/check-tasks/:taskId/cancel
POST   /admin/api/chatgpt-accounts/check-tasks/:taskId/resume
```

要求：

- 创建任务后立即返回 `202 + jobId`，前端显示总数、已完成、各状态数量和当前账号。
- 默认并发 2，允许配置 1–4；账号之间加入抖动，遵循 Retry-After 和全局退避。
- 同一账号检查使用 singleflight；同一时间只允许一个全池任务。
- 浏览器关闭不取消后台任务；重启后任务标记为 `interrupted`，可重新执行未完成账号。
- 结果不保存上游原始正文，只保存规范化状态、HTTP 状态、错误码和安全原因。

验收：300 个模拟账号可查看进度、取消、恢复；超时账号不会阻塞整个任务；不泄露 Token。

状态：**已完成**。默认并发 2，可通过受限环境变量配置为 1–4；任务包含账号级总超时和
账号间抖动，进程重启后自动恢复最近的中断任务。

### N002：批量账号持久化与写合并

新增 `AccountStore` 边界，至少支持：

- `patchAccount(id, patch)`
- `patchMany([{ id, patch }])`
- `appendHealthEvents(events)`
- `flush()` 或单事务提交

短期可继续使用加密 JSON，但一次任务最多在批次检查点写一次；中期迁移到 SQLite。
禁止每个状态字段更新都重新加载整份配置。账号凭据与高频健康状态应拆分存储，避免健康
写入扩大敏感配置备份和加密开销。

验收：全池检查的配置写次数从“每账号多次”降到“每批次一次”；崩溃注入测试不会产生
半写 JSON、丢账号或回退旧 Token。

状态：**已完成**。`JsonAccountStore` 已实现 `patchAccount`、`patchMany`、
`appendHealthEvents`、`captureAccount` 和 `flush`；全账号检查及全池用量/重置次数同步
均按最多 20 个账号提交，字段级 patch 不会回退并发改名或 Refresh Token 轮换。

### N003：健康状态机、证据与恢复

在最后一次 `health_check` 之外保存最近健康事件：

- `state`、`source`、`first_seen_at`、`last_seen_at`、`consecutive_failures`
- `http_status`、安全 `error_code`、`retry_at`
- `probe_scope`：凭据、用量、重置次数、实际模型请求
- `confidence`：明确上游封禁为 high；普通 403 为 medium；网络错误不能推断封禁

自动处置规则：

- 明确封禁、Refresh Token 永久失效、OAuth 不兼容可立即停止调度。
- 网络/5xx 只有连续失败达到阈值才进入隔离，成功一次即恢复。
- 429 按 Retry-After 冷却；额度为 0 按额度窗口恢复时间处理。
- 自动处置不物理删除账号；所有恢复、隔离和弃号操作写安全审计。

### N004：额度与重置次数同步语义

分别持久化：

- `usage_status/updated_at/error`
- `reset_credit_status/updated_at/error`
- `unsupported`、`stale`、`failed`、`synced`

重置次数端点不是所有套餐都支持，`404/特定 403` 应标记为“不支持”，不能长期显示成
账号故障。当前账号 5 分钟只刷新 usage；全池低频任务按独立周期刷新 reset-credit。

### N005：批量管理和通知

- 导入批次 ID、来源、标签、采购/到期日期和负责人。
- 支持按批次启用、隔离、归档和安全删除；删除前生成独立加密备份。
- 对稳定池不可用、日抛池即将耗尽、疑似封禁、重置 7 天未恢复提供桌面或 Webhook 通知。
- 通知只包含本地标签和规范化原因，不包含邮箱、Token 或上游响应正文。

## 4. P0：Gateway 生产安全阻塞项

### N006：强制 TLS 校验

- `tools/start-ai-editor-dev.ps1` 为 Gateway 和 Edge 显式设置
  `NODE_TLS_REJECT_UNAUTHORIZED=1`。
- production 启动发现值为 `0` 时直接拒绝；development 至少输出醒目错误并要求清理。
- `release:check` 增加环境合同测试；自定义 CA 只能使用 `NODE_EXTRA_CA_CERTS`。

### N007：Provider `envelope-v1`

- Gateway 主密钥不进入数据库；支持 Windows DPAPI、macOS Keychain，以及服务端环境密钥
  或 KMS adapter。
- 数据库只保存 AES-256-GCM 信封：key id、nonce、ciphertext、tag、algorithm version。
- 新增明文到信封的单次迁移、回滚和校验工具；迁移过程不把秘密写入日志或命令行。
- 支持主密钥轮换、逐凭据重包和旧 key id 审计。
- production 彻底禁止新建 `plaintext-v1`。

### N008：全链路 secret scan

覆盖 Git staged diff、数据库夹具、API 响应、诊断导出、日志、错误对象和备份。至少扫描：

- JWT、Access/Refresh Token、API Key、Authorization
- `redeem_request_id`
- Provider `secret_payload`
- OAuth 授权码、Webview ticket、Edge nonce

## 5. P0：组织、权限、积分和幂等结算

### N009：组织与角色管理

- Level-1：组织 CRUD、Level-2 任命、全局 Provider 和系统诊断。
- Level-2：仅管理自己组织的用户、邀请码、积分分配和保留期。
- User：只读取自己的账号、设备、积分和用量。
- 所有 repository 查询必须显式携带 `organization_id`；跨组织统一返回 `403`。
- 禁止删除或降级最后一个有效 Level-1；角色/组织变更递增账号版本并立即使旧管理会话失效。

### N010：积分周期与分配

- 组织月度积分池按明确时区创建，周期唯一键防止重复。
- 用户分配不能超过组织可分配余额；月底清零通过新周期完成，不改写历史。
- 所有金额使用定点 decimal，不使用浮点数。
- `AccountService.status/me` 改为读取真实 period/allocation，不再返回固定零值。

### N011：Turn 风险预留

请求进入 Provider 前，在数据库事务中：

1. 校验产品账号、组织、模型路由和积分周期。
2. 以 `turn_id` 幂等创建 `turn_risks`。
3. 计算最大风险积分并占用；超过用户/组织可用额度时拒绝新 Turn。
4. 同一 `turn_id` 重试返回原预留结果，不重复占用。
5. 并发事务使用行锁、条件更新或等价机制，SQLite/PostgreSQL 语义必须一致。

### N012：用量结算与对账

- 优先使用上游真实 Token；缺失时使用明确标记的保守估算。
- 每个 `turn_id` 只能生成一个 `usage_record`，结算和风险释放在同一事务完成。
- 客户端断开不取消已被上游接受的 Turn；后台继续接收完成事件并结算。
- 上游结果未知时进入 `reconcile_pending`，由对账 worker 重试，不能立即重复扣费。
- 失败且确认未消耗上游资源时释放全部预留。
- 模型倍率和价格版本必须随 usage 记录冻结，历史账单不受后续价格更新影响。

验收重点：100 个并发 Turn、重复 Turn ID、断连、Gateway 重启、上游无 usage、事务死锁/
busy、对账重放均不重复扣费。

## 6. P1：中央账号池与 Provider 治理

### N013：将 ChatGPT 账号池迁入 Gateway repository

当前 Gateway 把数据库 Provider 配置转换成 standalone 内存配置。下一步应建立规范化账号表：

- 凭据引用、账号 ID、计划、分级、路由权重、安全余量、临时到期时间
- usage/reset-credit 快照和独立同步状态
- health state/events、冷却、弃号生命周期
- 导入批次、标签和审计字段

Gateway 成为 source of truth；adapter 只接收不可变请求快照，不得直接修改中央账号记录。
standalone 保持兼容，但新能力通过统一 `AccountPoolRepository` 和 `AccountHealthService` 实现。

### N014：Provider/账号健康任务

- Provider 连通性和账号凭据检查分开，避免把共享网络故障误判为所有账号封禁。
- 引入探测层级：DNS/TLS、Provider 端点、账号 usage、可选模型 canary。
- 模型 canary 默认关闭，开启时必须提示可能消耗额度。
- 记录 egress/区域和代理配置摘要，但不得记录可用于规避平台风控的设备指纹。

### N015：动态路由版本与在途快照

- Provider/模型/账号配置发布形成单调递增版本。
- 每个 Turn 捕获 route version、provider、credential/account 引用和价格版本。
- 删除或切换配置只影响新 Turn；在途 Turn 继续使用已捕获快照并完成结算。

## 7. P1：审计、保留与管理页面

### N016：管理审计闭环

对以下操作记录 allowed/denied/failed：

- 角色提升、跨组织访问、最后 Level-1 保护
- Provider/凭据/模型变更
- 账号导入、隔离、恢复、弃号和删除
- 积分分配、风险策略、手工对账
- 管理员查看会话正文

审计元数据必须白名单化，禁止保存 Token、系统提示词、文件正文和工具输出。

### N017：会话正文与保留

- 只保存用户提问、最终回复、模型、时间、Token、积分和必要错误分类。
- 禁止保存系统提示词、思维过程、文件原文、完整请求、工具参数/输出和凭据。
- 默认保留 30 天，组织可配 7–180 天。
- 到期任务删除正文、保留匿名统计；删除任务可重入并有审计证据。

### N018：补齐 React 页面

按 API 完成顺序实现组织、邀请码、积分分配、风险策略、审计和保留页面。页面不能先于
服务端权限和事务规则上线；所有危险操作需要目标确认、幂等键和可恢复错误状态。

## 8. P1：测试和联合验收

### N019：覆盖率门禁

- Gateway statements/lines/functions/branches 均不低于 80%。
- 优先补 `account-usage-routes`、`management-shell`、ChatGPT 登录异常、PostgreSQL 分支。
- standalone 新账号任务增加 300 账号、写入故障、取消、重启恢复和 secret scan 测试。

### N020：真实联合验收

- T047/T048：真实订阅和非订阅 Provider 的模型/Responses 验收。
- T090：Oscar 在 Code 端刷新真实模型目录。
- T112/T113：Edge/Gateway/Code 在隔离端口完成登录、Turn、断连、结算和管理页端到端。
- 所有验收记录分支、SHA、数据迁移、启动命令、测试账号类型和脱敏结果。

## 9. P2：路由和分析优化

- **N021 探索流量**：为 `latency/reliable` 注入小比例、有上限的探索，避免新账号永远无样本。
- **N022 容量预测**：结合额度恢复、消耗速率、稳定/日抛分级和并发，预测可服务时长。
- **N023 时间序列与导出**：按账号/Provider 导出脱敏健康、额度和成本趋势。
- **N024 通知策略**：支持去重、静默时间、恢复通知和升级策略，避免同一故障重复轰炸。

## 10. 推荐交付顺序

| 迭代 | 目标 | 关键交付 |
|---|---|---|
| A | 大号池稳定性 | N001–N004：任务化检查、批量持久化、健康事件、同步三态 |
| B | 生产安全 | N006–N008：TLS fail-closed、envelope-v1、secret scan |
| C | 组织权限 | N009、N016：组织/RBAC、最后 Level-1、管理审计 |
| D | 积分事务 | N010–N012：周期、预留、幂等结算、对账 |
| E | 中央账号治理 | N013–N015：Gateway 账号池、健康任务、路由版本快照 |
| F | 产品完成度 | N017–N020：保留、React 页面、覆盖率和真实联合验收 |

每个迭代都必须通过 `npm run release:check`；涉及数据库的迭代还必须在 SQLite 和
PostgreSQL contract 上运行相同事务测试。未完成 N006–N008 前不得把 Gateway 暴露到
非回环地址；未完成 N010–N012 前不得把页面中的积分数字用于真实计费或限额承诺。

## 11. 明确不做

- 不提供验证码代收、设备指纹伪造、账号关联隐藏或平台风控规避。
- 不因为探测失败自动物理删除账号。
- 不把“usage 端点可访问”宣传为所有模型一定可用。
- 不在 Edge 保存中央 Provider 凭据或 ChatGPT Refresh Token。
- 不以 mock/fake adapter 测试替代真实 Provider、并发结算和跨进程恢复验收。
