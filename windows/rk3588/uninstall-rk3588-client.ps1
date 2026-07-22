param(
    [string]$StateDir,
    [switch]$PurgeCredential
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0
. (Join-Path $PSScriptRoot 'rk3588-client-common.ps1')

function Restore-RkPreviousTopLevel {
    param(
        [Parameter(Mandatory = $true)][string]$Text,
        [Parameter(Mandatory = $true)]$Settings
    )

    $currentProvider = Get-RkTopLevelLine -Text $Text -Key 'model_provider'
    $installedProvider = 'model_provider = ' +
        (ConvertTo-RkTomlString ([string]$Settings.provider_id))
    if ($currentProvider -ne $installedProvider) {
        return $Text
    }
    $restored = Set-RkTopLevelLine -Text $Text `
        -Key 'model_provider' `
        -Line $(if ($Settings.previous_model_provider_line) {
            [string]$Settings.previous_model_provider_line
        } else {
            $null
        })
    $currentModel = Get-RkTopLevelLine -Text $restored -Key 'model'
    $installedModel = 'model = ' + (ConvertTo-RkTomlString ([string]$Settings.model))
    if ($currentModel -eq $installedModel) {
        $restored = Set-RkTopLevelLine -Text $restored `
            -Key 'model' `
            -Line $(if ($Settings.previous_model_line) {
                [string]$Settings.previous_model_line
            } else {
                $null
            })
    }
    return $restored
}

Assert-RkWindows
if ([string]::IsNullOrWhiteSpace($StateDir)) {
    $StateDir = Get-RkDefaultRoot
}
$StateDir = ConvertTo-RkFullPath $StateDir
$settings = Get-RkSettings -StateDir $StateDir
$configFile = ConvertTo-RkFullPath ([string]$settings.codex_config)
$alreadyUninstalled = $settings.PSObject.Properties['uninstalled_at'] -and
    -not [string]::IsNullOrWhiteSpace([string]$settings.uninstalled_at)

if (-not $alreadyUninstalled -and (Test-Path -LiteralPath $configFile -PathType Leaf)) {
    $currentHash = Get-RkSha256 $configFile
    if ($currentHash -eq [string]$settings.config_after_sha256) {
        if ([bool]$settings.original_config_existed) {
            $backup = ConvertTo-RkFullPath ([string]$settings.original_config_backup)
            if (
                -not (Test-Path -LiteralPath $backup -PathType Leaf) -or
                (Get-RkSha256 $backup) -ne [string]$settings.original_config_sha256
            ) {
                throw 'The original Codex configuration backup is missing or changed; refusing unsafe rollback.'
            }
            Write-RkUtf8Atomic -Path $configFile `
                -Text ([IO.File]::ReadAllText($backup))
            Write-Host "[rk3588-uninstall] restored original Codex config: $configFile"
        } else {
            Remove-Item -LiteralPath $configFile -Force
            Write-Host "[rk3588-uninstall] removed installer-created Codex config: $configFile"
        }
    } else {
        $text = [IO.File]::ReadAllText($configFile)
        $updated = Remove-RkTomlProvider -Text $text -ProviderId $script:RkProviderId
        if ([bool]$settings.set_as_default) {
            $updated = Restore-RkPreviousTopLevel -Text $updated -Settings $settings
        }
        $backupDir = Ensure-RkPrivateDirectory (Join-Path $StateDir 'config-backups')
        $backup = Join-Path $backupDir (
            'config.toml.pre-uninstall.{0}.bak' -f (Get-Date -Format 'yyyyMMdd-HHmmss-fff')
        )
        Write-RkUtf8Atomic -Path $backup -Text $text -Private
        Write-RkUtf8Atomic -Path $configFile -Text $updated
        Write-Warning "Codex config changed after installation; removed only the RK3588 provider. Backup: $backup"
    }
}

if (-not $PurgeCredential) {
    $settings | Add-Member -NotePropertyName 'uninstalled_at' `
        -NotePropertyValue ([DateTimeOffset]::UtcNow.ToString('o')) -Force
    $settings | Add-Member -NotePropertyName 'config_after_uninstall_sha256' `
        -NotePropertyValue (Get-RkSha256 $configFile) -Force
    Write-RkUtf8Atomic `
        -Path (Join-Path $StateDir $script:RkSettingsFileName) `
        -Text ($settings | ConvertTo-Json -Depth 6) `
        -Private
}

$knownClientFiles = @(
    'rk3588-client-common.ps1',
    'Rk3588CredentialHelper.cs',
    'rk3588-credential-helper.exe',
    'set-rk3588-client-key.ps1',
    'test-rk3588-client.ps1',
    'install-rk3588-client.ps1',
    'uninstall-rk3588-client.ps1'
)
$installDir = ConvertTo-RkFullPath ([string]$settings.install_dir)
foreach ($name in $knownClientFiles) {
    if (
        -not $PurgeCredential -and
        $name -in @('rk3588-client-common.ps1', 'uninstall-rk3588-client.ps1')
    ) {
        continue
    }
    $file = Join-Path $installDir $name
    if (Test-Path -LiteralPath $file -PathType Leaf) {
        Remove-Item -LiteralPath $file -Force
    }
}
if (
    (Test-Path -LiteralPath $installDir -PathType Container) -and
    @(Get-ChildItem -LiteralPath $installDir -Force).Count -eq 0
) {
    Remove-Item -LiteralPath $installDir -Force
}

if ($PurgeCredential) {
    foreach ($name in @($script:RkCredentialFileName, $script:RkSettingsFileName)) {
        $file = Join-Path $StateDir $name
        if (Test-Path -LiteralPath $file -PathType Leaf) {
            Remove-Item -LiteralPath $file -Force
        }
    }
    $backupDir = Join-Path $StateDir 'config-backups'
    if (Test-Path -LiteralPath $backupDir -PathType Container) {
        foreach ($file in Get-ChildItem -LiteralPath $backupDir -File -Force) {
            if ($file.Name -like 'config.toml.*.bak') {
                Remove-Item -LiteralPath $file.FullName -Force
            }
        }
        if (@(Get-ChildItem -LiteralPath $backupDir -Force).Count -eq 0) {
            Remove-Item -LiteralPath $backupDir -Force
        }
    }
    if (
        (Test-Path -LiteralPath $StateDir -PathType Container) -and
        @(Get-ChildItem -LiteralPath $StateDir -Force).Count -eq 0
    ) {
        Remove-Item -LiteralPath $StateDir -Force
    }
    Write-Host '[rk3588-uninstall] installed files, state, and DPAPI credential removed'
} else {
    Write-Host "[rk3588-uninstall] runtime files removed; protected credential retained at: $StateDir"
    Write-Host "[rk3588-uninstall] cleanup command retained at: $(Join-Path $installDir 'uninstall-rk3588-client.ps1')"
    Write-Host '[rk3588-uninstall] rerun that command with -PurgeCredential to remove retained state'
}
