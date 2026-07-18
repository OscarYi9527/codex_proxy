# Oscar 接手 T091–T098 的账户安全实现交接

日期：2026-07-18

## 分支与基线

```text
基线：origin/feature/ai-editor-account-gateway@34a2a9ca193fdac19b630e521c373a73fb8927c1
Oscar 分支：codex/oscar-t091-account-security
工作目录：D:\AI_prejoct\codex_proxy-oscar
```

此工作目录是独立 Git worktree。它不修改 Black 的远程分支、共享 Proxy
`127.0.0.1:47892`、共享 Proxy 数据目录或正在运行的 Gateway/Edge。

## 本轮实现

- T091/T094/T096：
  - 新增 Level 1 专用 `POST /api/v1/admin/accounts/:accountId/temporary-password`。
  - 临时密码由 `PasswordService` 生成并只在成功响应中返回一次；响应为 `no-store`。
  - 数据库只保存 Argon2id 哈希；临时凭据有效期为 24 小时，设置后强制改密并使该账号的
    现有设备会话/Refresh Token 失效。
  - 临时凭据登录一次后不可再次用于登录；该会话仍可立即提交永久密码。
- T092/T095：
  - 原有设备列举、单设备撤销、当前设备二次确认、当前设备 logout 和 Token-family
    撤销逻辑经新的独立回归覆盖。
- T093/T097：
  - 管理 Webview 的“设备与安全”页新增密码修改表单与设备撤销操作。
  - UI 不将密码写入 URL、`localStorage`、React 状态持久化或日志；密码提交完成后只显示
    “重新登录”安全提示。
- T098：
  - Edge 的 DPAPI/Keychain 清除、logout 安全删除和在途 Turn 绑定快照在已有实现中已
    存在；本轮以根 Node 测试复核，不重写该稳定逻辑。

## 自动化验证

```text
npm ci                                      通过；npm audit 0 vulnerabilities
npm run check                               通过
npm run gateway:build                       通过
npm run admin:build                         通过
npm run test:gateway-stack                  通过（Gateway 61/61；Admin 9/9）
npm test                                    通过（standalone/Edge 106/106）
```

新增测试：

- `gateway/tests/integration/password-lifecycle.test.ts`
- `gateway/tests/integration/device-session.test.ts`
- `gateway/admin-web/src/app/App.test.tsx` 的密码表单回归

## 真实运行验收

- 在用户允许后，已通过原数据根所属的安全停止脚本停止旧隔离 `47920/47921`，没有停止、
  重启或修改共享 `47892`。
- 使用本分支全新隔离数据根启动真实 Gateway/Edge，完成真实 PKCE、首次改密、`ready`
  状态、Webview ticket 交换和 HttpOnly 管理会话获取的端到端 smoke；测试账号和数据根
  随后安全停止，未写入仓库。
- 端到端 smoke 不记录密码、授权码、Access Token、Refresh Token、ticket 或 Cookie。
- 端口释放后重新执行 `npm run release:check`，完整通过（包括 `47920/47921` 隔离脚本
  生命周期测试、Gateway/Admin 测试、构建和空白检查）。
- 共享 `47892 /live` 在本轮前后均为 `ok`。
