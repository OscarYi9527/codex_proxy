# AI Editor Provider Worker T135 交接

更新时间：2026-07-20
分支：`codex/provider-worker-mvp`
任务：T135 / PW2

## 已实现

1. Worker 持久化 execution/outbox：
   - 独立文件 `provider-worker-executions-v1.json`；
   - 原子写入并限制为仅当前用户可读写（Windows 继承隔离数据目录 ACL）；
   - 只保存 Turn ID、请求摘要、execution/outbox ID、Provider、Token 用量和确认状态；
   - 不保存用户问题、AI 回复、系统提示词、工具输出、API Key、订阅 Token 或
     `auth.json`。
2. Worker 重启安全：
   - 已完成、未确认的用量在重启后继续出现在 outbox；
   - 重启前处于运行中的 Turn 标记为 `recovery_required`，禁止自动重跑可能已经到达
     上游的请求；
   - 已完成 Turn 在内存 SSE 缓存消失后不重新调用 Provider，只等待 Gateway 对账。
3. 签名用量回执：
   - 新增 `aieditor-usage-v1` HMAC-SHA256 规范；
   - 回执绑定 outbox、execution、Turn、Worker、地区、Provider、输入/输出 Token 和
     完成时间；
   - Gateway 使用常量时间比较签名，并拒绝 Worker/地区或用量字段篡改。
4. Gateway 结算与确认：
   - `GET /internal/v1/usage/outbox?limit=1..100`；
   - `POST /internal/v1/usage/outbox/ack`；
   - Gateway 只使用验证通过的回执结算；
   - 结算后发送签名确认；同一 settlement ID 可幂等重试，冲突确认被拒绝；
   - 每 15 秒后台拉取遗留 outbox，Gateway 重启或确认网络失败不会重复调用 Provider。
5. 发布边界：
   - Worker 发布清单加入 `src/provider-worker/execution-store.js`；
   - 独立制品仍不包含 Gateway、Admin、Edge、产品账号数据库或 standalone 服务。

## 自动化验证

- Proxy/Edge/Worker 根测试：`155/155`
- Gateway：`117/117`
- Admin Web：`28/28`
- T135 专项覆盖：
  - Worker 完成后持久化及重启恢复；
  - 用量回执签名和篡改拒绝；
  - 批量确认原子性；
  - 重复确认幂等；
  - Gateway 结算失败保留 outbox；
  - 中断执行重启后禁止自动重跑；
  - 持久化文件不包含请求、回复和 Token。
- `npm run release:check`：通过
- `npm audit --audit-level=high`：`0 vulnerabilities`
- Provider Worker 制品：`29` 个文件，实际启动
  `/live=ok`、`/ready=ready`，结束后 `47930` 已释放
- 共享 `47892` 验证前后均为 PID `26120`、`/live=ok`，本任务未停止、重启、修改或迁移

## 仍未完成

1. T136 / PW3：
   - AES-256-GCM 信封加密；
   - KMS/Secret Manager；
   - Worker 刷新 Token 安全持久化；
   - 凭据版本、轮换、迁移和备份恢复门禁。
2. 专用真实 ChatGPT 测试账号联合验收。
3. 国内 Gateway、境外 Worker、生产 mTLS 证书和公网部署。

当前 Worker 仍只在进程内保存明文订阅凭据。T135 文件不包含凭据，但它不能替代 T136；
T136 未完成前禁止开放公网用户。

## 下一阶段人工门禁

- 当前不需要购买服务器或导入真实账号。
- 开始 T136 本地加密实现前不需要 Oscar 付款。
- 进入真实 Provider 联调前，需要 Oscar 准备一个获授权的专用测试订阅账号，并只通过
  隔离 Gateway 一级管理员页面导入。
