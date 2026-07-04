$ErrorActionPreference = 'Stop'

$proxyDir = $PSScriptRoot
$startupDir = [Environment]::GetFolderPath('Startup')
if (-not $startupDir) {
    throw 'Could not resolve the Windows Startup folder.'
}

$launcherPath = Join-Path $startupDir 'codex-proxy-autostart.vbs'
$launcher = @"
Set shell = CreateObject("WScript.Shell")

proxyDir = "$proxyDir"
scriptFile = proxyDir & "\codex-proxy-watchdog.ps1"
powershellPath = shell.ExpandEnvironmentStrings("%SystemRoot%") & "\System32\WindowsPowerShell\v1.0\powershell.exe"

shell.Run """" & powershellPath & """ -NoProfile -ExecutionPolicy Bypass -File """ & scriptFile & """", 0, False
"@

[System.IO.File]::WriteAllText($launcherPath, $launcher, (New-Object System.Text.UTF8Encoding($false)))

Write-Host "[codex-proxy] Startup launcher installed: $launcherPath"
Write-Host "[codex-proxy] It will start automatically at Windows logon."
