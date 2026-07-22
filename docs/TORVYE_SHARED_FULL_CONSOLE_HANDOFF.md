# TORVYE 共享完整管理平台交接

## 目标

standalone 和中央 Gateway 现在复用同一套完整管理前端：

```text
TORVYE AI Gateway
统一管理平台
```

Code 内嵌 React 管理页继续负责账号、安全、组织、邀请码、积分、审计和精简
Provider 操作；一级管理员从内嵌页打开浏览器详细管理后进入完整控制台。

## 页面入口

| 表面 | 入口 | 用途 |
|---|---|---|
| Code 内嵌 | `/admin` | React 紧凑管理页 |
| 浏览器合同入口 | `/admin#browser?ticket=...&route=...` | 兑换一次性管理 ticket |
| 浏览器完整控制台 | `/admin/full` | 共享 standalone 完整控制台 |
| standalone | `/admin` | 原完整控制台 |

浏览器合同入口由 React bundle 立即重定向到 `/admin/full`，ticket 兑换后只使用
`HttpOnly; SameSite=Strict` Cookie。页面刷新时会复用仍有效的 Cookie，不把产品 Token
写入 URL、localStorage 或 JavaScript 持久存储。

## 共享源码

Gateway 不复制页面：

```text
src/admin.html
src/admin_ui_behaviors.cjs
src/admin_app.js
src/admin_modules/accounts.js
src/admin_modules/tutorial.js
src/admin_modules/analytics.js
src/admin_modules/settings.js
```

`/admin/runtime.js` 声明 `standalone` 或 `gateway` 模式。Gateway 的
`gateway/src/api/management-shell.ts` 从上述源文件直接提供 `/admin/full` 和
`/admin/app.js`；预发布 Docker 镜像本来就包含 `src/`，无需第二份打包资源。

## Gateway 适配

`gateway/src/api/full-console-routes.ts` 提供受管理 Cookie 和 Level-1 保护的
`/admin/api/*` 兼容层，覆盖：

- 配置与脱敏 Provider 摘要；
- 动态模型目录；
- Provider/账号/模型统计；
- 脱敏诊断、熔断和路由决策；
- OpenAI、DeepSeek、Relay 配置；
- ChatGPT 官方登录、导入、删除、改名、路由和额度刷新；
- 模型积分费率只读汇总；
- 账号池检测和 Provider 当前健康检测；
- 中央运行信息。

补充完成：

- “检测/检测全部通道”通过 Provider adapter 主动探测；不再把历史健康快照作为本次
  检测成功结果。Provider Worker 的 ChatGPT 路径使用真实额度刷新，当前 Worker 未承载
  的通道明确显示不支持。
- `usage_records` 按真实模型累计请求与 Token，并按 Asia/Shanghai 自然日生成最近
  370 天统计；零请求模型不进入“最近调用”和模型用量表。
- 严格 `script-src 'self'` 下的全部按钮、输入和拖拽操作改用白名单事件委托。页面没有
  可执行内联事件，也没有 `eval`/`Function`。

中央凭据始终只写不回显。standalone 专属的本机账号切换、订阅额度重置、本地统计
清空、备份恢复、部署和进程重启不会映射到中央服务；前端隐藏入口，直接请求也返回
`409 full_console_operation_unavailable`。

## 隔离约束

- 不读取、不导入、不修改 `127.0.0.1:47892`。
- 不把本机 standalone 配置或统计复制进中央数据库。
- 浏览器完整平台仅允许 Level-1。
- 二级管理员和普通用户仍只使用 Code 内嵌的角色范围页面。
- API Key、Access Token、Refresh Token、完整 auth.json 和 Worker 签名秘密不进入响应。

## 自动化验收

```powershell
npm test
npm run gateway:test
npm run test:coverage --workspace @ai-editor/gateway
npm run admin:test
npm run check
npm run gateway:build
npm run admin:build
```

定向合同位于：

```text
gateway/tests/integration/full-console.test.ts
```

覆盖共享资源、一次性会话、Level-1、脱敏、只写凭据、Provider/Relay/订阅账号操作、
主动上游检测、真实模型/自然日统计、严格 CSP 交互和 standalone 专属操作 fail-closed。
