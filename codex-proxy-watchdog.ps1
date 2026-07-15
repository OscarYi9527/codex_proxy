$ErrorActionPreference = 'Stop'

$proxyDir = $PSScriptRoot
$ensureScript = Join-Path $proxyDir 'ensure-codex-proxy.ps1'
$pidFile = Join-Path $proxyDir '.codex-proxy-watchdog.pid'
$logFile = Join-Path $proxyDir 'codex-proxy-watchdog.log'
$healthUrl = 'http://127.0.0.1:47892/live'
$mutex = $null

function Write-WatchdogLog {
    param([string]$Message)

    $line = '{0} {1}' -f (Get-Date).ToString('s'), $Message
    Add-Content -LiteralPath $logFile -Value $line -Encoding utf8
}

try {
    $createdNew = $false
    $mutex = New-Object System.Threading.Mutex($true, 'Local\CodexProxyWatchdog', [ref]$createdNew)
    if (-not $createdNew) {
        return
    }

    $PID | Set-Content -LiteralPath $pidFile -Encoding ascii
    Write-WatchdogLog "watchdog started pid=$PID"

    $failedChecks = 0
    while ($true) {
        $healthy = $false
        try {
            $health = Invoke-RestMethod -Uri $healthUrl -TimeoutSec 2
            $healthy = $health.status -eq 'ok'
        } catch {}

        if ($healthy) {
            $failedChecks = 0
        } else {
            $failedChecks++
        }

        if ($failedChecks -ge 2) {
            Write-WatchdogLog 'proxy unhealthy; starting recovery'
            try {
                & $ensureScript
                Write-WatchdogLog 'proxy recovery completed'
            } catch {
                Write-WatchdogLog "proxy recovery failed: $($_.Exception.Message)"
            }
            $failedChecks = 0
        }

        Start-Sleep -Seconds 5
    }
} finally {
    Remove-Item -LiteralPath $pidFile -Force -ErrorAction SilentlyContinue
    if ($mutex) {
        try { $mutex.ReleaseMutex() } catch {}
        $mutex.Dispose()
    }
}
