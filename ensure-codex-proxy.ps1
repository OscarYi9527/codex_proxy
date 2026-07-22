$ErrorActionPreference = 'Stop'

# Single runtime recovery entry point shared by codex-safe.ps1,
# codex-proxy-watchdog.ps1, and the VS Code launcher. Deployment is deliberately
# excluded: a health-check failure must never publish an arbitrary source
# branch or restart a healthy installed version. Use update-codex-proxy.ps1
# explicitly when deployment is intended.

$proxyDir = $PSScriptRoot
$healthUrl = 'http://127.0.0.1:47892/live'
$installDir = Join-Path $HOME '.codex-local-multi-proxy'

# A system-wide HTTP(S)_PROXY (e.g. Clash/V2Ray) routes even loopback
# requests through the external proxy unless NO_PROXY excludes them. That
# proxy can't dial back into 127.0.0.1, so health checks and the proxy
# itself intermittently see 502s. Detect + fix that before anything else
# runs. Scoped to this process tree only, so the user's proxy still
# applies everywhere else.
$activeProxyVar = 'HTTP_PROXY', 'http_proxy', 'HTTPS_PROXY', 'https_proxy' |
    Where-Object { [Environment]::GetEnvironmentVariable($_, 'Process') } |
    Select-Object -First 1
if ($activeProxyVar) {
    $proxyValue = [Environment]::GetEnvironmentVariable($activeProxyVar, 'Process')
    Write-Host "[ensure-codex-proxy] system proxy detected ($activeProxyVar=$proxyValue); checking NO_PROXY for localhost bypass..."
    foreach ($varName in 'NO_PROXY', 'no_proxy') {
        $existing = [Environment]::GetEnvironmentVariable($varName, 'Process')
        $entries = @($existing -split ',' | Where-Object { $_ -and $_.Trim() })
        $missing = @('localhost', '127.0.0.1', '::1') | Where-Object { $entries -notcontains $_ }
        if ($missing) {
            $entries += $missing
            Set-Item -Path "Env:$varName" -Value ($entries -join ',')
        }
    }
    Write-Host "[ensure-codex-proxy] NO_PROXY for this run: $($env:NO_PROXY)"
} else {
    Write-Host '[ensure-codex-proxy] no system HTTP(S)_PROXY detected; skipping localhost bypass check.'
}

function Test-ProxyHealthy {
    try {
        $health = Invoke-RestMethod $healthUrl -TimeoutSec 2
        return $health.status -eq 'ok'
    } catch {
        return $false
    }
}

if (-not (Test-ProxyHealthy) -and $env:CODEX_SAFE_NO_START -ne '1') {
    $startScript = if (Test-Path -LiteralPath (Join-Path $installDir 'start-codex-proxy.ps1')) {
        Join-Path $installDir 'start-codex-proxy.ps1'
    } else {
        Join-Path $proxyDir 'start-codex-proxy.ps1'
    }
    if (-not (Test-Path -LiteralPath $startScript)) {
        throw "[ensure-codex-proxy] start script not found: $startScript"
    }
    Write-Host "[ensure-codex-proxy] proxy not healthy; starting installed runtime via $startScript"
    & $startScript
    if (-not (Test-ProxyHealthy)) {
        throw '[ensure-codex-proxy] proxy start returned without a healthy /live endpoint'
    }
}

$watchdogRunning = $true
try {
    $existingMutex = [System.Threading.Mutex]::OpenExisting('Local\CodexProxyWatchdog')
    $existingMutex.Dispose()
} catch {
    $watchdogRunning = $false
}

if (-not $watchdogRunning) {
    $watchdogScript = if (Test-Path -LiteralPath (Join-Path $installDir 'codex-proxy-watchdog.ps1')) {
        Join-Path $installDir 'codex-proxy-watchdog.ps1'
    } else {
        Join-Path $proxyDir 'codex-proxy-watchdog.ps1'
    }
    if (Test-Path -LiteralPath $watchdogScript) {
        Write-Host '[ensure-codex-proxy] watchdog not running; launching'
        try {
            Start-Process -FilePath 'powershell.exe' `
                -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $watchdogScript) `
                -WindowStyle Hidden
        } catch {
            Write-Warning "[ensure-codex-proxy] failed to launch watchdog: $($_.Exception.Message)"
        }
    }
}
