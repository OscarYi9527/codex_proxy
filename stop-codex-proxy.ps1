$ErrorActionPreference = 'Stop'

$pidFile = Join-Path $PSScriptRoot '.codex-proxy.pid'
$listener = Get-NetTCPConnection -State Listen -LocalPort 47892 -ErrorAction SilentlyContinue | Select-Object -First 1
if ($listener) {
    $proxyPid = $listener.OwningProcess
    Stop-Process -Id $proxyPid -ErrorAction SilentlyContinue
    Write-Host "[codex-proxy] Graceful stop requested for PID $proxyPid"
    try {
        Wait-Process -Id $proxyPid -Timeout 315 -ErrorAction Stop
    } catch {
        Stop-Process -Id $proxyPid -Force -ErrorAction SilentlyContinue
        Write-Host "[codex-proxy] Forced stop after drain timeout"
    }
}
Remove-Item $pidFile -Force -ErrorAction SilentlyContinue
