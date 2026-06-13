---
name: models
description: Display and switch between available LLM models without restarting Claude Code, scoped to the current window
user-invocable: true
allowed-tools: [Bash, AskUserQuestion]
---

# models

Switch the active LLM model for this window only. Each window is isolated via a session ID looked up from `CLAUDE_CODE_SESSION_ID`.

## Available models (source of truth: ~/.claude/proxy/models.json)

| id | name | description |
|---|---|---|
| `claude-opus-4-8` | Claude Opus 4.8 | 最强推理，复杂任务首选 |
| `claude-sonnet-4-6` | Claude Sonnet 4.6 | 性能与速度的平衡 |
| `claude-haiku-4-5` | Claude Haiku 4.5 | 快速轻量，适合简单任务 |
| `deepseek-v4-pro` | DeepSeek V4 Pro | 高性价比，1M context |

If models.json adds or removes entries, update this table.

## Workflow

### Step 1 — Detect session, read current model, show picker

Run this Bash command to get the session ID and current model in one shot:

```bash
# CLAUDE_CODE_SESSION_ID is unique per window and always present in bash env.
# session-init.js writes by-cc-session-{id}.txt → proxy session ID at SessionStart.
SESSION_ID=""
CC_SESSION="${CLAUDE_CODE_SESSION_ID:-}"
if [ -n "$CC_SESSION" ]; then
  LOOKUP="$HOME/.claude/proxy/sessions/by-cc-session-${CC_SESSION}.txt"
  [ -f "$LOOKUP" ] && SESSION_ID=$(cat "$LOOKUP")
fi

if [ -n "$SESSION_ID" ]; then
  SESSION_FILE="$HOME/.claude/proxy/sessions/${SESSION_ID}.json"
  CURRENT=$([ -f "$SESSION_FILE" ] && cat "$SESSION_FILE" || echo '{"model":null}')
else
  CURRENT=$(cat "$HOME/.claude/proxy/current-model.json" 2>/dev/null || echo '{"model":null}')
fi
echo "SESSION_ID=$SESSION_ID"
echo "CURRENT=$CURRENT"
```

Parse:
- `SESSION_ID=` line → session identifier (empty string = global mode)
- `CURRENT=` line → JSON with `model` field = currently active model id

**In the same response**, call **AskUserQuestion**:
- `header`: "模型选择"
- `question`: "选择要切换的模型："
- `multiSelect`: false
- One option per model. Label: `{name} — {description}`. Append ` (当前)` to the active one. The AskUserQuestion `description` field for each option must be left as an empty string `""`.

### Step 2 — Write if different

If selected model equals current model, reply "已在使用 {name}。" and stop.

Otherwise write via Bash — branch on whether SESSION_ID is set:

**Session mode** (SESSION_ID non-empty):
```bash
mkdir -p ~/.claude/proxy/sessions
printf '{"model":"<id>"}' > ~/.claude/proxy/sessions/<SESSION_ID>.json
```
Reply: "已切换到 {name}（会话 `<SESSION_ID>`），代理下次请求时生效。"

**Global mode** (SESSION_ID empty — SessionStart hook didn't run yet):
```bash
printf '{"model":"<id>"}' > ~/.claude/proxy/current-model.json
```
Reply: "已切换到 {name}（全局模式），代理下次请求时生效。"

## Gotchas

- Use **Bash** (not PowerShell, not Read) for step 1 — `$CLAUDE_CODE_SESSION_ID` is in the bash env.
- Write via `printf`, not `echo >` — `echo` can produce a UTF-16 BOM on Windows that breaks the proxy JSON parser.
- `$PPID` is always `1` in the bash sandbox and cannot identify windows. `ANTHROPIC_BASE_URL` has no session path in the bash env. Both old methods are broken — `CLAUDE_CODE_SESSION_ID` is the only reliable identifier.
- Session ID lookup: `CLAUDE_CODE_SESSION_ID` → `by-cc-session-{id}.txt` → proxy session ID → `{sessionId}.json`.
- Without a session (hook didn't run yet, or lookup file missing), falls back to global `current-model.json` — shared across all windows.
- The proxy resolves model priority: session file > body.model > current-model.json fallback.
