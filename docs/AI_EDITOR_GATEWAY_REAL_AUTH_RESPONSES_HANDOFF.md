# AI Editor 真实认证与 Responses 联调交接给 Oscar

日期：2026-07-18

## 同步坐标

```text
My_Code:
  branch: codex/account-gateway-mvp
  contract commit: dca68160b25cee78b2c231c4fbd8398624ab93ff
  contracts: specs/002-ai-editor-account-gateway/contracts/

codex_proxy:
  branch: feature/ai-editor-account-gateway
  stacked on: feature/custom-api-urls@e3ed1d6
```

未修改接口合同。后续 endpoint、JSON 字段、状态码或安全语义变化，仍须先修改上述
My_Code `contracts/` 并由双方确认。

Gateway 和 Edge 合同测试直接消费 vendored
`gateway/tests/fixtures/edge-code-contract.json`；该文件与上述 My_Code 提交中的
`contracts/fixtures/edge-code-contract.json` 语义一致。

## Black 本轮完成范围

- T023–T033：Argon2id、固定 `admin` bootstrap、强制改密/邮箱、邀请注册、
  Authorization Code + PKCE、5 分钟 Access Token、30 天滚动 Refresh Token、
  Refresh Token 重放撤销、设备会话、DPAPI/Keychain、单飞刷新和单次本机 handoff。
- T038–T046：Edge `/v1/models`、`/v1/responses`、兼容 `/v1/chat/completions`，
  Edge-to-Gateway 身份头、在途绑定快照、Gateway 账号/组织/模型预检、动态模型目录、
  现有 Provider adapter 和 SSE 流式转发。
- Mock 仍保留供第一轮回归使用；真实模型目录明确过滤 `gpt-mock`。
- Gateway Provider 运行数据使用 `.ai-editor-dev/.../gateway/` 隔离根，不读取、复制或
  修改共享 `47892` 的配置、账号、API Key、统计、健康或线程路由数据。
- T049–T055：一次性 Webview ticket、HttpOnly 管理 session、固定 `/admin` 外壳、
  服务端角色导航，以及普通用户账号、积分、设备和使用记录页面。
- T081–T089：仅一级管理员可用的 Provider/凭据/模型/路由 API、脱敏诊断、React
  Provider/系统页面、`plaintext-v1` 回环开发门禁，以及隔离 Codex app-server 的
  OpenAI 官方登录。
- 数据库创建的 Relay 已通过动态 `/v1/models` 和真实 SSE `/v1/responses` 测试；
  上游收到 Gateway 数据库凭据，禁用 Provider 后模型立即从目录移除。

## 启动

```powershell
npm install

# 默认真实认证；首次空数据库会在前台显示一次 admin 临时密码
powershell -NoProfile -ExecutionPolicy Bypass -File `
  .\tools\start-ai-editor-dev.ps1 -Mode all -AuthenticationMode real

# 停止时只处理 47920/47921 对应且属于当前隔离数据根的进程
powershell -NoProfile -ExecutionPolicy Bypass -File `
  .\tools\stop-ai-editor-dev.ps1 -Mode all
```

固定地址：

```text
Gateway: http://127.0.0.1:47920
Edge:    http://127.0.0.1:47921
Shared:  http://127.0.0.1:47892  # 禁止操作
```

需要回归第一轮 Mock 时必须显式传入：

```powershell
.\tools\start-ai-editor-dev.ps1 `
  -Mode all -AuthenticationMode mock -MockState ready
```

为兼容 Oscar 旧脚本，未传 `-AuthenticationMode` 但显式传 `-MockState` 也会选择 Mock。

## Oscar 联调步骤

1. Code 生成随机 state、PKCE verifier/challenge 和随机端口
   `http://127.0.0.1:{port}/callback`。
2. 系统浏览器打开 Gateway `/api/v1/oauth/authorize`；回调必须验证原始 state。
3. Code 用授权码和 verifier 调用 `/api/v1/oauth/token`，再通过受 nonce 保护的
   `/ai-editor/handoff/start`、`complete` 把 Token set 交给 Edge。
4. 首次 admin 登录应得到 `password_change_required`；调用
   `/api/v1/account/password/change` 填写邮箱并更换永久密码，再重新完成 handoff。
5. Code 只访问 Edge `47921` 获取安全状态、模型和发送 Turn；renderer 不接收 nonce、
   Access Token、Refresh Token、handoff secret 或 Webview ticket。
6. 从 Edge 刷新模型，确认真实目录不含 `gpt-mock`；配置隔离测试 Provider 后，分别验证
   订阅和非订阅模型的真实 SSE。
7. 一级管理员打开 `Provider 与模型`，确认普通用户/二级管理员没有该导航且直接请求 API
   返回 `403`；ChatGPT 官方登录只显示安全状态和 OpenAI 登录 URL。
8. 在流式请求中途切换账号或退出，确认已接受 Turn 保持旧设备会话，新 Turn 使用新绑定
   或返回 `login_required`。
9. 验收前后记录共享 `47892` PID 和 `/live`；不得停止、重启或修改共享实例。

## 测试证据与边界

Black 自动测试覆盖 PKCE/state/redirect/过期/重放、Argon2id、bootstrap/邀请、
Refresh Token 滚动与 family 撤销、DPAPI 文件无明文 Token、handoff 防重放、单飞刷新、
Edge 流式代理、在途身份快照、Gateway 预检、动态模型过滤，以及隔离本机非 Mock Relay
到现有 Provider 模块的完整流式转换。Provider 测试额外覆盖凭据掩码、角色降权、拒绝
审计、诊断二次脱敏、官方登录隔离导入、临时目录删除和 production 明文门禁。

交付前门禁：

```text
npm test                                      106/106 passed
npm run gateway:test                           59/59 passed
npm run admin:test                               8/8 passed
npm run test:coverage --workspace @ai-editor/gateway
                                               statements 88.80%, branches 70.23%
npm run test:coverage --workspace @ai-editor/admin-web
                                               statements 60.95%, branches 60.00%
npm run test:dev-scripts                       passed
npm run check                                  passed
npm run release:check                          passed
npm audit --audit-level=moderate               0 vulnerabilities
```

上一轮真实模式隔离启动复核确认 `47920/47921` 正常、初始状态为 `login_required`，
Gateway 运行文件仅位于专用数据根。管理外壳复核确认 `/admin=200`、严格 CSP 和
`/admin/assets/` 固定资源基址；本轮完整门禁结束后共享 `47892` 仍为 PID `8908`，且
`47920/47921` 均无残留监听。

以下仍不属于当前完成范围：

- T061+ 的积分风险预留、幂等用量、实际/估算结算；
- T060–T080 的组织、邀请码、积分和并发风险；
- `envelope-v1` 信封加密；当前 `plaintext-v1` 只能用于回环开发，不能用于生产；
- T090 需要 Oscar 刷新 Code 真实模型目录；T047/T048、T112/T113 仍需双方使用真实
  Provider 共同验收。

Mock `gpt-mock`、随机 Webview ticket 或仅有 `response.completed` 的 fake adapter 测试，
均不能替代真实 AI 链路或后续积分结算证据。
