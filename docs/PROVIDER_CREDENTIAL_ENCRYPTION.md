# Gateway Provider 凭据加密与轮换

Gateway 从 `envelope-v1` 开始不再新建明文 Provider 凭据。数据库中的
`provider_credentials.secret_payload` 只保存 AES-256-GCM 信封；API、诊断和维护 CLI
只返回掩码、计数及 Key ID，不返回 API Key、Access Token 或 Refresh Token。

## 安全边界

- 每条凭据使用随机 96-bit nonce 和 128-bit GCM authentication tag。
- AAD 同时绑定 `provider_id` 与 `credential_id`，密文不能复制到另一条记录使用。
- 信封包含 `version`、`algorithm`、`key_id`、`nonce`、`ciphertext` 和 `tag`。
- 主密钥必须正好为 32 bytes，不进入 Gateway 数据库。
- 启动时会验证所有信封，包括已禁用 Provider 的凭据。Key 缺失、信封篡改或 AAD 不匹配
  都会使 Gateway fail-closed。
- 遗留 `plaintext-v1` 只允许在回环 development/test 中临时存在；production 仍会拒绝
  启动，必须先离线迁移。

## 主密钥来源

### Windows development

Gateway 首次启动时生成 Keyring，并使用 Windows DPAPI `CurrentUser` 保护后写入隔离的
`AI_EDITOR_GATEWAY_DATA_ROOT`。只有同一个 Windows 用户可以解封。不要把
`*.gateway-secret` 复制到 Git、日志或诊断包。

### macOS development

Keyring 保存在当前用户的 macOS Keychain；数据目录只保存不含密钥的 service/account
定位元数据。

### Production、Linux 或外部 KMS

通过 Secret Manager/KMS adapter 注入 Keyring。内置环境适配格式如下；尖括号表示
占位符，不能原样使用：

```json
{
  "version": 1,
  "active_key_id": "provider-key-2026-07",
  "keys": {
    "provider-key-2026-06": "<32-byte-key-as-base64>",
    "provider-key-2026-07": "<32-byte-key-as-base64>"
  }
}
```

- `AI_EDITOR_GATEWAY_PROVIDER_KEYRING`：上述 JSON，必须由秘密管理系统注入。
- `AI_EDITOR_GATEWAY_PROVIDER_ACTIVE_KEY_ID`：可选，用于覆盖 active Key，便于受控切换或
  回滚。
- production 缺少 Keyring 时拒绝启动。
- 不要把 Keyring 放入仓库、`.env`、命令行参数、工单或聊天记录。
- `createGatewayApp({ providerCredentialKeyring })` 是 KMS/HSM adapter 的程序化注入边界。

Keyring 最多保留 16 个 Key。轮换后必须保留旧 Key，直到重包验证、备份验证和观察期均
完成；否则旧信封将无法解密。

## 维护命令

从仓库根目录执行：

```powershell
# 只校验，不修改数据库
npm run gateway:provider-credentials -- --verify

# 预览遗留明文迁移
npm run gateway:provider-credentials -- --migrate --dry-run

# 在单个数据库事务中迁移所有 plaintext-v1
npm run gateway:provider-credentials -- --migrate

# 预览/执行逐凭据重包
npm run gateway:provider-credentials -- --rewrap --dry-run
npm run gateway:provider-credentials -- --rewrap

# Windows/macOS development：生成新 active Key 并重包
npm run gateway:provider-credentials -- --rotate-key

# Windows/macOS development：把旧 Key 重新设为 active 并重包回旧 Key
npm run gateway:provider-credentials -- --activate-key <OLD_KEY_ID>
```

`--migrate` 和 `--rewrap` 会先校验信封，并对每次 seal/open 做回读验证。任意凭据失败、
记录被并发修改或数据库更新失败都会回滚整个事务。CLI 报告只包含凭据数量、active Key
和旧 Key ID。

## 上线迁移流程

1. 停止所有会写 Provider 配置的 Gateway 实例。`--verify` 可以在线执行，但迁移、轮换
   和重包必须离线执行，避免运行进程继续持有旧 Keyring。
2. 备份数据库和受保护的 Keyring，并验证备份可恢复。备份仍按敏感资产管理。
3. 注入同时包含旧 Key 与新 Key 的 Keyring；先保持旧 Key active。
4. 执行 `--verify`，修复 Key 缺失或信封损坏。
5. 执行 `--migrate --dry-run`，确认计数后执行 `--migrate`。
6. 把新 Key 设为 active，执行 `--rewrap --dry-run` 和 `--rewrap`。
7. 再次执行 `--verify`，确认 `plaintextCredentials=0` 且所有信封使用预期 Key。
8. 启动 Gateway，完成 Provider 列表、模型目录和隔离请求验收。
9. 观察期结束前保留旧 Key。确认无需回滚后，才从外部 KMS Keyring 删除旧 Key。

Windows/macOS development 可以用 `--rotate-key` 合并第 3、6 步。该命令先持久化包含新旧
Key 的 Keyring，再执行重包；重包失败时旧 Key 仍保留，可修复后重试。

## 回滚

- 外部 KMS/production：重新把旧 Key 设为 active，保留新旧 Key，执行 `--rewrap`，
  `--verify` 后重启 Gateway。
- Windows/macOS development：执行 `--activate-key <OLD_KEY_ID>`，随后 `--verify`。
- 不要通过恢复明文数据库、删除 `key_id` 或关闭启动校验来回滚。

如果旧 Key 已被删除且没有受保护备份，AES-GCM 信封无法恢复；系统会按设计拒绝启动。
