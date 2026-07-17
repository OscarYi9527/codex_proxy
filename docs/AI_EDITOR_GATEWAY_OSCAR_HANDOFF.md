# AI Editor Gateway 第一轮 Mock 交接给 Oscar

> 历史文档：本页只描述第一轮 Mock 基线。真实认证与模型链路请使用
> [AI_EDITOR_GATEWAY_REAL_AUTH_RESPONSES_HANDOFF.md](AI_EDITOR_GATEWAY_REAL_AUTH_RESPONSES_HANDOFF.md)；
> 当前合同事实来源为
> `My_Code@dca68160b25cee78b2c231c4fbd8398624ab93ff/specs/002-ai-editor-account-gateway/contracts/`。

## 1. 交付坐标

Black 已完成 Proxy 侧 T002–T007、T009–T021 和第一轮 Mock。

```text
仓库：  OscarYi9527/codex_proxy
分支：  feature/ai-editor-account-gateway
提交：  84ab6445bb4b557dc379815776bcd784f34676c1
依赖：  feature/custom-api-urls@e3ed1d6
合同：  My_Code@dca68160b/specs/002-ai-editor-account-gateway/contracts/
```

这是堆叠分支，尚不能脱离 `feature/custom-api-urls` 单独合并。两个仓库没有共同 Git
历史，不合并仓库根目录。

## 2. Black 已完成的改动

### 工程基础

- 创建 `gateway/` TypeScript/Fastify workspace。
- 创建 `gateway/admin-web/` React/Vite workspace。
- 建立 Gateway 与管理页面 Jest/ts-jest、TypeScript 检查和生产构建。
- 固定成熟依赖版本，并保持 `npm audit` 为 0 漏洞。
- 忽略数据库、PID、日志、构建产物、密钥和 `.ai-editor-dev/` 隔离运行数据。

### 公共服务和数据库边界

- 提供可注入 clock、ID source、HMAC-SHA256 keyed digest。
- 提供稳定安全错误、request ID、深层密钥脱敏和结构化安全日志。
- 提供 Kysely SQLite/PostgreSQL 双方言工厂和统一 `inTransaction` 事务边界。
- 初始迁移包含合同数据模型中的 Gateway 持久化实体。
- SQLite 开启 WAL、外键和 5 秒 busy timeout；PostgreSQL 使用 `pg.Pool`。
- 双方言 repository contract 覆盖迁移、读写、提交和事务异常传播。

### 隔离运行和安全保护

```text
Gateway：127.0.0.1:47920
Edge：   127.0.0.1:47921
共享：   127.0.0.1:47892（禁止开发任务修改）
数据根： codex_proxy/.ai-editor-dev/
```

- standalone 仍是默认模式，新增显式 edge/gateway 模式。
- 开发配置拒绝公开监听、非固定端口、共享端口和非隔离数据根。
- Edge 校验 loopback socket、Host、Origin 和随机本机 nonce。
- 启动脚本验证端口和 PID 槽，等待 `/live` 返回正确模式后才成功。
- 任一服务启动失败时，按相反顺序回滚本次已启动进程。
- 停止脚本验证 PID 命令属于当前仓库，并先停止子进程。
- 重置脚本要求规范化路径完全相同、`-Force` 和隔离根标记同时满足。

### 第一轮 Mock 接口

Edge 地址为 `http://127.0.0.1:47921`：

```http
GET  /ai-editor/status
POST /ai-editor/status/retry
POST /ai-editor/handoff/start
POST /ai-editor/handoff/complete
POST /ai-editor/webview-ticket
POST /ai-editor/logout
GET  /v1/models
```

已实现的 Mock 状态：

```text
ready
login_required
account_unavailable
service_unavailable
password_change_required
```

`/ai-editor/*` 必须携带 `X-AI-Editor-Local-Nonce`。handoff grant 仅存在于内存，
60 秒过期且只能消费一次；重放返回 `handoff_invalid`。所有账号相关响应均使用
`Cache-Control: no-store`，不返回 Provider、凭据、账号池、熔断和成本信息。

### 验证结果

- standalone/Edge：100 项测试通过。
- Gateway：16 项测试通过。
- React 管理页面：1 项测试通过。
- Gateway 和 React 生产构建通过。
- PowerShell 启动、重复启动保护、停止和确认式重置生命周期通过。
- 七个 Edge Mock 接口已在真实 `47920/47921` 进程上逐项调用通过。
- `npm run release:check` 通过，`npm audit` 为 0 漏洞。
- 验证期间共享 `47892` 的 PID 保持不变。

## 3. 当前明确未实现

以下内容不能在 Code 侧标记为真实可用：

- 真实注册、密码、PKCE 浏览器登录和授权码。
- Access Token/Refresh Token 签发、滚动和重放撤销。
- Edge DPAPI/Keychain 安全存储。
- 真实组织、邀请码、积分、Turn 风险和结算。
- 真实 Provider、动态模型路由、`/v1/responses` 和流式转发。
- 正式 Webview HttpOnly session 和角色管理页面。

当前 handoff、ticket、账号状态和模型都只是合同级 Mock。不得用 Mock Token 或 nonce
作为正式产品凭据。

## 4. Oscar 立即执行

### 4.1 保持 My_Code 分支可追溯

先确认没有未提交工作；不要使用 `git add .`，也不要覆盖 Oscar 自己的开发改动。

```powershell
cd F:\AI\codex-collaboration\My_Code
git switch codex/account-gateway-mvp
git status --short
git pull --ff-only origin codex/account-gateway-mvp
git rev-parse HEAD
```

预期规划基线为：

```text
dca68160b25cee78b2c231c4fbd8398624ab93ff
```

如果远程已经前进，以 `git pull --ff-only` 后的新提交为准并把 SHA 告知 Black。

### 4.2 获取并启动 Black 的 Mock

```powershell
cd F:\AI\codex_proxy
git fetch origin
git switch feature/ai-editor-account-gateway
git pull --ff-only origin feature/ai-editor-account-gateway
git rev-parse HEAD
npm ci

powershell -NoProfile -ExecutionPolicy Bypass -File `
  .\tools\start-ai-editor-dev.ps1 -Mode all
```

最后一条命令只有在 Gateway 和 Edge 的 `/live` 都健康后才返回。停止命令：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File `
  .\tools\stop-ai-editor-dev.ps1 -Mode all
```

不得停止、重启或修改共享 `127.0.0.1:47892`。

### 4.3 先做最小连通性检查

```powershell
$root = Resolve-Path .\.ai-editor-dev\default
$nonce = (Get-Content (Join-Path $root 'edge-local-nonce.secret') -Raw).Trim()
$headers = @{ 'X-AI-Editor-Local-Nonce' = $nonce }

Invoke-RestMethod http://127.0.0.1:47921/live
Invoke-RestMethod http://127.0.0.1:47921/ai-editor/status -Headers $headers
Invoke-RestMethod http://127.0.0.1:47921/v1/models
```

Code 正常联调应访问 Edge `47921`，不应让 renderer 绕过 Edge 直连 Gateway `47920`。
nonce 只能由主进程或受控开发脚本读取，不能发送给 renderer、写入
`localStorage`、URL、日志或诊断正文。

### 4.4 完成 Oscar 负责的 T008

在 My_Code 中实现：

```text
scripts/mock-ai-editor-edge.mjs
scripts/start-ai-editor-account-dev.ps1
```

要求：

1. 支持依赖注入，使 Code 测试可以使用进程内 simulator，也可以指向 Black 的真实
   `127.0.0.1:47921` Mock。
2. 校验状态、handoff、Webview ticket、模型、固定路径、固定端口和隔离数据根。
3. 不在 renderer 暴露 nonce、Access Token、Refresh Token 或 ticket。
4. 把 Edge 的 snake_case 状态转换为 Code 合同中的 camelCase：

| Edge | Code renderer |
|---|---|
| `ready` | `ready` |
| `login_required` | `loginRequired` |
| `account_unavailable` | `accountUnavailable` |
| `service_unavailable` | `serviceUnavailable` |
| `password_change_required` | `passwordChangeRequired` |

Edge 的 `checkedAt` 是 ISO 时间字符串；Code 的 `IAiEditorSafeStatus.checkedAt` 是毫秒
时间戳，转换必须集中在安全 wrapper 中。

### 4.5 完成 Oscar 负责的 T022

在 My_Code 中拆分 Edge 和 Gateway 发布 allowlist：

```text
build/ai-editor-proxy/release.json
build/ai-editor-proxy/prepare-ai-editor-proxy.ts
```

当前只实现结构拆分、路径校验和测试。联合联调通过前，不要把 `84ab644` 更新为正式产品
Proxy 发布基线，也不要把 Gateway 数据库、`.ai-editor-dev/`、日志、PID、nonce 或
`node_modules` 放入发布包。

### 4.6 开始 Code 侧可独立完成的账号壳层

建议顺序：

1. **T027**：先写 Code account service、loopback callback 和 Turn gate 测试。
2. **T034**：实现账号状态合同与 IPC。
3. **T036**：实现 renderer account service、30 秒刷新和安全状态事件。
4. 使用 Mock 实现账户菜单、状态栏、重试、退出和管理入口的 UI 行为。
5. **T037**：实现 fail-closed 的新 Turn 门禁；本地编辑不受影响，已开始 Turn 不取消。
6. 为 `/v1/models` 接入准备模型刷新测试；真实 `/v1/responses` 要等待 Black 的
   T038–T046，不要自行假设请求字段。

T035 的真实 PKCE 浏览器登录依赖 Black 的 T023–T033。现在可以建立接口和 Mock
handoff 流程，但不能声明真实登录完成。

## 5. Black 接口与 Oscar 组件对应关系

| Black Edge 接口 | Oscar 对应组件/行为 |
|---|---|
| `GET /ai-editor/status` | account service 初始化、30 秒刷新、状态栏 |
| `POST /ai-editor/status/retry` | “重试”命令和错误恢复 |
| `POST /ai-editor/handoff/start` | electron-main 登录 handoff 初始化 |
| `POST /ai-editor/handoff/complete` | 主进程完成一次性绑定；renderer 不接触 Token |
| `POST /ai-editor/webview-ticket` | 打开单实例账号管理 Webview |
| `POST /ai-editor/logout` | 清理本机账号状态并触发未登录状态事件 |
| `GET /v1/models` | 模型启动加载和手工刷新 |

Oscar 不应把 Gateway Mock Bearer Token 固化到 Code。Code 产品链路只面对 Edge；真实
Edge-to-Gateway Token 将由 Black 在后续 T031–T033 实现。

## 6. Mock 状态切换

仅开发环境可使用额外控制接口：

```powershell
$body = @{ state = 'service_unavailable' } | ConvertTo-Json
Invoke-RestMethod `
  http://127.0.0.1:47921/ai-editor/mock/state `
  -Method Post `
  -Headers $headers `
  -ContentType 'application/json' `
  -Body $body
```

这个接口不是正式产品合同，不能被 Code 生产代码调用。它只用于验证以下行为：

- `login_required`：显示登录动作并阻止新 Turn。
- `account_unavailable`：显示账号管理动作并阻止新 Turn。
- `service_unavailable`：显示重试动作并阻止新 Turn。
- `password_change_required`：显示账号管理/改密动作并阻止新 Turn。
- `ready`：恢复模型和新 Turn。

## 7. Oscar 交付给 Black 的信息

每个可联调提交请提供：

```text
My_Code 分支：
commit SHA：
已完成任务编号：
测试命令与结果：
Code 启动方法：
实际访问的 Edge URL：
是否修改 contracts/：
是否修改 release.json：
已知问题：
```

如果发现合同不一致：

1. 先在 `My_Code/specs/002-ai-editor-account-gateway/contracts/` 提出明确变更。
2. 把路径、字段、状态码、安全影响和兼容方案发给 Black。
3. 双方确认后再修改各自实现。
4. 不要静默兼容两套字段，也不要在问题报告中附带 nonce、Token、API Key 或账号数据。

## 8. 第一轮联合验收清单

- [ ] Oscar 可启动 Code 开发版和 Black 的 `47920/47921`，不影响 `47892`。
- [ ] renderer 无法读取本机 nonce 和 handoff Token。
- [ ] 五种 Mock 状态均能映射到正确 Code 状态和动作。
- [ ] 未登录或故障状态只阻止新 Turn，不影响本地编辑。
- [ ] 正在运行的 Turn 不因状态刷新或退出 UI 被取消。
- [ ] 模型列表可从 Edge 加载和手工刷新。
- [ ] 重试、退出和管理入口不会重复提交。
- [ ] 日志、截图、测试产物和发布包均不含密钥或隔离运行数据。
- [ ] 双方记录分支、SHA、测试结果和所有合同差异。
