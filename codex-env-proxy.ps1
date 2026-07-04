$ErrorActionPreference = 'Stop'

[Console]::Error.WriteLine('[codex-env-proxy] Compatibility entry: using codex-safe deepseek route.')
& (Join-Path $PSScriptRoot 'codex-safe.ps1') --route deepseek @args
exit $LASTEXITCODE
