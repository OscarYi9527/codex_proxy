# RK3588 日本节点中转部署

## 1. 推荐路线

采用“私网入口与公网出口分离”的成熟方案：

```text
同事的 Codex / OpenAI 兼容客户端
  │  HTTPS + Tailscale ACL + 独立客户端 Bearer Key
  ▼
RK3588 Tailscale Serve（tailnet 私域名，公网不开放端口）
  │  loopback http://127.0.0.1:47930
  ▼
codex-proxy rk3588 模式（鉴权、并发上限、流式透传、请求大小/超时门禁）
  │  HTTPS + 独立的 RK→日本 Bearer Key
  ▼
日本节点 Responses 兼容入口
  │  日本节点自己的上游认证
  ▼
Codex / OpenAI Responses 兼容服务器
```

这条路线默认不把 RK3588 暴露到公网。Tailscale 基于 WireGuard 提供设备身份、私域 DNS
和 ACL；应用层再校验独立 API Key，避免“进入 tailnet 就自动获得模型权限”。RK3588
只监听 `127.0.0.1`，只有本机 Tailscale Serve（或等价本机 TLS 反代）能够访问。

如果团队必须自托管控制面，可把 Tailscale 控制面替换成 Headscale；应用层和日本上游
配置不变。不建议直接把 Node 端口绑定到 `0.0.0.0`，也不建议使用临时公网隧道作为生产
入口。

## 2. 已实现的运行边界

- 模式：`node src/launcher.js --mode rk3588` 或 `npm run start:rk3588`。
- 本机监听：默认 `127.0.0.1:47930`，代码拒绝绑定公网地址。
- 私域 Host 白名单：`RK3588_ALLOWED_HOSTS`。
- 客户端鉴权：`RK3588_CLIENT_API_KEY_FILE`，只保存 SHA-256 摘要到可枚举配置。
- 日本上游：`RK3588_UPSTREAM_ORIGIN` 必须是无路径、无凭据的精确 HTTPS origin。
- 上游鉴权：`RK3588_UPSTREAM_API_KEY_FILE`，入站 Key 永远不会转发到日本节点。
- 支持接口：
  - `GET /v1/models`
  - `POST /v1/responses`
  - `POST /v1/chat/completions`
  - `GET /live`
  - `GET /ready`
- SSE 和普通响应均按流透传；不会缓存请求或模型正文。
- 已接受的 POST 不在 RK3588 自动重试，避免重复执行和重复计费。
- 默认最大 8 个在途请求、16 MiB 请求正文、10 分钟上游超时。
- 只转发白名单响应头，不转发 Cookie、上游认证或任意代理头。
- `NODE_TLS_REJECT_UNAUTHORIZED=0` 时启动失败；私有 CA 使用
  `NODE_EXTRA_CA_CERTS`，不得关闭证书校验。

## 3. 前置条件

1. RK3588 使用 64 位 Linux（`uname -m` 应为 `aarch64`），安装 Docker Engine、
   Compose plugin 和 Tailscale。
2. 日本节点提供 HTTPS 的 Responses 兼容入口，并至少支持 `/v1/models` 和
   `/v1/responses`。
3. 日本入口签发一枚只供 RK3588 使用的 Key；不要复用同事访问 RK3588 的 Key。
4. 团队成员和 RK3588 加入同一个 tailnet；用 ACL 只允许指定用户/设备访问 RK3588
   的 TCP 443。
5. RK3588 时间同步正常，系统和容器基础镜像已更新。

## 4. RK3588 部署

### 4.1 准备凭据文件

容器使用 UID/GID `10001`。凭据必须是单行、32–4096 字节，并且不能被 group/other
读取。下列命令不会把 Key 写入 Compose 或 Git：

```bash
sudo install -d -o 10001 -g 10001 -m 0700 /etc/codex-rk3588

# 生成“同事 → RK3588”Key；把终端输出保存到团队密码管理器。
CLIENT_KEY="$(openssl rand -base64 48)"
printf '%s\n' "$CLIENT_KEY" \
  | sudo tee /etc/codex-rk3588/rk3588-client-api-key >/dev/null
printf 'RK3588 client key (store once): %s\n' "$CLIENT_KEY"
unset CLIENT_KEY

# 使用 sudoedit 粘贴日本节点签发的“RK3588 → 日本”Key。
sudoedit /etc/codex-rk3588/japan-upstream-api-key

sudo chown 10001:10001 /etc/codex-rk3588/*-api-key
sudo chmod 0400 /etc/codex-rk3588/*-api-key
```

不要把 Key 放到 shell 命令参数、`.env`、Git、聊天消息或截图中。

### 4.2 配置并启动容器

```bash
cd /opt/codex_proxy/deploy/rk3588
cp .env.example .env
chmod 0600 .env
editor .env
```

至少修改：

```dotenv
RK3588_ALLOWED_HOSTS=rk3588-relay.<你的-tailnet>.ts.net
RK3588_UPSTREAM_ORIGIN=https://jp-relay.example.com
```

origin 末尾不能带 `/`。启动前先展开 Compose 配置，再构建 ARM64 镜像：

```bash
docker compose config
docker compose build --pull
docker compose up -d
docker compose ps
docker compose logs --tail=100 rk3588-relay
curl --fail http://127.0.0.1:47930/live
```

镜像基于官方 Node 22 Debian ARM64 镜像，RK 模式只使用 Node 内置模块，不需要在设备上
编译 `better-sqlite3` 等 Gateway 原生依赖。容器为只读根文件系统、移除全部 Linux
capability、启用 `no-new-privileges`，并限制为 2 CPU/512 MiB。

### 4.3 发布 tailnet 私域 HTTPS

先检查设备上是否已有 Serve 配置，避免覆盖其他服务：

```bash
sudo tailscale serve status
sudo tailscale serve --bg --https=443 http://127.0.0.1:47930
sudo tailscale serve status
```

Tailscale 分配的 HTTPS 域名必须与 `.env` 的 `RK3588_ALLOWED_HOSTS` 完全一致。若当前
版本的 Serve 保留外部 Host（通常如此），请求会通过；Host 不一致会由应用返回
`403 invalid_host`。

在 tailnet policy 中为 RK 节点设置专用 tag，并只授权团队组访问 TCP 443。策略语法会
随 Tailscale 版本演进，应在管理控制台 policy test 通过后再保存。不要授权 `*` 到 RK
节点的全部端口。

Tailscale Serve 参考：
<https://tailscale.com/kb/1242/tailscale-serve>

## 5. 日本节点

日本入口可以是团队已有的 Responses 兼容网关，也可以再次运行本仓库的同一只读镜像，
形成“RK relay → Japan relay → 最终 Codex server”两跳：

1. 日本 relay 的客户端 Key 设为 RK 的
   `/etc/codex-rk3588/japan-upstream-api-key` 对应值。
2. 日本 relay 的 upstream origin 指向最终 HTTPS Codex/OpenAI 兼容服务器。
3. 日本 relay 使用另一枚独立上游 Key；绝不能把最终服务器 Key 下发给 RK 或同事。
4. 日本入口同样使用 TLS、来源 ACL/防火墙、最小端口和请求并发限制。

仓库测试 `runs the complete colleague -> RK3588 -> Japan -> Codex chain` 会启动两个
真实 HTTP relay 和一个隔离 Codex mock，验证每一跳都替换 Bearer Key、正文只转发一次，
并返回最终响应。生产部署仍需用真实日本地址做第 8 节验收。

## 6. 同事接入

先用专用 Key 验证模型目录：

```bash
export RK3588_CLIENT_API_KEY='<从密码管理器读取>'
export RK3588_BASE_URL='https://rk3588-relay.<你的-tailnet>.ts.net/v1'

curl --fail-with-body \
  -H "Authorization: Bearer $RK3588_CLIENT_API_KEY" \
  "$RK3588_BASE_URL/models"
```

Codex 的自定义 provider 应写在用户级 `~/.codex/config.toml`，不要把 provider 和 Key
提交到项目级 `.codex/config.toml`：

```toml
model = "由日本节点实际提供的模型 ID"
model_provider = "rk3588_jp"

[model_providers.rk3588_jp]
name = "RK3588 via Japan"
base_url = "https://rk3588-relay.<你的-tailnet>.ts.net/v1"
env_key = "RK3588_CLIENT_API_KEY"
wire_api = "responses"
```

Codex 当前手册的 Custom model providers 说明了 `base_url`、`env_key` 和
`wire_api = "responses"` 的配置方式：
<https://developers.openai.com/codex/codex-manual.md#configuration-auth-and-models>

每位同事最好使用独立 Key。当前第一版使用一个文件 Key；若需要逐人撤销、审计和速率
配额，应在下一迭代引入短期 JWT/OIDC，而不是无限增加长期共享 Key。

## 7. 配置项

| 变量 | 默认值 | 说明 |
|---|---:|---|
| `RK3588_RELAY_HOST` | `127.0.0.1` | 只能为 loopback |
| `RK3588_RELAY_PORT` | `47930` | 不得与 47892/47920/47921 冲突 |
| `RK3588_ALLOWED_HOSTS` | 无 | 逗号分隔的私域 Host；自动加入本机 Host |
| `RK3588_CLIENT_API_KEY_FILE` | 无 | 同事访问 Key 文件，必填 |
| `RK3588_UPSTREAM_ORIGIN` | 无 | 日本节点精确 HTTPS origin，必填 |
| `RK3588_UPSTREAM_API_KEY_FILE` | 无 | RK 访问日本节点 Key 文件，必填 |
| `RK3588_MAX_IN_FLIGHT` | `8` | 1–256 |
| `RK3588_BODY_LIMIT_MB` | `16` | 1–64 MiB |
| `RK3588_UPSTREAM_TIMEOUT_MS` | `600000` | 1 秒–30 分钟 |
| `NODE_EXTRA_CA_CERTS` | 无 | 可选私有 CA bundle |

修改凭据文件后必须重启容器。推荐先在日本节点撤销旧 Key，再更新 RK 文件并立即重启；
客户端 Key 轮换则先通知同事，在短维护窗口替换并重启。

## 8. 上线验收与回滚

必须在真实设备记录以下脱敏证据：

```bash
uname -m
docker compose ps
curl --fail http://127.0.0.1:47930/live
tailscale serve status

# 从团队另一台 tailnet 设备执行
curl --fail-with-body \
  -H "Authorization: Bearer $RK3588_CLIENT_API_KEY" \
  "https://<RK私域名>/v1/models"
```

再发送一个最小、非敏感的 `/v1/responses` 流式请求，确认：

1. RK 日志只有请求 ID，不含 Key 和正文。
2. 日本日志看到对应请求，最终服务器只收到一次 POST。
3. SSE 能持续返回并出现完成事件。
4. 错误 Key 返回 401；非 tailnet 设备无法建立连接。
5. 日本节点停止时 RK 返回脱敏 502/504，不泄漏地址或凭据。

回滚只停止 RK 服务和 Tailscale Serve 映射，不删除凭据，便于调查：

```bash
cd /opt/codex_proxy/deploy/rk3588
docker compose stop rk3588-relay
sudo tailscale serve status
```

先根据 `tailscale serve status` 精确删除本服务映射；不要在承载其他服务的设备上盲目执行
全局 `tailscale serve reset`。确认不再回滚后，再分别撤销客户端 Key 和日本上游 Key。

## 9. 当前责任边界

自动化测试和本机门禁能证明代码、鉴权、并发、流式和两跳链路可运行；无法替代真实
RK3588、tailnet ACL、日本节点证书/Key 和最终 Codex 账号的现场验收。没有第 8 节的脱敏
证据，不应宣称生产上线完成。
