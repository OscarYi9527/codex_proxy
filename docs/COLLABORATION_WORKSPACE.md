# Codex Proxy 协作仓库与合并工作区

## 目标

`codex_proxy-black` 是 Black（当前用户）的开发仓库，不是同事仓库。两个项目可以放在
同一个“协作父目录”中，但必须各自使用独立子目录和独立 `.git`，不能把一个仓库放进
另一个仓库内部。

当前 `F:\AI\codex_proxy` 仍被本机 Proxy 记录为源码目录。迁移到新父目录前先保留原
路径，避免影响安全部署、运行版本检查和更新脚本；收到同事仓库信息后再安排一次可控
迁移。

## 推荐目录

```text
F:\AI\codex-collaboration\
├─ codex_proxy-black\                   # Black：Gateway/Edge/服务器开发
├─ My_Code\                              # Oscar：AI Editor / Code-OSS
└─ worktrees\
   └─ gateway-integration\              # 后续合并与冲突处理工作树
```

不要使用以下结构：

```text
F:\AI\codex-collaboration\codex_proxy-black\My_Code\
F:\AI\codex-collaboration\My_Code\codex_proxy-black\
F:\AI\codex-collaboration\codex_proxy-black\src\colleague\.git\
```

在正式迁移前，当前目录与未来目录的对应关系是：

```text
当前：F:\AI\codex_proxy
未来：F:\AI\codex-collaboration\codex_proxy-black
同事：F:\AI\codex-collaboration\My_Code
```

## 已确认的同事仓库

```text
仓库：https://github.com/OscarYi9527/My_Code.git
分支：codex/account-gateway-mvp
commit：0da3497f12e96bae58f9fe6b20a08833a0c3c2bd
本地：F:\AI\codex-collaboration\My_Code
```

该仓库已于 2026-07-17 快进到上述提交并核对为干净工作区。接口事实来源为该提交下
`specs/002-ai-editor-account-gateway/contracts/`。

## 克隆前记录

克隆前先记录并由双方确认：

```text
仓库 URL：
目标分支：
交付 commit：
启动命令：
数据库迁移：
接口合同版本：
测试结果：
已知问题：
```

同事仓库的实际克隆命令为：

```powershell
New-Item -ItemType Directory -Force F:\AI\codex-collaboration | Out-Null
git clone --branch codex/account-gateway-mvp `
  https://github.com/OscarYi9527/My_Code.git `
  F:\AI\codex-collaboration\My_Code
git -C F:\AI\codex-collaboration\My_Code status --short
git -C F:\AI\codex-collaboration\My_Code branch -vv
git -C F:\AI\codex-collaboration\My_Code remote -v
```

不要把当前仓库中的 `codex-proxy-config.json`、`.credential-key.dpapi.json`、
`.account-backups`、日志、Token 或 API Key 复制到同事仓库。

## 仓库关系与“合并”的边界

`My_Code` 是 Code-OSS 产品仓库，`codex_proxy-black` 是服务器/代理仓库。当前检查
没有发现共同 Git 历史，因此不能对两个仓库执行：

```powershell
git merge --allow-unrelated-histories
```

后续“合并”是产品联调和接口合同合并，不是把两个 Git 根目录合成一个仓库：

1. `My_Code` 继续保存 AI Editor、账户菜单、状态栏、Turn 门禁和 Webview。
2. `codex_proxy-black` 继续保存 standalone、Edge、Gateway、账号、积分和 Provider。
3. 双方通过 `specs/002-ai-editor-account-gateway/contracts/` 冻结接口。
4. 只在各自仓库提交属于该仓库的变更。
5. T112/T113 在隔离端口执行端到端联调。

`gateway-integration` worktree 只用于 `codex_proxy-black` 内部的 Gateway 分支集成，不
接收整个 `My_Code` 历史：

```powershell
New-Item -ItemType Directory -Force `
  F:\AI\codex-collaboration\worktrees | Out-Null
git worktree add `
  -b integration/gateway-edge `
  F:\AI\codex-collaboration\worktrees\gateway-integration `
  origin/feature/custom-api-urls
```

后续只在该工作树中执行合并、冲突处理和完整测试，当前
`F:\AI\codex_proxy` 保持可运行基线。

## 当前仓库迁移注意事项

当前运行实例位于 `C:\Users\24336\.codex-local-multi-proxy`，但其部署清单记录的源码
目录仍是 `F:\AI\codex_proxy`。因此不要在代理运行期间直接移动或改名当前目录。

迁移到 `F:\AI\codex-collaboration\codex_proxy-black` 时应：

1. 确认工作区干净并提交文档改动。
2. 备份未跟踪的配置、凭据和账号数据。
3. 停止本机 Proxy 与相关编辑器任务。
4. 移动仓库后更新部署来源和所有快捷方式。
5. 从新路径执行安全部署。
6. 检查 `/live`、`/ready` 和 `/admin/api/runtime-info`。
7. 确认运行实例的 `manifest_source` 已指向新目录后再删除旧路径。

如果确有少量共享合同样例，应复制为双方各自维护的生成物或测试夹具，并在文件头记录
来源 commit；不要复制整个 `src`、构建目录或第三方 Code-OSS 文件。

## 合并门禁

每次接收同事交付至少执行：

```powershell
npm ci
npm test
npm run check
npm run release:check
git diff --check
```

同时确认：

- `standalone` 现有行为没有退化。
- Gateway/Edge 不占用共享端口 `47892`。
- 数据库、`.env`、Token、日志和 `node_modules` 未进入提交。
- API 字段、状态码和错误码与合同一致。
- 数据库迁移支持备份和回滚。
- 合并提交没有混入 Code 界面或其他负责人所有的文件。
