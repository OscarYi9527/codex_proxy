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

### Changed

- 根入口支持 standalone（默认）与 Edge 显式模式，发布门禁扩展为 Gateway、React、
  隔离脚本测试及两个生产构建。
- Node.js 工程基线调整为 22.19 及以上，以匹配 Vite 7 和 Gateway 工具链。

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
