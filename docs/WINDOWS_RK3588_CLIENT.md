# Windows 接入 RK3588 日本中转

## 1. 已实现路线

Windows 同事端不再把长期 RK3588 Key 写入环境变量或 `config.toml`：

```text
Codex
  │ 调用 command-backed auth helper（Key 不进 argv）
  ▼
原生 .NET Console helper
  │ DPAPI CurrentUser 解密，只向 Codex 子进程 stdout 返回 Key
  ▼
Tailscale 私域 HTTPS
  ▼
RK3588 → 日本节点 → Codex/Responses 兼容服务器
```

安装器完成以下工作：

- 检查 URL 必须为无凭据、无 query/fragment 且以 `/v1` 结尾的 HTTPS 地址。
- 用 Windows DPAPI `CurrentUser` 直接保护客户端 Key；状态目录 ACL 只保留当前用户、
  `SYSTEM` 和本机管理员。
- 在用户级 `%USERPROFILE%\.codex\config.toml` 写入 Codex 官方支持的
  `[model_providers.rk3588_jp.auth] command`，不写 `env_key`、明文 Key 或长期用户环境变量。
- 默认让已安装 Codex 解析生成的配置，并执行 `tailscale status --json`、单次
  `tailscale ping` 和带鉴权的 `GET /v1/models`。
- 安装前备份 Codex 配置。未发生后续改动时卸载会按 SHA-256 校验后精确恢复；配置已被
  用户修改时，只删除 RK provider，并保留用户新增内容和卸载前备份。
- 提供独立 Key 轮换、诊断和可选凭据清除脚本，不安装后台服务。

## 2. 前置条件

1. Windows 10/11，使用当前用户的 Windows PowerShell 5.1。
2. 安装 Tailscale、登录团队 tailnet，并由管理员 ACL 授权访问 RK3588 的 TCP 443。
3. 安装可用的 Codex CLI；先执行 `codex --version`，若安装损坏应先重装。
4. 从团队密码管理器取得分配给本人的 RK3588 客户端 Key。不要通过聊天、工单或脚本
   参数传递 Key；Key 应为服务端生成的 32–4096 字节可打印 ASCII 值。
5. 确认日本节点实际提供的模型 ID。

可先检查：

```powershell
tailscale status
tailscale ping rk3588-relay.<tailnet>.ts.net
codex --version
```

## 3. 安装

在仓库根目录运行；命令中没有 Key，脚本会显示安全输入框：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass `
  -File .\windows\rk3588\install-rk3588-client.ps1 `
  -BaseUrl 'https://rk3588-relay.<tailnet>.ts.net/v1' `
  -Model '<日本节点提供的模型 ID>'
```

默认路径：

| 内容 | 路径 |
|---|---|
| 安装脚本 | `%LOCALAPPDATA%\CodexProxy\RK3588\client` |
| DPAPI 凭据和安装状态 | `%LOCALAPPDATA%\CodexProxy\RK3588` |
| Codex 用户配置 | `%USERPROFILE%\.codex\config.toml` |
| 配置备份 | `%LOCALAPPDATA%\CodexProxy\RK3588\config-backups` |

安装器默认把 `rk3588_jp` 设为 Codex provider。若只想注册 provider 而不改变当前默认值，
增加 `-DoNotSetDefault`。

`-SkipCodexCheck`、`-SkipTailscaleCheck` 和 `-SkipEndpointCheck` 仅供隔离测试或故障
修复时使用；用了这些开关不能算真实链路验收。若 Codex 不在 `PATH`，可用
`-CodexCommand '<codex.cmd 的完整路径>'` 指定。

### 密码管理器自动输入

自动化场景可以让密码管理器把 Key 写到安装器 stdin，并增加 `-ClientApiKeyStdin`。
不要把 Key 拼到 PowerShell 命令文本、`.cmd`、任务计划参数或 CI 日志中。具体取密命令
取决于团队密码管理器，因此仓库不提供包含真实 vault 名称的示例。

## 4. 验证

安装结束已自动验证一次。之后可随时运行：

```powershell
& "$env:LOCALAPPDATA\CodexProxy\RK3588\client\test-rk3588-client.ps1"
```

成功结果必须同时满足：

- `dpapi = ok`
- `tailscale = ok`
- `endpoint = ok`
- `model_count` 与日本节点目录相符

再启动 `codex` 发送一条最小、非敏感请求，确认 Responses 流正常结束。Windows 诊断只
证明“同事端 → RK3588”可达；完整上线仍必须执行
[`RK3588_JAPAN_RELAY.md`](RK3588_JAPAN_RELAY.md) 第 8 节的真实两跳验收。

## 5. Key 轮换

新 Key 仍通过安全提示输入：

```powershell
& "$env:LOCALAPPDATA\CodexProxy\RK3588\client\set-rk3588-client-key.ps1"
& "$env:LOCALAPPDATA\CodexProxy\RK3588\client\test-rk3588-client.ps1"
```

轮换采用同目录原子替换，不保留旧 Key 的明文或密文副本。应由管理员先协调服务端 Key
切换窗口，避免新旧值不一致。

## 6. 卸载和回滚

保留 DPAPI 状态以便快速回滚：

```powershell
& "$env:LOCALAPPDATA\CodexProxy\RK3588\client\uninstall-rk3588-client.ps1"
```

这一步会删除运行 helper 和日常管理脚本，但保留受限 ACL 的 common/uninstall 清理命令，
因此下面的二阶段清除仍可直接执行。

确认不再回滚后，连同 DPAPI 凭据和配置备份一起清除：

```powershell
& "$env:LOCALAPPDATA\CodexProxy\RK3588\client\uninstall-rk3588-client.ps1" `
  -PurgeCredential
```

卸载只删除清单中的已知文件，不对用户传入路径执行递归删除。若 Codex 配置在安装后发生
变化，脚本不会用旧备份覆盖整个文件，而是进行保守的 provider 级删除。

## 7. GitHub 开源项目参考审计

审计日期：2026-07-22。实现只采用设计参考，没有复制下列项目代码。

| 项目与审计 Commit | 许可证 | 采用的参考点 | 本项目决策 |
|---|---|---|---|
| [`tailscale/tailscale@c8ae72b`](https://github.com/tailscale/tailscale/tree/c8ae72b537df6e54c618535597a62f366bfbb22b) | BSD-3-Clause | `status --json` 提供连接状态；`tailscale ping` 在 overlay 层确认 peer 和 DERP/direct 路径 | 只依赖最小的 `BackendState=Running`，再执行单次 ping；上游明确提示 JSON 可能演进，因此不绑定完整 schema |
| [`git-ecosystem/git-credential-manager@2fe99b8`](https://github.com/git-ecosystem/git-credential-manager/tree/2fe99b867b710265e3273b48da7513d91e6ef8eb) | MIT | Windows Credential Manager/DPAPI 文件存储，以及原生 console helper 通过 stdin/stdout 与调用方交换凭据 | 复用本仓库已有 DPAPI 能力并安装时编译 .NET helper；Key 不进 argv/TOML/日志，只在 Codex 要求的 stdout 边界返回 |
| [`PowerShell/SecretManagement@e24cc88`](https://github.com/PowerShell/SecretManagement/tree/e24cc88e87d02cabbbf0fbaf76e4e287e927dbed) | MIT | 当前用户 vault 抽象，可接本地或远端 secret store | 不作为硬依赖：模块还需要单独 vault，且项目已声明 feature complete；未来可做企业 vault adapter |
| [`winsw/winsw@1d0ee4a`](https://github.com/winsw/winsw/tree/1d0ee4a91bad596d5e7e9c360f2b39ef54674674) | MIT | Windows 服务安装、状态、重启和滚动日志 | 当前 Windows 端没有常驻进程，Codex 按需调用 helper，因此不引入额外服务和供应链制品 |

Codex provider 的 `base_url`、`wire_api = "responses"` 和 command-backed auth 来自当前
Codex 官方手册：
<https://developers.openai.com/codex/codex-manual.md#custom-model-providers>。
官方要求 auth command 不接收 stdin、把 token 写到 stdout；也明确不得把
`[model_providers.<id>.auth]` 与 `env_key`、`experimental_bearer_token` 或
`requires_openai_auth` 混用。

## 8. 安全责任边界

- DPAPI `CurrentUser` 防止磁盘文件被复制到其他用户或设备后直接解密，但不能抵御已控制
  当前 Windows 账号的恶意程序、本机管理员或正在调试 Codex 的进程。
- Codex command-backed auth 的协议要求 helper 把 Key 返回到 stdout；该输出由 Codex
  子进程捕获。原生 helper 避开 PowerShell transcript，但直接手工运行
  `rk3588-credential-helper.exe` 仍会显示 Key，不应这样操作。
- 安装器会从仓库内 C# 源码在本机编译 helper。启用 AppLocker/WDAC 的企业设备必须由
  管理员批准该用户目录和程序；不要为了绕过策略改回明文环境变量。
- 长期共享 Key 无法实现逐人撤销和审计。生产团队应给每位同事独立 Key；下一阶段优先
  采用短期 JWT/OIDC 和设备身份绑定。
- 本仓库自动化在 Windows 上验证 DPAPI 往返、无明文制品、配置备份、重装、Key 轮换及
  两种卸载路径。它不能替代真实 Tailscale ACL、RK3588、日本节点和最终账号的现场验收。
