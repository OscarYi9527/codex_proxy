# Codex Proxy 待办事项

## P0：Gateway / Edge 协作迁移与仓库管理

### 仓库和文件存放

- [x] 明确 `codex_proxy-black` 是 Black（当前用户）的开发仓库，不是同事仓库。
- [x] 约定两个项目统一放在 `F:\AI\codex-collaboration` 下的独立子目录中。
- [ ] 将当前 `F:\AI\codex_proxy` 可控迁移为
  `F:\AI\codex-collaboration\codex_proxy-black`，迁移前不得影响正在运行的 Proxy。
- [x] 编写 `docs/COLLABORATION_WORKSPACE.md`，明确同事仓库、remote、worktree 和合并门禁。
- [x] 已记录同事仓库 `OscarYi9527/My_Code`、分支 `codex/account-gateway-mvp`
  和最新合同交付 commit `dca68160b`。
- [x] 已将同事仓库克隆到 `F:\AI\codex-collaboration\My_Code`，并确认工作区干净。
- [x] 已确认 `My_Code` 与 `codex_proxy-black` 没有共同 Git 历史；禁止将两个根仓库
  直接合并，后续通过 API 合同和端到端测试完成产品集成。
- [ ] 基于 `origin/feature/custom-api-urls@e3ed1d6` 在
  `F:\AI\codex-collaboration\worktrees\gateway-integration` 创建独立集成 worktree。
- [ ] 合并前分别确认两个仓库工作区干净，并记录双方基线 commit。
- [ ] 检查同事交付不包含数据库、`.env`、Token、API Key、日志、运行状态或 `node_modules`。
- [ ] 禁止覆盖 `origin`、强制推送、嵌套 `.git` 和直接合并无共同历史的整个仓库根目录。

### 阶段 0：现有能力审计

- [x] 更新并验证 `feature/custom-api-urls`，运行 `npm test`、`npm run check` 和
  `npm run release:check`。
- [x] 对照 T001–T120 将现有能力分为：可直接复用、修改后复用、完全缺失、接口合同冲突。
- [x] 新增 `docs/AI_EDITOR_GATEWAY_BASELINE_AUDIT.md`，记录模块、任务编号、复用结论、
  修改项和测试证据。
- [x] 确认 Gateway 稳定起点为 `feature/custom-api-urls@e3ed1d6`；新分支使用
  `feature/ai-editor-account-gateway` 并注明堆叠依赖。
- [x] 不重复开发已经完成的额度、账号路由、诊断、成本和管理模块。

### 阶段 1：Gateway / Edge 基础框架

- [x] 从 `feature/custom-api-urls@e3ed1d6` 创建并推送堆叠分支
  `feature/ai-editor-account-gateway`。
- [x] 增加 `standalone`、`edge`、`gateway` 三种隔离运行模式，并保持 standalone 为默认。
- [x] 建立 TypeScript Gateway、React 管理页面、SQLite 数据层和 PostgreSQL 适配边界。
- [x] Gateway 使用 `127.0.0.1:47920`，Edge 使用 `127.0.0.1:47921`，不得读写共享 `47892`。
- [x] 提供 Gateway/Edge 独立启动、停止、单实例保护、隔离数据目录和 `/live`。
- [x] 保证 standalone 全部现有回归测试继续通过。
- [x] 完成 T002–T007 与 T009–T021；T008 的真实密钥后端随产品认证阶段实现。

### 阶段 2：先向 Oscar 提供 Mock 合同

- [x] 实现 `GET /ai-editor/status` 和状态重试、handoff、webview ticket、logout、models 最小接口。
- [x] Mock 支持 `ready`、`login_required`、`account_unavailable`、
  `service_unavailable`、`password_change_required`。
- [x] 首轮交付文档提供分支、启动命令、接口地址、Mock 切换方式、已实现和未实现接口。
- [x] Oscar 可以不依赖真实账号服务开发账户菜单、状态栏、Turn 门禁和管理 Webview。

### 阶段 3–4：产品账号与 Edge

- [x] 实现一次性管理员临时密码、首次强制改密、邮箱和邀请码注册；最后一个一级管理员
  保护随 T075–T078 管理 API 完成。
- [x] 实现浏览器登录、PKCE、随机 state、随机回调端口和一次性授权码。
- [x] Access Token 有效期 5 分钟；Refresh Token 滚动 30 天，并检测重放后撤销设备会话。
- [x] 未登录、禁用、到期或待改密账号不能发送新 Turn；Gateway 转发与客户端 socket
  解耦，为后续结算保留完成机会。
- [x] Edge 只保存产品账号 Refresh Token；Access Token 仅存内存，不保存任何中央上游凭据。
- [x] Windows 使用 DPAPI、macOS 使用 Keychain；退出后 `/v1` 返回未登录且 `/live` 可访问。

### 阶段 4.5：真实模型和 Responses 链路

- [x] 完成 T038–T046 的 Edge/Gateway 模型、Responses 和兼容 Chat Completions 转发。
- [x] 捕获在途账号绑定，账号切换不会改写已接受 Turn 的 Access Token 和设备会话。
- [x] 复用现有 Provider 路由模块，并用 Gateway 隔离存储根阻止读取共享 `47892` 数据。
- [x] 动态模型目录只列出隔离 Gateway 已配置 Provider，并过滤 `gpt-mock`。
- [ ] T047/T048 由 Oscar 使用真实订阅和非订阅 Provider 完成联合验收。

### 阶段 4.6：真实 AI Editor 管理页面

- [x] 完成 T049/T052 的一次性 Webview ticket、HttpOnly Cookie、过期/重放和关闭撤销。
- [x] 完成 T050/T054 的 React 管理外壳、同源 bootstrap 校验和服务端角色导航。
- [x] 完成 T053 的 Edge 安全状态与 Webview ticket 真实转发。
- [x] 完成 T055 的普通用户账号、积分、设备和使用记录页面。
- [x] 管理会话和页面不把 ticket、Token、Provider 凭据写入 URL、Web Storage 或日志。

### 阶段 5–6：组织、权限、积分和并发风险

- [ ] 在 Gateway API 强制执行一级管理员、二级管理员、组织用户权限和跨组织 `403`。
- [ ] 对角色提升、跨组织访问和管理员正文查看写安全审计。
- [ ] 实现组织月度积分池、用户积分分配、月底清零和按实际 Token/模型倍率扣分。
- [ ] 为每个 Turn 建立幂等风险记录；并发 Turn 不重复占用，同一 Turn 重试不重复扣费。
- [ ] 超过风险限制只阻止新 Turn；缺少上游 Token 用量时使用保守估算并明确标记。

### 阶段 7–9：Provider、管理页面和审计保留

- [x] 通过兼容适配器将现有 ChatGPT、OpenAI API、DeepSeek、Relay、模型目录和路由接入
  Gateway；中央 Provider 管理 API、凭据轮换与角色化诊断仍待 T083–T092。
- [ ] Edge、普通用户和二级管理员不能获取中央凭据、成本、熔断或 Provider 路由诊断。
- [ ] React 页面继续覆盖二级管理员组织管理和一级管理员 Provider/系统管理；当前角色导航
  已由 Gateway 强制，普通用户页面已完成。
- [x] Token 不进入 URL 或 `localStorage`，管理页面可安全嵌入 Code Webview。
- [ ] 仅保存用户提问、最终回复、时间、模型、Token 和扣分；禁止保存系统提示词、文件原文、
  推理、工具输出、完整上游请求及 Refresh Token。
- [ ] 正文默认保留 30 天，组织可配置 7–180 天；到期删除正文并保留匿名统计。

### 阶段 10：测试和交付

- [ ] 增加 Gateway 单元测试、API 合同测试、Edge 转发、Token 轮换/重放、组织越权、
  并发积分结算、凭据泄露和 React 页面测试。
- [x] 第一轮已覆盖公共模块、配置、SQLite/PostgreSQL repository、Gateway Mock、
  Edge nonce/handoff 防重放、三模式和开发脚本生命周期。
- [x] 增加真实 PKCE、Argon2id、授权码/Refresh Token 重放、DPAPI envelope、
  单飞刷新、绑定切换、动态模型和非 Mock 本机 Relay 流式链路测试。
- [ ] Gateway/admin 新增代码覆盖率不低于 80%。
- [ ] 每次交付固定提供分支、SHA、启动命令、数据库迁移、接口变化、测试结果和已知问题。
- [ ] 所有合并先在独立 integration worktree 完成备份、冲突审计、全量测试和回滚验证。

## P0：近期

- [x] 在账号池中显示每个 ChatGPT 账号的 5 小时、每周剩余额度。
- [x] 兼容 ChatGPT `wham/usage` 的新旧响应结构，并补充额度解析测试。
- [x] 提供可选账号路由模式：`priority`、`round-robin`、`headroom`、`least-used`、`latency`、`reliable`、`weighted`、`random`、`lkgp`。
- [x] 支持拖拽调整账号优先级，并支持设置每账号路由权重。
- [x] 支持账号“仅保存/启用路由”状态，新登录账号默认不参与路由。
- [x] 合规稳定模式：单账号并发 3、忙碌请求等待队列、每请求最多尝试 2 个账号、额度新鲜度保护。
- [x] 自适应并发、公平等待队列、请求租约续期与断连取消联动。
- [x] Token/额度刷新单飞合并、Token 失败分级和额度趋势预测。
- [x] 模型/账号双层冷却、优雅重启、单实例、配置快照回滚和脱敏诊断。
- [x] 额度刷新降频并加入随机抖动、失败指数退避，后台跳过仅保存账号。
- [x] 默认按额度余量执行 `headroom` 账号选择，并避让低于阈值的账号。
- [x] 按 `session-id` / `thread-id` 实现 Last-Known-Good 账号粘性，减少上下文缓存失效。
- [x] 建立统一错误分类：请求错误、Token 临时/永久失败、账号冷却、模型锁定、上游故障。
- [x] 为 408/5xx 和网络故障增加轻量 Provider Circuit Breaker 和半开恢复。
- [x] 补齐账号轮换矩阵：429、网络错误、Token 刷新失败、全冷却/安全线/并发满/队列超时、客户端取消和两次尝试后的可诊断 503。
- [x] 显示实际运行路径、版本、Commit 与安装一致性，并提供备份、部署、重启、健康检查和失败自动回滚。
- [x] 官方登录前预检全局/VS Code Codex、`app-server` OAuth 能力与私密浏览器，并提供可复制诊断和修复命令。
- [x] 半开熔断探测超时后允许新请求接管，避免取消或异常探测永久卡死。

## P1：可观测性与安全

- [x] 为每次代理请求生成 request ID，并记录 provider、account、model、延迟和回退次数。
- [x] 在响应中加入 `X-Codex-Proxy-*` 路由元数据头。
- [x] 在管理后台增加账号健康矩阵：额度、成功率、请求数、429、最近状态、P50/P95/平均延迟。
- [x] 在管理后台增加最近错误详情、冷却原因、自适应并发和队列状态。
- [x] 对日志中的 Authorization、API Key、Refresh Token 和 JWT 统一脱敏。
- [x] 配置文件改为同目录临时文件 + rename 原子写入。
- [x] 在 Windows 上收紧安装目录和凭据文件 ACL。
- [x] 使用 Windows DPAPI 保护本机 AES-256-GCM 密钥，并加密配置与账号备份中的凭据。
- [x] 为管理配置、统计、脱敏和韧性模块补充自动化测试。
- [x] 建立自动诊断中心，联合解释 401/402/429/502/503、账号池分类、Provider 和熔断，并提供上下文操作。
- [x] 将账号池、教程、分析和设置前端拆成独立模块，并增加 DOM 行为测试。
- [x] 将登录、账号、诊断和运维管理接口拆出 `src/admin.js`。
- [x] 建立 `CHANGELOG.md`、统一运行文件清单和发布前版本一致性检查。

## P2：智能路由

- [x] 支持默认关闭、需显式开启的跨 Provider 回退链，并按状态/错误类型禁止 401/402 等盲目重试。
- [x] 支持 `auto`、`auto-fast`、`auto-cheap`、`auto-reliable` 虚拟模型。
- [ ] 支持模型别名和按请求头临时覆盖路由策略。
- [x] 增加按剩余额度、延迟和成功率综合评分的 `reliable` 账号路由。
- [x] 增加路由决策说明，展示最近请求为何选择或跳过某个账号。

## P2：额度与成本

- [x] 显示 5 小时/每周剩余额度和重置倒计时。
- [x] 支持可配置低额度阈值，并自动避让低额度账号。
- [x] 持久化额度快照，根据消耗速度预测到达安全余量的时间。
- [x] 支持每账号独立安全余量、每日请求/Token 上限、模型/会话预留和自动到期的紧急继续。
- [x] 建立可更新的模型价格目录，统计每次请求和每日/月度预估成本。
- [x] 通过 `auto-cheap` 和 Provider 日/月预算实现成本优化、免费线路回退或停止请求。
- [ ] 暂不实现团队公平份额、多人配额池和按用户拆分额度。

## P3：后续优化

- [ ] 为 `latency` / `reliable` 策略加入少量探索流量，避免新账号长期没有采样。
- [x] 将熔断状态、恢复倒计时和手动重置加入管理后台。
- [x] 持久化 Provider 最近健康状态、延迟、错误来源和检测时间。
- [x] 为账号与 Provider 健康增加 1h、24h、7d 可交互窗口、趋势预警、熔断及账号切换统计。
- [ ] 增加更细粒度的时间序列折线图和趋势数据导出。
- [x] 增加配置历史、回滚、日志轮转和 Windows 凭据文件 ACL。

## 约束

- 保持项目轻量，不直接引入 OmniRoute 的 Next.js、Electron、MCP 或大型数据库体系。
- 新路由能力默认兼容现有配置，失败时回退到当前 `priority` 行为。
- 涉及运行中代理的变更先完成代码和测试，再安排可控重启。
