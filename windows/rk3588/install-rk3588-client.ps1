param(
    [Parameter(Mandatory = $true)][string]$BaseUrl,
    [Parameter(Mandatory = $true)][string]$Model,
    [string]$InstallDir,
    [string]$StateDir,
    [string]$CodexHome = (Join-Path $HOME '.codex'),
    [string]$CodexCommand,
    [Security.SecureString]$ClientApiKey,
    [switch]$ClientApiKeyStdin,
    [switch]$DoNotSetDefault,
    [switch]$SkipCodexCheck,
    [switch]$SkipTailscaleCheck,
    [switch]$SkipEndpointCheck,
    [switch]$Force
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0
. (Join-Path $PSScriptRoot 'rk3588-client-common.ps1')

function Write-InstallStep([string]$Message) {
    Write-Host "[rk3588-install] $Message"
}

function Copy-ClientFile {
    param(
        [Parameter(Mandatory = $true)][string]$Name,
        [Parameter(Mandatory = $true)][string]$TargetDir
    )

    $source = Join-Path $PSScriptRoot $Name
    $target = Join-Path $TargetDir $Name
    if (-not (Test-Path -LiteralPath $source -PathType Leaf)) {
        throw "Installer source file is missing: $source"
    }
    if ((ConvertTo-RkFullPath $source) -ne (ConvertTo-RkFullPath $target)) {
        Copy-Item -LiteralPath $source -Destination $target -Force
    }
    Protect-RkPathAcl -Path $target -Kind File
}

Assert-RkWindows
$BaseUrl = Get-RkValidatedBaseUrl $BaseUrl
$Model = $Model.Trim()
if (
    [string]::IsNullOrWhiteSpace($Model) -or
    $Model.Length -gt 200 -or
    $Model.IndexOfAny([char[]]"`r`n`0") -ge 0
) {
    throw 'Model must be a non-empty model ID of at most 200 characters.'
}
if ([string]::IsNullOrWhiteSpace($StateDir)) {
    $StateDir = Get-RkDefaultRoot
}
$StateDir = ConvertTo-RkFullPath $StateDir
if ([string]::IsNullOrWhiteSpace($InstallDir)) {
    $InstallDir = Join-Path $StateDir 'client'
}
$InstallDir = ConvertTo-RkFullPath $InstallDir
$CodexHome = ConvertTo-RkFullPath $CodexHome

$settingsFile = Join-Path $StateDir $script:RkSettingsFileName
$existingSettings = $null
if (Test-Path -LiteralPath $settingsFile -PathType Leaf) {
    try {
        $existingSettings = Get-RkSettings -StateDir $StateDir
    } catch {
        if (-not $Force) {
            throw 'Existing RK3588 client settings are invalid. Use -Force only after reviewing the state directory.'
        }
    }
}
if ($existingSettings -and [bool]$existingSettings.original_config_existed) {
    $originalBackupCandidate = [string]$existingSettings.original_config_backup
    if (
        [string]::IsNullOrWhiteSpace($originalBackupCandidate) -or
        -not (Test-Path -LiteralPath $originalBackupCandidate -PathType Leaf) -or
        (Get-RkSha256 $originalBackupCandidate) -ne
            [string]$existingSettings.original_config_sha256
    ) {
        throw 'The original Codex config backup is missing or changed; refusing to replace rollback metadata.'
    }
}

if ($ClientApiKey -and $ClientApiKeyStdin) {
    throw 'Use either -ClientApiKey or -ClientApiKeyStdin, not both.'
}
if ($ClientApiKeyStdin) {
    $stdinValue = [Console]::In.ReadToEnd().TrimEnd("`r", "`n")
    try {
        $ClientApiKey = ConvertTo-RkSecureString $stdinValue
    } finally {
        $stdinValue = $null
    }
}
if (-not $ClientApiKey) {
    $ClientApiKey = Read-Host 'RK3588 client key' -AsSecureString
}

$privateStateDir = Ensure-RkPrivateDirectory $StateDir
$privateInstallDir = Ensure-RkPrivateDirectory $InstallDir
$backupDir = Ensure-RkPrivateDirectory (Join-Path $privateStateDir 'config-backups')
$clientFiles = @(
    'rk3588-client-common.ps1',
    'Rk3588CredentialHelper.cs',
    'set-rk3588-client-key.ps1',
    'test-rk3588-client.ps1',
    'install-rk3588-client.ps1',
    'uninstall-rk3588-client.ps1'
)
foreach ($file in $clientFiles) {
    Copy-ClientFile -Name $file -TargetDir $privateInstallDir
}
$credentialHelper = Build-RkCredentialHelper `
    -SourcePath (Join-Path $privateInstallDir 'Rk3588CredentialHelper.cs') `
    -OutputPath (Join-Path $privateInstallDir 'rk3588-credential-helper.exe')

try {
    $credentialFile = Set-RkProtectedCredential `
        -StateDir $privateStateDir `
        -SecureValue $ClientApiKey
} finally {
    $ClientApiKey.Dispose()
}
Write-InstallStep "credential protected with DPAPI CurrentUser: $credentialFile"

if (-not (Test-Path -LiteralPath $CodexHome)) {
    New-Item -ItemType Directory -Path $CodexHome -Force | Out-Null
}
$configFile = Join-Path $CodexHome 'config.toml'
$configExisted = Test-Path -LiteralPath $configFile -PathType Leaf
$configText = if ($configExisted) {
    [IO.File]::ReadAllText($configFile)
} else {
    ''
}
$timestamp = Get-Date -Format 'yyyyMMdd-HHmmss-fff'
$operationBackup = Join-Path $backupDir "config.toml.$timestamp.bak"
if ($configExisted) {
    Write-RkUtf8Atomic -Path $operationBackup -Text $configText -Private
}

$preserveOriginal = $null -ne $existingSettings
$originalConfigExisted = if ($preserveOriginal) {
    [bool]$existingSettings.original_config_existed
} else {
    $configExisted
}
$originalConfigBackup = if ($preserveOriginal) {
    if ($existingSettings.original_config_backup) {
        [string]$existingSettings.original_config_backup
    } else {
        $null
    }
} elseif ($configExisted) {
    $operationBackup
} else {
    $null
}
$originalConfigHash = if ($preserveOriginal) {
    if ($existingSettings.original_config_sha256) {
        [string]$existingSettings.original_config_sha256
    } else {
        $null
    }
} elseif ($configExisted) {
    Get-RkSha256 $operationBackup
} else {
    $null
}
$previousModelLine = if ($preserveOriginal) {
    $existingSettings.previous_model_line
} else {
    Get-RkTopLevelLine -Text $configText -Key 'model'
}
$previousProviderLine = if ($preserveOriginal) {
    $existingSettings.previous_model_provider_line
} else {
    Get-RkTopLevelLine -Text $configText -Key 'model_provider'
}

$updated = Remove-RkTomlProvider -Text $configText -ProviderId $script:RkProviderId
if (-not $DoNotSetDefault) {
    $updated = Set-RkTopLevelLine -Text $updated `
        -Key 'model' `
        -Line ('model = ' + (ConvertTo-RkTomlString $Model))
    $updated = Set-RkTopLevelLine -Text $updated `
        -Key 'model_provider' `
        -Line ('model_provider = ' + (ConvertTo-RkTomlString $script:RkProviderId))
}

$providerBlock = @"

[model_providers.$script:RkProviderId]
name = "RK3588 via Japan"
base_url = $(ConvertTo-RkTomlString $BaseUrl)
wire_api = "responses"

[model_providers.$script:RkProviderId.auth]
command = $(ConvertTo-RkTomlString $credentialHelper)
args = [
  "--state-dir",
  $(ConvertTo-RkTomlString $privateStateDir),
]
timeout_ms = 5000
refresh_interval_ms = 0
"@
$updated = $updated.TrimEnd() + "`r`n" +
    ($providerBlock -replace "`r?`n", "`r`n").TrimStart() + "`r`n"
Write-RkUtf8Atomic -Path $configFile -Text $updated

$settings = [ordered]@{
    schema_version = 1
    provider_id = $script:RkProviderId
    base_url = $BaseUrl
    model = $Model
    set_as_default = -not [bool]$DoNotSetDefault
    install_dir = $privateInstallDir
    state_dir = $privateStateDir
    codex_home = $CodexHome
    codex_config = $configFile
    installed_at = [DateTimeOffset]::UtcNow.ToString('o')
    config_after_sha256 = Get-RkSha256 $configFile
    last_config_backup = if ($configExisted) { $operationBackup } else { $null }
    original_config_existed = $originalConfigExisted
    original_config_backup = $originalConfigBackup
    original_config_sha256 = $originalConfigHash
    previous_model_line = $previousModelLine
    previous_model_provider_line = $previousProviderLine
}
Write-RkUtf8Atomic -Path $settingsFile `
    -Text ($settings | ConvertTo-Json -Depth 6) -Private

try {
    if (-not $SkipCodexCheck) {
        [void](Invoke-RkCodexConfigCheck `
            -CodexHome $CodexHome `
            -CodexCommand $CodexCommand)
    }
    & (Join-Path $privateInstallDir 'test-rk3588-client.ps1') `
        -StateDir $privateStateDir `
        -SkipTailscaleCheck:$SkipTailscaleCheck `
        -SkipEndpointCheck:$SkipEndpointCheck | Out-Null
} catch {
    Write-Warning 'Installation was saved, but validation failed. Fix connectivity and rerun test-rk3588-client.ps1.'
    throw
}

Write-InstallStep "Codex config updated: $configFile"
if ($configExisted) {
    Write-InstallStep "configuration backup: $operationBackup"
}
Write-InstallStep 'validation passed'
Write-Host ''
Write-Host 'Next:'
Write-Host "  & '$(Join-Path $privateInstallDir 'test-rk3588-client.ps1')'"
Write-Host "  codex"
