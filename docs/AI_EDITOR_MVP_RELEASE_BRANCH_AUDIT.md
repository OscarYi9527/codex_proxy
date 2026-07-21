# AI Editor Proxy MVP 分支合并与发布审计

更新时间：2026-07-21

## 结论

服务器 MVP 发布基线为：

```text
origin/codex/provider-worker-mvp@efb69c5f3f772de1100ea47a0d16d037c9f99067
```

本轮发布候选为：

```text
codex/proxy-mvp-release-integration
```

不能把 `master`、旧 Bug 修复分支或 Black 的功能分支直接覆盖到发布基线。当前候选以
Provider Worker MVP 为主线，逐项 forward-port Black 尚未进入 MVP 的增量，再用记录性
merge 建立已审计的祖先关系。这样会保留 Gateway、Edge、Provider Worker、生产数据库
门禁和预发布部署能力，不会被旧分支删除或降级。

## 远端分支分类

| 分支 | 相对发布候选 | 处理结论 |
| --- | --- | --- |
| `origin/codex/provider-worker-mvp` | 服务器 MVP 基线 | PR 合并目标 |
| `origin/feature/ai-editor-account-gateway` | Black 最新账号/Gateway 分支 | 5 个缺失增量已 forward-port，并已记录性 merge |
| `origin/feature/custom-api-urls` | Black 与 Oscar 的共同稳定起点 | 已完全包含 |
| `origin/codex/fix-cross-provider-tool-ids-edge` | Edge 跨 Provider 工具 ID 修复 | 已完全包含 |
| `origin/codex/oscar-t091-account-security` | 账号安全和发布边界 | 已完全包含 |
| `origin/codex/fix-chatgpt-circuit-recovery` | 旧 `master` 血统的熔断修复 | 不直接 merge；有效逻辑已由 MVP 提交重新实现 |
| `origin/codex/fix-cross-provider-tool-ids` | 旧 `master` 血统的工具 ID/大请求修复 | 不直接 merge；有效逻辑已由 MVP 提交重新实现 |
| `origin/codex/stabilize-request-body-test` | 独立的请求体测试稳定化方案 | 不直接 merge；运行时定时器语义已在候选中统一修复 |
| `origin/master` | 旧 standalone 主线 | 不作为 Gateway/Worker 发布基线 |

## Black 分支提交映射

Black 分支在共同节点之后有 8 个提交。前三个已在 Provider Worker 主线以适配后的提交
实现，后五个由本轮候选移植：

| Black 提交 | 发布候选中的处理 |
| --- | --- |
| `ccb1cd7` 多格式账号导入 | `cef7f99` 等价移植 |
| `1721377` 测试存储隔离 | `b7e328a` 等价移植 |
| `6e1efdb` 导入凭据分类 | `23d0c08` 适配 Provider Worker 后移植 |
| `47a451d` 临时账号导入加固 | forward-port 为 `82e29ae` |
| `c75dcd9` 账号池健康治理 | forward-port 为 `6604dc6` |
| `034a056` 后续路线图 | forward-port 为 `117a2e8` |
| `fdbf157` 发布 Commit 元数据 | forward-port 为 `811db19` |
| `ae9a88f` Gateway/Edge TLS 强制校验 | forward-port 为 `753eece` |

记录性 merge：

```text
d889c96 merge(mvp): record audited Black gateway integration
```

该 merge 使用已验证候选树，不重新选择旧分支文件；其作用是让以后能用
`git merge-base --is-ancestor` 明确判断 Black 分支已经审计合入。

## 旧 Bug 分支的语义映射

以下分支不能根据 SHA 是否为祖先来判断功能是否缺失，因为它们来自旧 `master` 血统；
MVP 已在 Gateway/Edge/Worker 架构上重新实现相同修复：

| 旧修复 | MVP 实现 |
| --- | --- |
| `f56093a` 跨 Provider 工具调用 ID | `9b37554`，并覆盖 Edge 转换路径 |
| `1bdccb0` 遗留 half-open 探测 | `3a1cd54` |
| `b4928eb` 限制恢复探测 | `a43887f`，并覆盖 Provider Worker |
| `f1be606` 大请求上传死锁 | `a34aa5c`，覆盖 standalone、Edge、Worker；`7286b76` 修复 Node 22 下上传超时定时器提前退出 |
| `06a4262` 账号级熔断隔离 | `94f9f15` |
| `d8c9097` 运行数据目录隔离 | `CODEX_PROXY_STORAGE_ROOT` 和隔离数据根实现 |
| `73631a2` 第三方声明 | `0616c77` 恢复可分发声明 |
| `06cd8d5` macOS 私密浏览器 | 模块化登录实现中的 macOS 浏览器探测 |

`02108d3` 的旧 `/control/code-turns` 进程内状态接口没有 Code 端消费者，且其恢复职责已经
由 Edge/Gateway Turn 幂等、Provider Worker Turn Store 和持久化结算 outbox 取代，因此
不进入当前发布候选。

## 已完成的候选验证

- root standalone/Edge/Provider Worker：`186/186`；
- Gateway：`154/154`；
- Admin Web：`31/31`；
- 请求体聚焦测试：`6/6`，连续执行 `20` 轮通过；
- TypeScript、JavaScript 和 PowerShell 检查通过；
- Gateway 与 Admin 生产构建通过；
- Provider Worker 发布边界：`29` 个 allowlist 文件；
- Provider Worker 制品：`30` 个文件；
- `npm audit`：`0 vulnerabilities`；
- `npm run test:dev-scripts` 在独占固定测试端口后通过；
- 本地 `npm run release:check` 的各组成门禁均已分别通过；两次聚合运行分别因已有预发布
  Edge 占用 `47921`、并发任务瞬时占用 `47930` 而在固定端口前置检查处停止，不属于代码失败；
- 共享 `47892` 未重启，验证期间 PID 保持 `50904`；
- 预发布 Edge 在门禁后恢复为健康 `edge` 模式；
- 候选运行时修复提交：`7286b76 fix(proxy): keep upload timeout timers referenced`；
- GitHub Windows `Release gate` 需在候选分支推送后再次确认全绿。

## 推荐发布顺序

1. 推送 `codex/proxy-mvp-release-integration`。
2. 创建 PR，目标为 `codex/provider-worker-mvp`。
3. 等待 Windows `Release gate` 全绿后合并 PR。
4. 封闭测试使用预发布版本 `2.5.0-rc.1`；不要直接宣称生产稳定版。
5. 从最终合并 SHA 构建三个边界：
   - Edge：只包含 Edge allowlist，交给 AI Editor Code 安装包；
   - Gateway：生产构建、迁移工具和管理 Web；
   - Provider Worker：使用 `npm run provider-worker:build-release` 生成独立制品。
6. Oscar 在 Code 仓库更新 `build/ai-editor-proxy/release.json` 时，必须填写最终服务器
   完整 SHA，且只有正式 Gateway HTTPS origin 固定后才把产品目标切到 `edge`。
7. 先部署隔离预发布 Gateway/Worker，执行真实登录、改密、模型目录和 SSE Turn。
8. 生产采购、备案、KMS/PostgreSQL、mTLS、异机备份和审批通过后，再发布稳定 Tag。

## 禁止操作

- 不把 `master` 强推或 merge 到服务器 MVP；
- 不用 Black 分支覆盖 Provider Worker 分支；
- 不批量合并所有 Bug 分支；
- 不把 `.ai-editor-dev`、数据库、Token、日志、PID、nonce、`node_modules` 或发布 ZIP
  提交到 Git；
- 不用服务器发布流程重启共享 `127.0.0.1:47892`；
- 不在生产条件未完成时创建稳定版 Tag。
