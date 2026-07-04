#!/bin/bash
# ~/.claude/proxy/model-switch.sh
# Single script for model detection + switching. Used by /models skill.
#
# Usage:
#   model-switch.sh                   → output JSON with mode, current model, alert, available models
#   model-switch.sh <model-id>        → write model selection to session/global file (persistent)
#   model-switch.sh --override <id>   → write one-shot override for next request only (auto-model)
#   model-switch.sh --clear-alert     → delete fallback-alert.json

PROXY_DIR="$HOME/.claude/proxy"
MODELS_FILE="$PROXY_DIR/models.json"

# ── Clear alert mode ──
if [ "$1" = "--clear-alert" ]; then
  rm -f "$PROXY_DIR/fallback-alert.json"
  exit 0
fi

# ── Override mode (one-shot, auto-model skill) ──
if [ "$1" = "--override" ] && [ -n "$2" ]; then
  MODEL_ID="$2"

  VALID=$(node -e "const ms=JSON.parse(require('fs').readFileSync(process.argv[1],'utf8')).models;console.log(ms.some(m=>m.id===process.argv[2])?'yes':'no')" "$MODELS_FILE" "$MODEL_ID" 2>/dev/null || echo "no")
  if [ "$VALID" != "yes" ]; then
    echo "INVALID|${MODEL_ID}"
    exit 1
  fi

  CC_SESSION="${CLAUDE_CODE_SESSION_ID:-}"
  SESSION_ID=""

  if [ -n "$CC_SESSION" ]; then
    LOOKUP="$PROXY_DIR/sessions/by-cc-session-${CC_SESSION}.txt"
    [ -f "$LOOKUP" ] && SESSION_ID=$(cat "$LOOKUP")
  fi

  if [ -n "$SESSION_ID" ]; then
    mkdir -p "$PROXY_DIR/sessions"
    printf '{"model":"%s"}' "$MODEL_ID" > "$PROXY_DIR/sessions/${SESSION_ID}.override.json"
    echo "OVERRIDE|${SESSION_ID}|${MODEL_ID}"
  else
    echo "OVERRIDE_NO_SESSION"
    exit 1
  fi
  exit 0
fi

# ── Write mode (persistent session/global) ──
if [ -n "$1" ]; then
  MODEL_ID="$1"

  # Validate model exists in models.json
  VALID=$(node -e "const ms=JSON.parse(require('fs').readFileSync(process.argv[1],'utf8')).models;console.log(ms.some(m=>m.id===process.argv[2])?'yes':'no')" "$MODELS_FILE" "$MODEL_ID" 2>/dev/null || echo "no")
  if [ "$VALID" != "yes" ]; then
    echo "INVALID|${MODEL_ID}"
    exit 1
  fi

  CC_SESSION="${CLAUDE_CODE_SESSION_ID:-}"
  SESSION_ID=""

  if [ -n "$CC_SESSION" ]; then
    LOOKUP="$PROXY_DIR/sessions/by-cc-session-${CC_SESSION}.txt"
    [ -f "$LOOKUP" ] && SESSION_ID=$(cat "$LOOKUP")
  fi

  if [ -n "$SESSION_ID" ]; then
    mkdir -p "$PROXY_DIR/sessions"
    printf '{"model":"%s"}' "$MODEL_ID" > "$PROXY_DIR/sessions/${SESSION_ID}.json"
    echo "SESSION|${SESSION_ID}"
  else
    printf '{"model":"%s"}' "$MODEL_ID" > "$PROXY_DIR/current-model.json"
    echo "GLOBAL"
  fi
  exit 0
fi

# ── Detect mode: output JSON ──

# Alert
ALERT=""
if [ -f "$PROXY_DIR/fallback-alert.json" ]; then
  ALERT=$(node -e "console.log(JSON.parse(require('fs').readFileSync(process.argv[1],'utf8')).message||'')" "$PROXY_DIR/fallback-alert.json" 2>/dev/null || echo "")
fi

# Session
CC_SESSION="${CLAUDE_CODE_SESSION_ID:-}"
SESSION_ID=""
MODE="global"

if [ -n "$CC_SESSION" ]; then
  LOOKUP="$PROXY_DIR/sessions/by-cc-session-${CC_SESSION}.txt"
  if [ -f "$LOOKUP" ]; then
    SESSION_ID=$(cat "$LOOKUP")
    MODE="session"
  fi
fi

# Current model
CURRENT=""
if [ "$MODE" = "session" ] && [ -n "$SESSION_ID" ]; then
  SESSION_FILE="$PROXY_DIR/sessions/${SESSION_ID}.json"
  CURRENT=$(node -e "try{console.log(JSON.parse(require('fs').readFileSync(process.argv[1],'utf8')).model||'')}catch(e){}" "$SESSION_FILE" 2>/dev/null || echo "")
fi
if [ -z "$CURRENT" ]; then
  CURRENT=$(node -e "try{console.log(JSON.parse(require('fs').readFileSync(process.argv[1],'utf8')).model||'')}catch(e){}" "$PROXY_DIR/current-model.json" 2>/dev/null || echo "claude-haiku-4-5")
fi

# Models list (only named/visible) — cat file then parse in node to avoid path issues
MODELS_CONTENT=$(cat "$MODELS_FILE" 2>/dev/null || echo '{"models":[]}')
MODELS_JSON=$(node -e "process.stdin.resume();let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{const ms=JSON.parse(d).models.filter(m=>m.name);console.log(JSON.stringify(ms.map(m=>({id:m.id,name:m.name,desc:m.description||''}))))})" <<< "$MODELS_CONTENT")

# Final JSON output
node -e "
console.log(JSON.stringify({
  mode:'$MODE',
  sessionId:'${SESSION_ID//\'/\'\\\'\'}',
  current:'${CURRENT//\'/\'\\\'\'}',
  alert:'${ALERT//\'/\'\\\'\'}',
  models:$MODELS_JSON
}))
"
