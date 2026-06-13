# Launch Claude Code with a unique session ID for per-window model isolation.
# Each window gets its own ANTHROPIC_BASE_URL so /models changes don't affect other windows.

$sessionId = "s" + [System.Guid]::NewGuid().ToString("N").Substring(0, 8)
$env:ANTHROPIC_BASE_URL = "http://127.0.0.1:47891/s/$sessionId"

Write-Host "[claude] Session: $sessionId" -ForegroundColor Cyan

claude @args
