# AI Editor 真实认证与 Responses 联调交接给 Oscar

日期：2026-07-17

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
7. 在流式请求中途切换账号或退出，确认已接受 Turn 保持旧设备会话，新 Turn 使用新绑定
   或返回 `login_required`。
8. 验收前后记录共享 `47892` PID 和 `/live`；不得停止、重启或修改共享实例。

## 测试证据与边界

Black 自动测试覆盖 PKCE/state/redirect/过期/重放、Argon2id、bootstrap/邀请、
Refresh Token 滚动与 family 撤销、DPAPI 文件无明文 Token、handoff 防重放、单飞刷新、
Edge 流式代理、在途身份快照、Gateway 预检、动态模型过滤，以及隔离本机非 Mock Relay
到现有 Provider 模块的完整流式转换。

交付前门禁：

```text
npm test                                      106/106 passed
npm run gateway:test                           48/48 passed
npm run admin:test                               5/5 passed
npm run test:coverage --workspace @ai-editor/gateway
                                               statements 88.93%, branches 70.74%
npm run test:dev-scripts                       passed
npm run check                                  passed
npm run release:check                          passed
npm audit --audit-level=moderate               0 vulnerabilities
```

上一轮真实模式隔离启动复核确认 `47920/47921` 正常、初始状态为 `login_required`，
Gateway 运行文件仅位于专用数据根。管理外壳复核确认 `/admin=200`、严格 CSP 和
`/admin/assets/` 固定资源基址；该次复核前后共享 `47892` PID 均为 `8908`。

以下仍不属于当前完成范围：

- T061+ 的积分风险预留、幂等用量、实际/估算结算；
- T083+ 的中央 Provider 管理 API、凭据轮换和角色化诊断；
- T047/T048、T112/T113 需要 Oscar 与 Black 使用真实 Provider 共同验收。

Mock `gpt-mock`、随机 Webview ticket 或仅有 `response.completed` 的 fake adapter 测试，
均不能替代真实 AI 链路或后续积分结算证据。
