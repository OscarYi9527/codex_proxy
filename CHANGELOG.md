# Changelog

本项目遵循语义化版本。日期使用北京时间。

## [Unreleased]

### Added

- 新增隔离的 TypeScript/Fastify Gateway、React/Vite 管理页面骨架，以及 Kysely
  SQLite/PostgreSQL 双方言 schema、迁移和 repository contract。
- 新增固定监听 `127.0.0.1:47920/47921` 的 Gateway/Edge 第一轮 Mock，覆盖账号状态、
  状态重试、一次性 handoff、防重放、Webview ticket、退出和安全模型列表。
- 新增 AI Editor 开发启动、停止和确认式重置脚本；强制隔离数据根、PID 归属验证并拒绝
  共享端口 `47892`，启动后执行 `/live` 健康门禁且失败时自动回滚。
- 新增 AI Editor 真实 Authorization Code + PKCE 登录、Argon2id 密码/bootstrap、
  5 分钟 Access Token、滚动 Refresh Token 重放撤销和设备会话。
- 新增 Edge Windows DPAPI/macOS Keychain Refresh Token 存储、单飞刷新、60 秒单次
  handoff、账号切换身份快照，以及真实模型/Responses/Chat Completions 转发。
- 新增 Gateway 动态安全模型目录和现有 Provider 兼容适配器；真实链路测试使用隔离本机
  Relay，明确排除 `gpt-mock`。
- 新增 60 秒一次性 Webview ticket、30 分钟 HttpOnly 管理会话、Origin/CSRF 门禁和
  `/admin` 严格 CSP 管理外壳。
- 新增服务端角色导航，以及普通用户账号、积分、设备与使用记录 React 页面。
- 新增组织、账号角色和邀请码管理 API：Level-2 查询/写入强制限定本组织普通用户，
  跨组织统一 `403` 并审计；角色/组织/状态变化使旧 Access/Webview 会话失效。
- 新增事务化最后有效 Level-1 保护、组织状态串行锁、账号软删除和一次性临时密码；
  邀请码只返回一次明文并以 keyed digest 存储，CAS 消费覆盖并发、过期和禁用组织。
- Gateway/Edge 合同测试开始共同消费 My_Code 的 `edge-code-contract.json` fixture。
- 新增 Level-1 Provider、凭据、模型路由和安全诊断 API，以及 Provider/诊断 React 页面。
- 新增 Gateway 隔离 `CODEX_HOME` 的 OpenAI 官方登录端点；认证临时目录在导入后删除。
- 新增数据库 Relay 配置驱动真实模型目录和 SSE Responses 的非 Mock 集成测试。
- 新增下一阶段开发需求深挖文档，基于代码证据拆分 standalone 大号池任务化、Gateway
  凭据加密、组织/RBAC、Turn 风险、幂等结算、中央账号池和真实联合验收 N001–N024。
- 新增统一开发执行计划表，记录 N001–N024 的优先级、状态、依赖、里程碑、验收证据、
  仓库协作事项和明确延期范围。
- 新增持久化全账号检查任务：管理后台可查询实时进度、关闭窗口后继续执行、协作式取消，
  并从最后提交批次恢复失败/中断任务；代理重启会自动恢复最近的中断任务。
- 新增 `JsonAccountStore` 批量 patch/flush 边界和独立脱敏健康事件 sidecar；300 账号压力、
  取消/恢复、进程中断、单账号超时和写入故障注入均有自动化测试。
- 新增账号健康状态机和历史 API，保存首次/最近发生时间、连续失败、置信度、探测范围、
  冷却/隔离/恢复处置；网络/5xx 连续 3 次才暂停调度，一次成功立即恢复。
- 新增用量与重置次数独立 `synced/stale/unsupported/failed` 四态；重置次数改为独立
  6 小时低频刷新，`404`/明确不支持的 `403` 不再伪装成 0 次或账号故障。
- 新增 ChatGPT 账号文件快捷导入，兼容 auth.json、sub2/CPA JSON 和完整凭据 TXT；
  批量导入默认跳过重复账号并保持“仅保存”状态。
- 新增缺少 ChatGPT Refresh Token 时的批量官方登录队列：本地解析 CPA/sub2/TXT、
  按邮箱或账号 ID 去重、逐个打开隔离 OAuth，并提供不离开浏览器内存的凭据复制辅助。
- 新增 CPA/sub2 短期 Access Token 批量直导：临时账号显示精确到期时间与剩余倒计时，
  到期自动停止路由；账号池支持可续约、临时、24 小时内到期和已失效分类；批次中的
  单个过期 Token 会独立拒绝，不阻断其他有效账号。
- 临时导入新增 OAuth 客户端兼容性校验；能查询额度但不是由 Codex 官方客户端签发的
  Token 会归入“不兼容”分类并强制仅保存，服务端拒绝手动重新启用，避免导入后请求
  持续返回 401。
- 新增账号池用途分级：可续约账号默认进入稳定保险池，临时账号默认进入日抛优先池；
  日抛账号优先使用且安全余量固定为 0，稳定池仅在日抛池不可用时兜底。
- 单账号官方登录、批量官方登录、账号文件导入和手动添加接口均可在账号落库时写入分类；
  单账号登录默认稳定池，CPA/sub2 批量登录默认日抛池，后续可在账号策略中调整。
- 日抛账号周额度归零后启动 7 天恢复观察；额度恢复会自动取消倒计时，连续 7 天未恢复
  则自动关闭路由并归入“已弃号”，保留凭据和历史记录避免自动物理删除。
- 新增“检查所有账号”：通过非消耗式凭据、用量和重置次数检查，逐号区分疑似封禁/停用、
  登录失效、权限不足、额度不足、短时限流、临时不可达、OAuth 不兼容和已弃号。

### Changed

- 官方登录弹窗关闭时会同步取消后台等待会话；重新打开会先清理遗留的 `waiting` 会话，
  避免错误提示“已有一个登录流程正在进行”。登录入口同时忽略文字框选产生的误点击。
- 手动刷新和全池 30 分钟低频同步现在同时更新账号用量与重置次数；两个端点独立记录成功
  或错误，避免额度已更新但剩余重置次数仍无提示地停留在旧值。
- 修复 PowerShell 安装/更新脚本在 `git rev-parse` 经过管道后误读 `$LASTEXITCODE` 的问题；
  发布清单会稳定记录当前 Commit，无变化部署写入空 `changed_files` 而不是 `[null]`。
- 根入口支持 standalone（默认）与 Edge 显式模式，发布门禁扩展为 Gateway、React、
  隔离脚本测试及两个生产构建。
- Node.js 工程基线调整为 22.19 及以上，以匹配 Vite 7 和 Gateway 工具链。
- Gateway Provider 配置、统计、线程路由和健康数据改用隔离存储根，standalone 未设置
  `CODEX_PROXY_STORAGE_ROOT` 时保持原有仓库根行为。
- 真实开发启动会先构建管理 React 页面，再前台执行一次性 bootstrap。
- Gateway 的 `plaintext-v1` 凭据仅允许回环开发；production 或非回环环境存在明文凭据时
  拒绝启动，API 和页面只展示掩码及持续安全警告。
- Gateway/Edge 配置加载对 `NODE_TLS_REJECT_UNAUTHORIZED=0` fail-closed，隔离开发脚本
  显式对子进程启用 TLS 校验，发布门禁拒绝不安全 Shell；自定义 CA 仅通过
  `NODE_EXTRA_CA_CERTS` 接入。
- Gateway 关闭或取消隔离 Codex 官方登录时会等待子进程退出后再删除临时认证目录，
  避免 Windows 文件句柄竞争造成目录残留，并放宽对应进程测试的总超时以消除门禁抖动。
- 全账号检查、全池用量/重置次数同步不再为每个中间状态重写整份敏感配置；状态更新按
  最多 20 个账号合并并每批只提交一次，同时只覆盖任务实际修改的字段，避免回退并发
  发生的账号改名或 Refresh Token 轮换。
- 明确封禁、永久登录失效和 OAuth 不兼容仍立即停止调度；普通 `403` 改为中等置信度的
  15 分钟权限复核，避免把套餐、地区或临时权限问题误判为封号。

## [2.4.1] - 2026-07-15

### Added

- 配置与统计文档 schema 迁移；迁移幂等、保留未知字段，并在写回前保存原始备份。
- 前端 DOM 行为测试覆盖额度重置按钮、重复提交、最终确认、错误码搜索和登录轮询。
- `npm run release:check` 与 GitHub Actions 发布门禁，统一检查版本、运行清单、语法、测试和空白错误。

### Changed

- 账号池、新手教程、用量分析和设置页面拆分到 `src/admin_modules/`。
- 登录、账号、诊断和运维接口拆分到 `src/admin/`，`src/admin.js` 仅保留聚合与基础配置接口。
- 原单体测试文件按核心路由、账号治理、韧性和管理 API 拆分。

## [2.4.0] - 2026-07-15

### Added

- 默认关闭、需用户显式开启的请求级跨 Provider 回退链；401/402/403 和参数错误禁止盲目回退。
- `auto`、`auto-fast`、`auto-cheap`、`auto-reliable` 四个虚拟模型。
- 可更新的本地模型价格目录，以及请求、今日、月度和累计成本估算。
- API 与中转线路日/月预算门禁，支持达到预算后回退或停止。
- `GET/PUT /admin/api/prices` 与 `GET /admin/api/costs` 管理接口。

### Fixed

- OpenAI API 由中转节点承载时，流式与非流式用量现在归入实际 Relay Provider。
- DeepSeek Chat Completions 流式请求现在记录 Token 与成本。

## [2.3.1] - 2026-07-15

### Added

- 自动诊断中心结合 HTTP 状态、错误类型、Provider 与账号池实时状态生成具体结论。
- 诊断中心提供刷新额度、重新登录、等待冷却、查看队列与检测 Provider 等上下文操作。
- Provider 和账号健康增加 1h、24h、7d 窗口、P95/429 趋势预警。
- 新增账号切换和熔断开启事件统计，按 1h、24h、7d 汇总。

## [2.3.0] - 2026-07-15

### Added

- 每账号独立安全余量和每日请求/Token 上限。
- 按模型或会话 ID 预留专用账号；匹配请求优先使用预留账号。
- 带风险勾选、最终确认和最长 24 小时自动恢复的“紧急继续使用”。
- 账号健康统计扩展为 1h、24h、7d 三个窗口。
- 账号池 503 诊断增加每日上限、专用预留和紧急继续分类。

## [2.2.1] - 2026-07-15

### Added

- 管理后台显示真实运行路径、入口、版本、Commit、启动时间、PID，以及工作区与安装目录逐文件一致性。
- 新增基于统一运行清单的安全更新脚本：变更备份、原子部署、优雅重启、健康门禁和失败自动回滚。
- 新增官方登录预检，验证全局与 VS Code 内置 Codex CLI、`app-server` OAuth 能力和私密浏览器。
- 补齐账号轮换测试矩阵与账号池耗尽的机器可读 503 诊断分类。

### Fixed

- 全局 npm Codex 损坏或只输出 `Node.js v...` 时，不再误判为可用登录入口。
- Provider 半开探测被取消或异常结束后可超时接管，不再永久卡死。

### Security

- 部署接口仅允许本机管理请求；运行数据、凭据、统计与日志不进入部署文件清单。
- 登录诊断和运行诊断不返回 Token、API Key 或账号邮箱。
