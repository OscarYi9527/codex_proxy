param(
    [string]$InstallDir = (Join-Path $HOME '.codex-local-multi-proxy'),
    [string]$CodexHome = (Join-Path $HOME '.codex'),
    [string]$DefaultModel = 'gpt-5.6-sol',
    [int]$Port = 47892,
    [switch]$InstallAutostart,
    [switch]$NoAutostart,
    [switch]$StartProxy,
    [switch]$InstallVSCodeCompat,
    [switch]$PatchVSCodeWebview,
    [switch]$DryRun,
    [switch]$Force,
    [string]$DeepSeekApiKey,
    [string]$OpenAIApiKey
)

$ErrorActionPreference = 'Stop'

$ProviderId = 'local_multi_proxy'
$ProviderName = 'Local Multi-Upstream Proxy'
$SourceDir = $PSScriptRoot

$RuntimeListFile = Join-Path $SourceDir 'runtime-files.json'
if (-not (Test-Path -LiteralPath $RuntimeListFile)) {
    throw "Missing runtime file list: $RuntimeListFile"
}
$RuntimeList = Get-Content -LiteralPath $RuntimeListFile -Raw -Encoding UTF8 | ConvertFrom-Json
$FilesToInstall = @($RuntimeList.files | ForEach-Object { ([string]$_).Replace('/', '\') }) + @(
    'tests\test-codex-proxy.js',
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

function Write-ReleaseManifest {
    if ($DryRun) {
        Write-Step 'would write .release-manifest.json'
        return
    }
    $package = Get-Content -LiteralPath (Join-Path $SourceDir 'package.json') -Raw -Encoding UTF8 | ConvertFrom-Json
    $commit = $null
    try {
        $output = & git -C $SourceDir rev-parse HEAD 2>$null
        $exitCode = $LASTEXITCODE
        $commit = ([string]($output | Select-Object -First 1)).Trim()
        if ($exitCode -ne 0) { $commit = $null }
    } catch {}
    $hashes = [ordered]@{}
    foreach ($relativePath in $RuntimeList.files) {
        $normalized = ([string]$relativePath).Replace('\', '/')
        $hashes[$normalized] = (Get-FileHashText (Join-Path $SourceDir $relativePath)).ToLowerInvariant()
    }
    $manifest = [ordered]@{
        schema_version = 1
        version = $package.version
        commit = $commit
        source_root = [IO.Path]::GetFullPath($SourceDir)
        install_root = [IO.Path]::GetFullPath($InstallDir)
        deployed_at = (Get-Date).ToUniversalTime().ToString('o')
        files = $hashes
    }
    $target = Join-Path $InstallDir '.release-manifest.json'
    $temp = Join-Path $InstallDir ('.release-manifest.{0}.tmp' -f $PID)
    [IO.File]::WriteAllText($temp, ($manifest | ConvertTo-Json -Depth 8), [Text.UTF8Encoding]::new($false))
    Move-Item -LiteralPath $temp -Destination $target -Force
    Write-Step "wrote release manifest: version=$($package.version) commit=$commit"
}

function Seed-ConfigIfMissing {
    $src = Join-Path $SourceDir 'codex-proxy-config.json'
    $dst = Join-Path $InstallDir 'codex-proxy-config.json'

    if (-not (Test-Path -LiteralPath $src)) {
        Write-Step "skip missing seed source: codex-proxy-config.json"
        return
    }

    if (Test-Path -LiteralPath $dst) {
        Write-Step "codex-proxy-config.json already exists at install dir, skip seeding (preserving admin-panel edits)"
        return
    }

    if ($DryRun) {
        Write-Step "would seed: codex-proxy-config.json -> $dst"
        return
    }

    Ensure-Directory $InstallDir
    Copy-Item -LiteralPath $src -Destination $dst -Force
    Write-Step "seeded: codex-proxy-config.json"
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

if ($OpenAIApiKey) {
    if ($DryRun) {
        Write-Step "would set user OPENAI_API_KEY"
    } else {
        [Environment]::SetEnvironmentVariable('OPENAI_API_KEY', $OpenAIApiKey, 'User')
        $env:OPENAI_API_KEY = $OpenAIApiKey
        Write-Step "set user OPENAI_API_KEY"
    }
}

Ensure-Directory $InstallDir
$backupRoot = Join-Path $InstallDir ('.install-backup\{0}' -f (Get-Date -Format 'yyyyMMdd-HHmmss'))
foreach ($file in $FilesToInstall) {
    Backup-And-Copy $file $backupRoot
}
Write-ReleaseManifest

Seed-ConfigIfMissing

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
