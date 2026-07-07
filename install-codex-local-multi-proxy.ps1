param(
    [string]$InstallDir = (Join-Path $HOME '.codex-local-multi-proxy'),
    [string]$CodexHome = (Join-Path $HOME '.codex'),
    [string]$DefaultModel = 'gpt-5.5',
    [int]$Port = 47892,
    [switch]$InstallAutostart,
    [switch]$NoAutostart,
    [switch]$StartProxy,
    [switch]$InstallVSCodeCompat,
    [switch]$PatchVSCodeWebview,
    [switch]$DryRun,
    [switch]$Force,
    [string]$DeepSeekApiKey
)

$ErrorActionPreference = 'Stop'

$ProviderId = 'local_multi_proxy'
$ProviderName = 'Local Multi-Upstream Proxy'
$SourceDir = $PSScriptRoot

$FilesToInstall = @(
    'package.json',
    'codex-proxy.js',
    'codex-models.json',
    'codex-safe.ps1',
    'codex-mode.ps1',
    'codex-env-proxy.ps1',
    'set-codex-route.ps1',
    'start-codex-proxy.ps1',
    'stop-codex-proxy.ps1',
    'codex-proxy-watchdog.ps1',
    'start-codex-proxy.vbs',
    'install-codex-proxy-autostart.ps1',
    'uninstall-codex-proxy-autostart.ps1',
    'install-vscode-codex-compat.ps1',
    'repair-codex-model-cache.ps1',
    'test-codex-proxy.js',
    'test-codex-routing.ps1',
    'test-codex-lite-matrix.ps1'
)

function Write-Step([string]$Message) {
    Write-Host "[install] $Message"
}

function Ensure-Directory([string]$Path) {
    if ($DryRun) {
        Write-Step "would create directory: $Path"
        return
    }
    if (-not (Test-Path -LiteralPath $Path)) {
        New-Item -ItemType Directory -Path $Path -Force | Out-Null
    }
}

function Get-FileHashText([string]$Path) {
    if (-not (Test-Path -LiteralPath $Path)) { return $null }
    return (Get-FileHash -Algorithm SHA256 -LiteralPath $Path).Hash
}

function Backup-And-Copy([string]$RelativePath, [string]$BackupRoot) {
    $src = Join-Path $SourceDir $RelativePath
    $dst = Join-Path $InstallDir $RelativePath
    if (-not (Test-Path -LiteralPath $src)) {
        Write-Step "skip missing source file: $RelativePath"
        return
    }

    $srcHash = Get-FileHashText $src
    $dstHash = Get-FileHashText $dst
    if ($srcHash -and $dstHash -and $srcHash -eq $dstHash) {
        Write-Step "unchanged: $RelativePath"
        return
    }

    if ($DryRun) {
        Write-Step "would copy: $src -> $dst"
        return
    }

    Ensure-Directory (Split-Path -Parent $dst)
    if ((Test-Path -LiteralPath $dst) -and -not $Force) {
        $backupPath = Join-Path $BackupRoot $RelativePath
        Ensure-Directory (Split-Path -Parent $backupPath)
        Copy-Item -LiteralPath $dst -Destination $backupPath -Force
        Write-Step "backed up existing file: $RelativePath"
    }
    Copy-Item -LiteralPath $src -Destination $dst -Force
    Write-Step "installed: $RelativePath"
}

function Remove-ConfigBlock([string]$Text, [string]$BlockName) {
    $pattern = "(?ms)\r?\n\[$([regex]::Escape($BlockName))\].*?(?=\r?\n\[|\z)"
    return [regex]::Replace($Text, $pattern, "`r`n")
}

function Ensure-TopLevelValue([string]$Text, [string]$Key, [string]$TomlValue) {
    $pattern = '(?m)^' + [regex]::Escape($Key) + '\s*=.*(?:\r?\n)?'
    $line = "$Key = $TomlValue`r`n"
    if ([regex]::IsMatch($Text, $pattern)) {
        return [regex]::Replace($Text, $pattern, $line, 1)
    }
    return $line + $Text
}

function TomlString([string]$Value) {
    return '"' + ($Value.Replace('\', '\\').Replace('"', '\"')) + '"'
}

function Ensure-ProjectTrust([string]$Text, [string]$ProjectPath) {
    $normalized = $ProjectPath.ToLowerInvariant()
    $escaped = [regex]::Escape("[projects.'$normalized']")
    if ($Text -match "(?m)^$escaped\s*$") { return $Text }
    return $Text.TrimEnd() + "`r`n`r`n[projects.'$normalized']`r`ntrust_level = `"trusted`"`r`n"
}

function Update-CodexConfig {
    $configFile = Join-Path $CodexHome 'config.toml'
    $catalogPath = Join-Path $InstallDir 'codex-models.json'
    $baseUrl = "http://localhost:$Port/v1"

    $text = if (Test-Path -LiteralPath $configFile) {
        [IO.File]::ReadAllText($configFile)
    } else {
        @"
[windows]
sandbox = "elevated"
"@
    }

    $text = Remove-ConfigBlock $text "model_providers.$ProviderId"
    $text = Ensure-TopLevelValue $text 'model' (TomlString $DefaultModel)
    $text = Ensure-TopLevelValue $text 'model_provider' (TomlString $ProviderId)
    $text = Ensure-TopLevelValue $text 'model_catalog_json' (TomlString $catalogPath)
    $text = Ensure-ProjectTrust $text $HOME

    $providerBlock = @"

[model_providers.$ProviderId]
name = "$ProviderName"
base_url = "$baseUrl"
wire_api = "responses"
requires_openai_auth = true
"@
    $text = $text.TrimEnd() + $providerBlock + "`r`n"

    if ($DryRun) {
        Write-Step "would update Codex config: $configFile"
        return
    }

    Ensure-Directory $CodexHome
    if ((Test-Path -LiteralPath $configFile) -and -not $Force) {
        $backupFile = Join-Path $CodexHome ("config.toml.local-multi-proxy.{0}.bak" -f (Get-Date -Format 'yyyyMMdd-HHmmss'))
        Copy-Item -LiteralPath $configFile -Destination $backupFile -Force
        Write-Step "backed up Codex config: $backupFile"
    }
    [IO.File]::WriteAllText($configFile, $text, [Text.UTF8Encoding]::new($false))
    Write-Step "updated Codex config: $configFile"
}

function Check-Command([string]$Name, [string]$InstallHint) {
    $cmd = Get-Command $Name -ErrorAction SilentlyContinue
    if ($cmd) {
        Write-Step "found ${Name}: $($cmd.Source)"
        return $true
    }
    Write-Warning "${Name} was not found. $InstallHint"
    return $false
}

Write-Step "source: $SourceDir"
Write-Step "install dir: $InstallDir"
Write-Step "codex home: $CodexHome"

if ($DeepSeekApiKey) {
    if ($DryRun) {
        Write-Step "would set user DEEPSEEK_API_KEY"
    } else {
        [Environment]::SetEnvironmentVariable('DEEPSEEK_API_KEY', $DeepSeekApiKey, 'User')
        $env:DEEPSEEK_API_KEY = $DeepSeekApiKey
        Write-Step "set user DEEPSEEK_API_KEY"
    }
}

Ensure-Directory $InstallDir
$backupRoot = Join-Path $InstallDir ('.install-backup\{0}' -f (Get-Date -Format 'yyyyMMdd-HHmmss'))
foreach ($file in $FilesToInstall) {
    Backup-And-Copy $file $backupRoot
}

Update-CodexConfig

[void](Check-Command 'node' 'Install Node.js 20+ and rerun this installer.')
[void](Check-Command 'codex.cmd' 'Install Codex CLI, or make sure codex is on PATH.')

if ($InstallAutostart) {
    Write-Warning '-InstallAutostart is now the default; the switch is kept for compatibility.'
}

$shouldInstallAutostart = -not $NoAutostart

if ($shouldInstallAutostart) {
    $autostartScript = Join-Path $InstallDir 'install-codex-proxy-autostart.ps1'
    if ($DryRun) {
        Write-Step "would install autostart via: $autostartScript"
    } else {
        & (Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe') -NoProfile -ExecutionPolicy Bypass -File $autostartScript
    }
}

if ($StartProxy) {
    $startScript = Join-Path $InstallDir 'start-codex-proxy.ps1'
    if ($DryRun) {
        Write-Step "would start proxy via: $startScript"
    } else {
        & (Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe') -NoProfile -ExecutionPolicy Bypass -File $startScript
    }
}

if ($InstallVSCodeCompat) {
    $vscodeScript = Join-Path $InstallDir 'install-vscode-codex-compat.ps1'
    $vscodeArgs = @('-File', $vscodeScript, '-InstallDir', $InstallDir, '-UpdateSettings')
    if ($PatchVSCodeWebview) {
        $vscodeArgs += '-PatchWebview'
    }

    if ($DryRun) {
        Write-Step "would install VS Code Codex compatibility via: $vscodeScript"
        if ($PatchVSCodeWebview) {
            Write-Step "would patch VS Code Codex webview model list"
        }
    } else {
        & (Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe') -NoProfile -ExecutionPolicy Bypass @vscodeArgs
    }
} elseif ($PatchVSCodeWebview) {
    Write-Warning '-PatchVSCodeWebview was provided without -InstallVSCodeCompat; skipping VS Code patch.'
}

Write-Step "done"
Write-Host ""
Write-Host "Next commands:"
Write-Host "  powershell -ExecutionPolicy Bypass -File `"$InstallDir\start-codex-proxy.ps1`""
Write-Host "  powershell -ExecutionPolicy Bypass -File `"$InstallDir\codex-mode.ps1`" deepseek"
if (-not $InstallVSCodeCompat) {
    Write-Host "  powershell -ExecutionPolicy Bypass -File `"$InstallDir\install-vscode-codex-compat.ps1`" -UpdateSettings -PatchWebview"
}
Write-Host ""
Write-Host "Autostart:"
if ($shouldInstallAutostart) {
    Write-Host "  installed by default"
} else {
    Write-Host "  skipped because -NoAutostart was provided"
    Write-Host "  powershell -ExecutionPolicy Bypass -File `"$InstallDir\install-codex-proxy-autostart.ps1`""
}
