# 全链路 Secret Scan

日期：2026-07-21
适用范围：Standalone、Edge、AI Editor Gateway、Git 门禁、数据库、日志与备份

## 1. 目标

Secret Scan 用于阻止凭据进入 Git、诊断响应、持久化错误、数据库非凭据字段和明文备份。
扫描结果只记录规则类型、来源、路径和行列，不记录命中的原始内容。

当前规则覆盖：

- JWT、Authorization 头（Bearer、Basic）；
- OpenAI、Anthropic、GitHub、Google API Key；
- Access、Refresh、ID Token；
- OAuth 授权码、PKCE verifier、用户码和设备码；
- `redeem_request_id`、Webview ticket、Edge nonce；
- Provider `secret_payload`、私钥和常见敏感字段；
- `.env`、数据库、日志、备份、DPAPI/Gateway 密钥等敏感制品路径。

## 2. Git 门禁

```powershell
npm run secret:scan
node scripts/secret-scan.mjs --staged
node scripts/secret-scan.mjs --working
```

默认模式同时检查 staged diff、working diff 和未跟踪文件；工作树没有改动时检查 `HEAD`。
扫描器会合并同一文件的连续新增行，因此可识别跨行字段赋值和私钥头。

退出码：

- `0`：没有发现；
- `1`：发现秘密或敏感运行制品；
- `2`：扫描器自身失败，输出仍不会回显文件正文。

`npm run release:check` 已包含 Git Secret Scan，但发布检查还会执行隔离启动/部署合同。

## 3. 运行时响应守卫

以下 JSON 响应在序列化前执行结构化扫描：

- Standalone `/admin/api/*`；
- Edge 本地 JSON API 和模型列表；
- Gateway `/api/v1/*`。

发现秘密时，原响应会被替换为安全的 `500 secret_scan_blocked`，不会返回命中内容。

仅以下明确签发一次性凭据的端点获得最小豁免：

- Standalone 官方登录 `start`、`status`；
- Edge 本地 handoff `start`、Webview ticket；
- Gateway OAuth token、修改密码后的新 token、Webview ticket；
- Gateway Provider 官方登录 `start`、`status`。

这些端点仍受本机访问、认证、来源校验、短有效期或一次性消费约束。新增签发端点时必须显式
加入豁免并补充合同测试，不能豁免整个管理 API。

## 4. 日志、错误与审计

- Standalone 使用 `safeErrorText()`，在错误进入日志、账号健康、统计、熔断状态和 API
  之前统一脱敏。
- Gateway `SafeLogger` 递归脱敏对象、`Error`、`cause` 和敏感键。
- Provider 管理审计元数据写库前执行递归脱敏；数据库扫描作为第二道门禁。
- 登录会话状态只保存脱敏后的消息，不保存 app-server 原始 stderr 或协议错误正文。

## 5. Gateway 数据库扫描

```powershell
npm run gateway:secret-scan
```

扫描范围：

- `provider_credentials`：必须为有效 `envelope-v1`，明文和损坏信封直接失败；
- Provider 配置、模型路由策略；
- 管理审计安全元数据；
- 会话审计的 sanitized text；
- `gateway_meta`。

报告最多返回 100 个只含元数据的 finding。Production Gateway 在完成迁移后、开始监听前
自动执行扫描；任一 finding 都会使启动 fail-closed。

数据库 CLI 会连接配置指定的数据库并执行待应用 schema migration。生产运行前应确认数据库
目标和环境变量，不要对未知数据库盲目执行。

## 6. 备份保护

- 设置快照主动排除 API Key、Relay Key、ChatGPT 账号和活动账号标识，并在写盘和恢复前扫描。
- 账号备份必须先经过本机凭据加密；存在明文 Token 时拒绝创建文件。
- schema migration 备份在写盘前扫描；只允许 DPAPI 密文或 Provider 信封等受保护值。
- 初始化本机凭据保护时会同时加密遗留账号备份和 JSON migration backup。
- Windows 端到端测试覆盖“拒绝明文 → DPAPI 加密 → 正文无原 Token → 解密恢复”。

受保护值只允许出现在明确的存储扫描上下文；API 响应即使包含密文信封也会被拦截。

## 7. 处置流程

1. 不要把扫描失败文件正文复制到日志、Issue 或提交信息。
2. 根据 finding 的类型、文件路径或数据库表定位写入边界。
3. 如果秘密曾进入 Git 或外部日志，先撤销/轮换，再清理历史；仅删除当前文件不够。
4. 修复后运行定向测试、`npm run secret:scan` 和完整非部署测试。
5. 发布前运行 `npm run release:check`；若当前阶段禁止部署，保持工作项“待验收”。

## 8. 当前验证

2026-07-21 的 N008 非部署验证：

- `npm run check`；
- Standalone/Edge：157 tests；
- Gateway：84 tests；
- Admin：8 tests；
- Gateway/Admin production build；
- working-tree Secret Scan：0 findings；
- `git diff --check`。

按当前“不部署”要求，尚未执行包含隔离部署合同的 `npm run release:check`，因此 N008 和
S2 保持“待验收”而不是“已完成”。
