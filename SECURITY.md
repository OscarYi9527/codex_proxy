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
