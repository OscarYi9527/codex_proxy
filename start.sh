#!/bin/bash

PROXY_DIR="$HOME/.claude/proxy"
PID_FILE="$PROXY_DIR/.proxy.pid"
LOG_FILE="$PROXY_DIR/proxy.log"
PORT=47891
RESTART_MODE="${1:-}"

# Check if port is already in use (works cross-platform)
# Skip guard in restart mode so we can hot-reload
if [ "$RESTART_MODE" != "--restart" ] && netstat -an 2>/dev/null | grep -q ":$PORT .*LISTENING"; then
  echo "[proxy] Already running on localhost:$PORT"
  exit 0
fi

# Clean up stale PID file
rm -f "$PID_FILE"

# Start the server
cd "$PROXY_DIR"
nohup node server.js > "$LOG_FILE" 2>&1 &
PID=$!
echo $PID > "$PID_FILE"
echo "[proxy] Started (PID: $PID)"
sleep 1

# Check if port is now listening
if netstat -an 2>/dev/null | grep -q ":$PORT .*LISTENING"; then
  echo "[proxy] Server is running on localhost:$PORT"
else
  echo "[proxy] Failed to start, check $LOG_FILE"
  rm -f "$PID_FILE"
fi
