$ErrorActionPreference = 'Stop'

$startupDir = [Environment]::GetFolderPath('Startup')
if (-not $startupDir) {
    throw 'Could not resolve the Windows Startup folder.'
}

$launcherPath = Join-Path $startupDir 'codex-proxy-autostart.vbs'
if (Test-Path $launcherPath) {
    Remove-Item $launcherPath -Force
    Write-Host "[codex-proxy] Removed startup launcher: $launcherPath"
} else {
    Write-Host "[codex-proxy] Startup launcher not found: $launcherPath"
}
