$ErrorActionPreference = 'Stop'

$pidFile = Join-Path $PSScriptRoot '.codex-proxy.pid'
$listener = Get-NetTCPConnection -State Listen -LocalPort 47892 -ErrorAction SilentlyContinue | Select-Object -First 1
if ($listener) {
    $proxyPid = $listener.OwningProcess
    Stop-Process -Id $proxyPid -Force -ErrorAction SilentlyContinue
    Write-Host "[codex-proxy] Stopped PID $proxyPid"
}
Remove-Item $pidFile -Force -ErrorAction SilentlyContinue
