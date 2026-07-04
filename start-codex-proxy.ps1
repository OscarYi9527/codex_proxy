$ErrorActionPreference = 'Stop'

$proxyDir = $PSScriptRoot
$pidFile = Join-Path $proxyDir '.codex-proxy.pid'
$logFile = Join-Path $proxyDir 'codex-proxy.log'
$port = 47892

try {
    $health = Invoke-RestMethod "http://127.0.0.1:$port/health" -TimeoutSec 1
    if ($health.status -eq 'ok') {
        Write-Host "[codex-proxy] Already running on 127.0.0.1:$port"
        return
    }
} catch {}

if (-not $env:DEEPSEEK_API_KEY) {
    throw 'DEEPSEEK_API_KEY is not set in this shell.'
}

& (Join-Path $env:SystemRoot 'System32\cscript.exe') //nologo (Join-Path $proxyDir 'start-codex-proxy.vbs')

for ($attempt = 0; $attempt -lt 20; $attempt++) {
    Start-Sleep -Milliseconds 250
    try {
        $health = Invoke-RestMethod "http://127.0.0.1:$port/health" -TimeoutSec 1
        if ($health.status -eq 'ok') {
            $listener = Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue | Select-Object -First 1
            if ($listener) { $listener.OwningProcess | Set-Content -Path $pidFile -Encoding ascii }
            Write-Host "[codex-proxy] Ready on 127.0.0.1:$port"
            return
        }
    } catch {}
}

throw "Codex proxy failed to start. Check $logFile"
