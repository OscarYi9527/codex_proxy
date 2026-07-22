$ErrorActionPreference = 'Stop'

$proxyDir = $PSScriptRoot
$ensureScript = Join-Path $proxyDir 'ensure-codex-proxy.ps1'
$pidFile = Join-Path $proxyDir '.codex-proxy-watchdog.pid'
$logFile = Join-Path $proxyDir 'codex-proxy-watchdog.log'
$healthUrl = 'http://127.0.0.1:47892/live'
$port = 47892
$failureThreshold = 5
$recoveryCooldownSeconds = 60
$maxListenerStallRounds = 3
$mutex = $null

function Write-WatchdogLog {
    param([string]$Message)

    if ((Test-Path -LiteralPath $logFile) -and
        (Get-Item -LiteralPath $logFile).Length -ge 1MB) {
        $rotatedLog = "$logFile.1"
        Remove-Item -LiteralPath $rotatedLog -Force -ErrorAction SilentlyContinue
        Move-Item -LiteralPath $logFile -Destination $rotatedLog -Force
    }
    $line = '{0} {1}' -f (Get-Date).ToString('s'), $Message
    Add-Content -LiteralPath $logFile -Value $line -Encoding utf8
}

function Get-ProxyListenerState {
    $listener = Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue |
        Select-Object -First 1
    if (-not $listener) {
        return [pscustomobject]@{ State = 'absent'; Pid = 0; CommandLine = '' }
    }
    $process = Get-CimInstance Win32_Process -Filter "ProcessId=$($listener.OwningProcess)" -ErrorAction SilentlyContinue
    $commandLine = [string]$process.CommandLine
    $expectedServer = Join-Path $proxyDir 'src\server.js'
    $state = if ($commandLine -and $commandLine.IndexOf($expectedServer, [StringComparison]::OrdinalIgnoreCase) -ge 0) {
        'expected'
    } else {
        'foreign'
    }
    return [pscustomobject]@{
        State = $state
        Pid = [int]$listener.OwningProcess
        CommandLine = $commandLine
    }
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
    $listenerStallRounds = 0
    while ($true) {
        $healthy = $false
        try {
            $health = Invoke-RestMethod -Uri $healthUrl -TimeoutSec 2
            $healthy = $health.status -eq 'ok'
        } catch {}

        if ($healthy) {
            $failedChecks = 0
            $listenerStallRounds = 0
        } else {
            $failedChecks++
        }

        if ($failedChecks -ge $failureThreshold) {
            $listenerState = Get-ProxyListenerState
            if ($listenerState.State -eq 'foreign') {
                Write-WatchdogLog "proxy unhealthy but port $port belongs to foreign pid=$($listenerState.Pid); recovery skipped"
                $failedChecks = 0
                Start-Sleep -Seconds $recoveryCooldownSeconds
                continue
            }
            if ($listenerState.State -eq 'expected') {
                $listenerStallRounds++
                if ($listenerStallRounds -lt $maxListenerStallRounds) {
                    Write-WatchdogLog "proxy /live timed out but expected pid=$($listenerState.Pid) still listens; deferring restart stall_round=$listenerStallRounds/$maxListenerStallRounds"
                    $failedChecks = 0
                    Start-Sleep -Seconds $recoveryCooldownSeconds
                    continue
                }
                Write-WatchdogLog "proxy listener remained stalled; stopping expected pid=$($listenerState.Pid)"
                Stop-Process -Id $listenerState.Pid -Force -ErrorAction Stop
                Start-Sleep -Seconds 2
            }

            Write-WatchdogLog 'proxy unhealthy; starting installed-runtime recovery'
            try {
                & $ensureScript
                $health = Invoke-RestMethod -Uri $healthUrl -TimeoutSec 3
                $recovered = Get-ProxyListenerState
                if ($health.status -ne 'ok' -or $recovered.State -ne 'expected') {
                    throw "recovery verification failed: health=$($health.status) listener=$($recovered.State) pid=$($recovered.Pid)"
                }
                Write-WatchdogLog "proxy recovery verified pid=$($recovered.Pid)"
            } catch {
                Write-WatchdogLog "proxy recovery failed: $($_.Exception.Message)"
            }
            $failedChecks = 0
            $listenerStallRounds = 0
            Start-Sleep -Seconds $recoveryCooldownSeconds
            continue
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
