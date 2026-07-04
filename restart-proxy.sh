#!/bin/bash
# Hot-restart the proxy: kills old process, starts new one.
#
# IMPORTANT: Do NOT run this from a Claude Code window whose
# ANTHROPIC_BASE_URL points to this proxy. Killing the proxy
# mid-session will break that window's connection to Claude.
#
# Instead, run it from a plain terminal (PowerShell / cmd / bash
# outside Claude Code). Or use the --detach flag to spawn the
# restart in a background agent that survives proxy death:
#
#   bash ~/.claude/proxy/restart-proxy.sh --detach
#
# After editing server.js, you can also kill the proxy from
# Task Manager — start.sh (via the SessionStart hook) will
# restart it next time you open a Claude Code window.

PROXY_DIR="$HOME/.claude/proxy"
PORT=47891

# ── Guard: refuse to restart from inside a Claude Code session ──

if [ "${1:-}" != "--detach" ] && [ -n "${CLAUDE_CODE_SESSION_ID:-}" ]; then
  if [ -n "${ANTHROPIC_BASE_URL:-}" ] && [[ "$ANTHROPIC_BASE_URL" == *":$PORT"* ]]; then
    echo "[restart] REFUSED: this Claude Code window depends on the proxy at $ANTHROPIC_BASE_URL."
    echo "[restart] Killing the proxy would hang this session."
    echo "[restart] Options:"
    echo "  1. Run this script from a plain terminal instead"
    echo "  2. Use --detach to auto-spawn as background agent:"
    echo "       bash ~/.claude/proxy/restart-proxy.sh --detach"
    exit 1
  fi
fi

RESTART_MARKER="$PROXY_DIR/.restart-in-progress"

restart_core() {
  # 1. Kill existing process on the port
  PID=$(netstat -ano 2>/dev/null | grep ":$PORT " | grep LISTENING | awk '{print $NF}' | head -1)
  if [ -n "$PID" ]; then
    kill "$PID" 2>/dev/null
    for i in $(seq 1 30); do
      if ! kill -0 "$PID" 2>/dev/null; then break; fi
      sleep 0.1
    done
    kill -9 "$PID" 2>/dev/null
    echo "[restart] Killed old proxy (PID $PID)"
  else
    echo "[restart] No existing proxy found on port $PORT"
  fi

  # 2. Start new one
  cd "$PROXY_DIR"
  nohup node server.js > proxy.log 2>&1 &
  NEW_PID=$!
  echo "[restart] Started new proxy (PID $NEW_PID)"

  # 3. Wait for port to come up
  for i in $(seq 1 30); do
    if netstat -an 2>/dev/null | grep -q ":$PORT .*LISTENING"; then
      echo "[restart] Proxy ready on localhost:$PORT"
      rm -f "$RESTART_MARKER" "$PROXY_DIR/.restart-output.txt"
      return 0
    fi
    sleep 0.1
  done

  echo "[restart] WARNING: proxy may not have started, check proxy.log"
  rm -f "$RESTART_MARKER"
  return 1
}

# ── Detach mode: stage the restart, spawn background process, exit immediately ──

if [ "${1:-}" = "--detach" ]; then
  # Write the restart command to a temp script and run it in the background.
  # Using setsid to fully detach from the Claude Code shell tree.
  DETACH_SCRIPT="$PROXY_DIR/.detach-restart.sh"
  cat > "$DETACH_SCRIPT" <<'DETACH_EOF'
#!/bin/bash
cd "$HOME/.claude/proxy"
# Wait a beat for the caller to exit cleanly (Claude Code gets a 200 response
# before proxy is killed)
sleep 0.5
bash restart-proxy.sh --core
DETACH_EOF
  chmod +x "$DETACH_SCRIPT"
  nohup bash "$DETACH_SCRIPT" > "$PROXY_DIR/restart-detached.log" 2>&1 &
  echo "[restart] Detached restart agent spawned."
  echo "[restart] Proxy will restart in ~1 second."
  echo "[restart] During the restart (1-3s), this window will be disconnected."
  echo "[restart] After restart completes, retry your prompt in this window."
  exit 0
fi

# ── Core mode (called by detached agent or from plain terminal) ──

if [ "${1:-}" = "--core" ]; then
  restart_core
  exit $?
fi

# ── Default: direct restart from a plain terminal ──

restart_core
exit $?
