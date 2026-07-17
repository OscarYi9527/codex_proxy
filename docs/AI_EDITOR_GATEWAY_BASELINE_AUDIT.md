# AI Editor Gateway 基线审计（T001）

审计日期：2026-07-16
Black 仓库：`OscarYi9527/codex_proxy`
审计分支：`feature/custom-api-urls`
审计基线：`e3ed1d626c51ac127bd193672849d3e52ec6baf9`
审计时接口来源：`My_Code@788f3921/specs/002-ai-editor-account-gateway/contracts/`

当前接口事实来源已更新为：
`My_Code@dca68160b25cee78b2c231c4fbd8398624ab93ff/specs/002-ai-editor-account-gateway/contracts/`。

## 1. 基线结论

`feature/custom-api-urls@e3ed1d6` 可以作为 Gateway 的**堆叠开发基线**，不能从旧
`master@06cd8d5` 或其他旧提交重新开发。

当前 `origin/master` 与该分支已经双向分叉：

```text
origin/master 独有：5 个提交
feature/custom-api-urls 独有：12 个提交
共同基线：16b158b
```

因此当前不适合未经审查直接合并 master。Gateway 第一轮应从 `e3ed1d6` 创建
`feature/ai-editor-account-gateway`，并明确它依赖 `feature/custom-api-urls`；master
上的运行数据分离、Turn 转发状态、macOS 浏览器和账号级熔断变更需要另行逐项协调。

## 2. 验证结果

在基线分支执行：

```text
npm test             94/94 通过
npm run check        通过
npm run release:check 通过
```

发布门禁覆盖 JavaScript/PowerShell 语法、运行文件清单、版本一致性、测试和
`git diff --check`。

### 已发现的基线问题

重复运行测试时曾出现统计文件原子替换 `EPERM` 警告。测试最终通过，但说明多个 Node
测试文件仍可能并行访问仓库根目录的 `codex-proxy-stats.json`。Gateway 开发必须在
T005/T006/T020 中引入隔离数据根目录，并让测试使用临时目录，不能继续共享真实运行
数据文件。

## 3. 可直接复用的现有模块

| 现有模块 | 对应新任务 | 复用结论 | Gateway 需要修改 |
|---|---|---|---|
| `src/routes/chatgpt-sub.js` | T044、T086 | 可复用 Provider 调用和账号轮换 | 包装为 Gateway-owned credential adapter，禁止 Edge 直接调用 |
| `src/routes/openai-api.js` | T044、T086 | 可复用 Responses/Chat Completions | 从 Gateway Provider repository 注入凭据 |
| `src/routes/deepseek.js` | T044、T086 | 可复用协议转换和流式处理 | 接入中央路由与结算生命周期 |
| `src/routes/relay.js` | T044、T086 | 可复用兼容中转逻辑 | 接入 Level 1 管理和中央凭据边界 |
| `src/chatgpt-accounts.js` | T044、T086 | 可复用 Token、额度、冷却、并发和账号选择 | 从单机 JSON 账号池改为 Gateway repository/adapter |
| `src/models.js` | T045 | 可复用模型分类和目录输出 | 增加组织/账号/模型授权过滤 |
| `src/smart-routing.js` | T043–T046、T085 | 可复用显式回退和虚拟模型评分 | 增加产品账号预检、积分风险和中央策略 |
| `src/circuit-breaker.js` | T082、T085–T087 | 可复用熔断和半开恢复 | 按 Gateway Provider/账号作用域持久化和授权展示 |
| `src/provider-health.js` | T082、T087 | 可复用健康、延迟和错误记录 | 改为中央数据层并增加角色过滤 |
| `src/diagnostics.js`、`src/error-guide.js` | T082、T087 | 可复用安全诊断和错误说明 | 普通用户只返回脱敏状态，详细信息仅 Level 1 |
| `src/pricing.js`、`src/cost-governance.js` | T073–T080、T085 | 可复用价格和成本估算 | 不能直接等同产品积分；需独立倍率、风险和结算模型 |
| `src/logger.js` | T010、T011、T109 | 可复用 secret redaction | 迁移到结构化 Gateway logger，并补 DB/API/export 扫描 |
| `src/server-utils.js` | T009–T011、T046 | 可复用 request ID、JSON 限制、重试和流式元数据 | 注入 clock/ID，统一 safe error 合同 |
| `src/config.js`、`src/migrations.js` | T005、T006、T012–T015 | 可复用原子写、备份和迁移原则 | Gateway 正式数据必须迁移到 Kysely + SQLite/PostgreSQL |
| `src/credential-store.js` | T026、T032、T084、T089 | Windows DPAPI 代码可参考 | Edge 只存产品 Refresh Token；Gateway 凭据建立独立策略 |
| `src/admin/`、`src/admin_modules/` | T050、T054–T055、T062、T072、T083、T088 | 页面信息架构和操作流程可参考 | 新管理端必须是 React、HttpOnly session、服务端 RBAC |
| `src/runtime-info.js`、更新脚本 | T007、T020、T111、T120 | 可复用运行版本、部署、回滚和健康门禁 | 创建 47920/47921 隔离启动器，不接触共享 47892 |

这些模块“可复用”不代表对应新任务已经完成；新任务包含数据库、身份、组织作用域、
产品积分、角色授权或 Edge/Gateway 边界时仍必须重新实现合同和测试。

## 4. Black 任务覆盖矩阵

状态说明：

- **完成**：当前基线已满足任务合同并有测试证据。
- **部分复用**：存在可复用模块，但新任务本身尚未完成。
- **缺失**：当前仓库没有目标实现。

| 任务范围 | 状态 | 审计结论 |
|---|---|---|
| T001 | 完成 | 本文完成模块、任务、复用、缺口、测试和隔离规则审计 |
| T002–T007 | 缺失 | 没有 Gateway TS、React/Vite、Jest、隔离配置和 47920/47921 脚本 |
| T009–T011 | 部分复用 | 已有 request ID、错误响应和日志脱敏；缺可注入 clock/ID/digest 与统一 Gateway safe error |
| T012–T017 | 缺失 | 没有 Kysely、SQLite/PostgreSQL、Fastify 和 Gateway 中间件 |
| T018–T021 | 部分复用 | standalone 当前可运行且有单实例/健康/安全更新；缺显式三模式和隔离数据根测试 |
| T023–T026 | 部分复用 | DPAPI、登录输出解析可参考；产品 PKCE、授权码、Token family 和 Edge handoff 均缺失 |
| T028–T033 | 缺失 | 产品账号 repository、Argon2id、PKCE、滚动 Refresh Token、Edge 绑定/交接均缺失 |
| T038–T040 | 缺失 | 没有 Edge/Gateway 合同、绑定切换和身份捕获测试 |
| T041–T043 | 缺失 | 没有 Edge Server、Gateway client 或产品账号/组织/模型预检 |
| T044–T046 | 部分复用 | 现有 Provider、模型和 streaming 可作为 adapter 底层；Gateway 生命周期尚未建立 |
| T049–T050 | 缺失 | 没有 Webview ticket、HttpOnly 管理 session 或 React shell 测试 |
| T052–T055 | 缺失 | 没有 Edge 安全状态、React 管理壳和普通用户产品账号页面 |
| T060–T068 | 缺失 | 没有组织、两级管理员、邀请码、作用域和最后 Level 1 保护 |
| T069–T080 | 部分复用 | 有上游成本估算；产品积分周期、倍率、Turn 风险、幂等预留/结算均缺失 |
| T081–T083 | 部分复用 | 已有凭据遮罩、诊断和 DOM 测试；缺 Level 1 API/UI 角色合同 |
| T084–T089 | 部分复用 | Provider 调用、路由和管理能力存在；缺中央 repository、RBAC 和 plaintext-v1 启动门禁 |
| T091–T098 | 缺失 | 没有产品密码生命周期、设备会话和 Edge 产品账号安全删除 |
| T100–T108 | 缺失 | 没有会话正文抽取、组织审计、保留期和审计页面 |
| T109 | 部分复用 | 有日志/配置脱敏测试；缺数据库、API、导出夹具的完整 secret scan |
| T111 | 部分完成 | standalone 94 项测试和 release gate 通过；Gateway/admin 套件尚未建立 |
| T120 | 部分完成 | 现有架构、安全、部署文档完整；需随 Gateway/Edge 实现持续更新 |

Oscar 负责的 T008、T022、T027、T034–T037、T047–T048、T051、T056–T059、
T090、T099、T110、T114–T119 不在本仓库实现。T112/T113 由双方共同验收。

## 5. 第一轮实现顺序

Black 当前不应立即开始账号、积分或 Provider 重写。正确顺序是：

1. 从 `e3ed1d6` 创建堆叠分支 `feature/ai-editor-account-gateway`。
2. 先实现 T002–T007：Gateway/React/test/config/隔离脚本骨架。
3. 实现 T009–T021 的最小基础设施和三模式，不改变 standalone 默认行为。
4. 按合同提供最小 Mock：
   - `GET /ai-editor/status`
   - `POST /ai-editor/status/retry`
   - `POST /ai-editor/handoff/start`
   - `POST /ai-editor/handoff/complete`
   - `POST /ai-editor/webview-ticket`
   - `POST /ai-editor/logout`
   - `GET /v1/models`
5. 将分支、SHA、启动命令、Mock 状态切换方式、测试结果和迁移说明交给 Oscar。

第一轮禁止读取、复制、停止或重启共享 `127.0.0.1:47892` 的账号、配置和运行数据。
