# 模型路由流程

用户发消息 → Claude Code → proxy(localhost:47891) 收到请求 → 开始路由

## 一、模型选择（resolveModelId）

```mermaid
flowchart TD
    A["请求到达 proxyRequest()"] --> B{"{sessionId}.override.json 存在?"}
    B -->|"是"| B1["读取 model 字段"]
    B1 --> B2["删除 override 文件（一次性）"]
    B2 --> B3{"model 在 models.json 中?"}
    B3 -->|"是"| OVERRIDE["✅ 使用 override 模型<br/><i>最高优先级</i>"]
    B3 -->|"否"| C
    B -->|"否"| C["检查 session 文件<br/>sessions/{id}.json"]
    C -->|"有且有效"| SESSION["✅ 使用 session 模型<br/><i>/models skill 写入</i>"]
    C -->|"无/无效"| D["解析请求 body.model"]
    D -->|"有且有效"| BODY["✅ 使用 body.model"]
    D -->|"无/无效"| E["读取 current-model.json"]
    E -->|"存在"| GLOBAL["✅ 使用全局默认模型"]
    E -->|"不存在"| HARD["✅ 兜底: claude-haiku-4-5"]

    OVERRIDE --> CHECK
    SESSION --> CHECK
    BODY --> CHECK
    GLOBAL --> CHECK
    HARD --> CHECK

    CHECK{"模型的 provider<br/>额度耗尽?"}
    CHECK -->|"否"| DONE["返回此 modelId"]
    CHECK -->|"是"| CHAIN{"有 fallback_chain?"}
    CHAIN -->|"否"| NULL["返回 null → 529"]
    CHAIN -->|"是"| WALK["遍历 fallback_chain"]
    WALK --> FB{"该候选 provider 耗尽?<br/>anthropic 无 API Key?"}
    FB -->|"跳过"| WALK
    FB -->|"可用"| FB_OK["返回此候选 modelId"]
    WALK -->|"全部不可用"| NULL
```

## 二、候选链发送（proxyRequest 迭代）

```mermaid
flowchart TD
    START["candidates = [modelId, ...fallback_chain]<br/>idx = 0"]
    START --> TRY{"idx < candidates.length?"}
    TRY -->|"否"| S529["⚠️ 529: 所有渠道耗尽"]
    TRY -->|"是"| BH["buildHeaders()"]
    BH -->|"throw (缺Token/Key)"| SKIP["跳过 → idx+1"]
    SKIP --> TRY
    BH -->|"OK"| SEND["发送 HTTPS 请求<br/><i>60s 连接超时</i>"]
    SEND --> STATUS{"HTTP 状态码?"}

    STATUS -->|"200"| SUCCESS["✅ 成功"]
    STATUS -->|"429 claude-ai"| C429{"error.type?"}
    C429 -->|"rate_limit_error<br/><i>临时限速</i>"| PASS429["透传 429 → 客户端重试<br/>不切换模型"]
    C429 -->|"credit_balance_too_low<br/><i>真正耗尽</i>"| MARK_EX["标记 claude-ai 耗尽<br/>→ idx+1"]
    MARK_EX --> TRY
    STATUS -->|"401 claude-ai"| REFRESH["尝试 refreshToken 换新"]
    REFRESH -->|"成功"| RETRY["重试同一 candidate"]
    RETRY --> SEND
    REFRESH -->|"失败"| SKIP
    STATUS -->|"429 anthropic"| A429{"error.type?"}
    A429 -->|"rate_limit_error"| PASS429
    A429 -->|"quota_exceeded"| MARK_AN["标记 anthropic 耗尽<br/>→ idx+1"]
    MARK_AN --> TRY
    STATUS -->|"4xx / 5xx"| ERR["→ idx+1"]
    ERR --> TRY
    NET["网络错误"] --> TRANS{"socket hangup / ECONNRESET?"}
    TRANS -->|"是, retries<2"| RT["等 1.5-3s 重试<br/>retries+1"]
    RT --> SEND
    TRANS -->|"否"| SKIP

    SUCCESS --> IS_FB{"idx > 0 ?"}
    IS_FB -->|"是 (fallback)"| FBOK["缓冲完整响应<br/>注入通知文案<br/>写 fallback-alert.json"]
    FBOK --> DONE2["返回给客户端"]
    IS_FB -->|"否 (第一跳)"| GUARD["首块缓冲守卫<br/>等首个 data chunk<br/>30s 无数据 → fallback"]
    GUARD -->|"收到 chunk"| PIPE["writeHead + pipe 流"]
    PIPE --> DONE2
    GUARD -->|"30s 超时"| SKIP
```

## 三、优先级总结

```
本次请求的模型优先级（从高到低）：
  1. override.json     ← auto-model skill 写入，一次性用完即删
  2. session 文件       ← /models skill 写入，持久生效
  3. request body.model ← Agent 工具的 model 参数
  4. current-model.json ← 全局默认
  5. claude-haiku-4-5   ← 硬兜底

发送时的渠道优先级（以 claude-sonnet-4-6 为例）：
  1. claude-ai (订阅 Bearer Token, 自动刷新)
  2. claude-sonnet-4-6-api (Anthropic API Key)
  3. deepseek-v4-pro (DeepSeek)
  4. 529 错误
```
