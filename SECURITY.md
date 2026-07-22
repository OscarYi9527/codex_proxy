# Security

## 默认安全边界

- 服务默认只监听 `127.0.0.1`，不要改为公网监听。
- 管理写接口仅接受回环连接，并校验 localhost Host/Origin。
- 启动脚本强制开启 TLS 证书校验。
- 配置和统计采用原子写入；安装目录 ACL 应仅允许当前用户、SYSTEM 和
  Administrators。
- Windows 使用 DPAPI（CurrentUser）保护随机 AES-256-GCM 数据密钥；配置和账号
  备份中的 Token/API Key 均以认证密文保存。
- 日志会脱敏常见 Token、API Key 和 JWT，但仍不应公开上传运行日志。

## 敏感文件

以下内容不得提交、分享或粘贴到聊天中：

- `%USERPROFILE%\.codex\auth.json`
- `codex-proxy-config.json`
- `.credential-key.dpapi.json`（只能由创建它的 Windows 用户解封）
- `.account-backups\` 中的加密账号备份
- API Key、Access Token、Refresh Token、邮箱验证码
- 带 Token 的验证码网站或管理链接

仓库 `.gitignore` 已忽略本地配置、统计、日志和运行 PID。提交前仍应执行敏感信息
扫描并检查 `git diff --cached`。

## AI Editor 调用审计

- 审计只允许保存结构化用户文本、最终 AI 文本、公共模型、时间和 Token 用量。
- system/developer 消息、文件和图片载荷、推理、工具调用及工具输出不得进入数据库、
  管理 API、日志或导出。
- Bearer、OpenAI/GitHub/AWS Key、JWT、密码和 Token 赋值在持久化前遮蔽；正文单段最多
  16 KB。
- 二级管理员只能访问本组织；一级管理员可以跨组织查看并设置 7–180 天正文保留期。
- 列表不返回正文。每次读取正文，无论允许、拒绝还是不存在，都会写入不含正文的管理员
  审计事件。
- 正文到期后置空，Token、模型、时间和匿名聚合继续保留。`bodyDeletedAt` 必须明确返回，
  不能用空字符串伪装为未发生清理。
- `gateway/tests/security/secret-leak.test.ts` 对数据库、管理 API、日志和导出形状执行
  固定秘密回归；发布前必须与完整覆盖率测试一起通过。

## TORVYE 浏览器完整管理平台

- `/admin` 的 Code 内嵌 React 管理与 `/admin/full` 的浏览器完整控制台共用同一个
  HttpOnly 管理会话，不接受 URL Bearer Token 或 localStorage Token。
- 浏览器必须从一次性 `#browser?ticket=...` 入口进入；ticket 交换前即从地址栏历史状态
  中移除，重放、过期、错误 Origin 或非一级管理员均 fail closed。
- `/admin/full` 的 HTML/JavaScript 可以公开加载，但 `/admin/api/*` 的所有数据请求都
  重新验证管理 Cookie；所有写操作还要求固定 Gateway Origin。
- 共享 console 仍使用 standalone 的单个内联样式表和额度/健康动态样式，因此仅
  `/admin/full` 的 CSP 对 `style-src` 开放 `unsafe-inline`；`script-src` 始终保持
  external-only，绝不开放内联脚本。
- 共享 console 的按钮、输入框和拖拽交互使用 `data-admin-on*` 与外部脚本中的白名单
  事件委托；页面不包含 `onclick`、`onchange` 等可执行内联处理器，也不使用
  `eval`/`Function` 绕过 CSP。未知动作名或不支持的参数形状不会执行。
- 完整控制台只返回 masked preview。API Key、ChatGPT Access/Refresh Token、Provider
  Worker 签名秘密和完整凭据不得出现在 HTML、JSON、日志、错误、导出或浏览器存储中。
- standalone 专属的部署、备份恢复、统计清空、额度重置和进程重启操作不会透传到中央
  Gateway；即使绕过前端直接请求也返回安全的 `409`。
- 中央完整控制台永不读取、复制、导入或控制用户本机 `127.0.0.1:47892` 的配置和数据。

加密文件不能脱离 `.credential-key.dpapi.json` 和原 Windows 用户单独恢复。迁移
电脑前应先在原用户环境中使用管理后台确认账号可用；不要把密钥文件或备份上传到
公共仓库。DPAPI 保护降低静态文件泄露风险，但不能防御已经控制当前 Windows 用户
会话的恶意程序。

## 合规使用

只使用自己拥有并获准使用的账号和 API。项目提供有限并发、排队、退避、冷却和
会话粘性来提高稳定性，不提供设备指纹伪造、验证码代收、账号关联隐藏或平台风控
规避能力。

## 自定义代理与 CA

如果本地 HTTPS 代理使用自定义根证书，应通过系统证书存储或
`NODE_EXTRA_CA_CERTS` 配置可信 CA。不要设置：

```text
NODE_TLS_REJECT_UNAUTHORIZED=0
```

Gateway/Edge 配置加载和 `npm run release:check` 检测到该值时会直接拒绝继续。隔离开发
脚本还会对子进程显式设置安全值，防止父 PowerShell 的错误配置被继承。仍建议清理父进程：

```powershell
Remove-Item Env:NODE_TLS_REJECT_UNAUTHORIZED -ErrorAction SilentlyContinue
```

自定义 CA 只能通过系统证书存储或 `NODE_EXTRA_CA_CERTS` 接入。不要通过修改启动脚本或
配置加载器绕过该门禁。

## 诊断报告

`GET /admin/api/diagnostics` 及管理后台下载的诊断报告不包含 Token、API Key、账号
标签或邮箱。报告仍可能包含内部账号 ID、模型名、时间和运行状态，公开分享前请
再次检查。

## 发现安全问题

不要在公开 Issue 中附带真实凭据、配置或日志。请先撤销可能泄露的凭据，再通过
仓库维护者提供的私密渠道报告复现步骤和已脱敏诊断信息。
