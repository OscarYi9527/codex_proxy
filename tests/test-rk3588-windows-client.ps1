$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0

$repo = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$testParent = [IO.Path]::GetFullPath((Join-Path $repo '.ai-editor-dev'))
$testRoot = [IO.Path]::GetFullPath(
    (Join-Path $testParent ('rk3588-windows-client-' + [Guid]::NewGuid().ToString('N')))
)
$source = Join-Path $repo 'windows\rk3588'
$installer = Join-Path $source 'install-rk3588-client.ps1'

function Assert-True {
    param(
        [Parameter(Mandatory = $true)][bool]$Condition,
        [Parameter(Mandatory = $true)][string]$Message
    )
    if (-not $Condition) {
        throw $Message
    }
}

function Assert-PathInsideTestRoot {
    param([Parameter(Mandatory = $true)][string]$Path)

    $resolved = [IO.Path]::GetFullPath($Path)
    $prefix = $testParent.TrimEnd('\') + '\'
    if (
        -not $resolved.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase) -or
        $resolved -eq $testParent
    ) {
        throw "Refusing cleanup outside the isolated test parent: $resolved"
    }
    return $resolved
}

function New-TestCredential {
    return 'rk_test_' +
        [Guid]::NewGuid().ToString('N') +
        [Guid]::NewGuid().ToString('N')
}

function ConvertTo-TestSecureString {
    param([Parameter(Mandatory = $true)][string]$Value)

    $secureValue = [Security.SecureString]::new()
    foreach ($character in $Value.ToCharArray()) {
        $secureValue.AppendChar($character)
    }
    $secureValue.MakeReadOnly()
    return $secureValue
}

function Install-TestClient {
    param(
        [Parameter(Mandatory = $true)][string]$Credential,
        [Parameter(Mandatory = $true)][string]$Model,
        [switch]$CheckCodex,
        [switch]$DoNotSetDefault
    )

    $secure = ConvertTo-TestSecureString $Credential
    & $installer `
        -BaseUrl 'https://rk3588-relay.example.ts.net/v1' `
        -Model $Model `
        -InstallDir (Join-Path $testRoot 'client') `
        -StateDir (Join-Path $testRoot 'state') `
        -CodexHome (Join-Path $testRoot 'codex') `
        -CodexCommand (Join-Path $testRoot 'mock-codex.cmd') `
        -ClientApiKey $secure `
        -DoNotSetDefault:$DoNotSetDefault `
        -SkipCodexCheck:(-not $CheckCodex) `
        -SkipTailscaleCheck `
        -SkipEndpointCheck
}

function Assert-NoCredentialInArtifacts {
    param([Parameter(Mandatory = $true)][string[]]$Credentials)

    foreach ($file in Get-ChildItem -LiteralPath $testRoot -Recurse -File -Force) {
        if ($file.Length -gt 2MB) {
            continue
        }
        $text = [IO.File]::ReadAllText($file.FullName)
        foreach ($credential in $Credentials) {
            Assert-True `
                -Condition (-not $text.Contains($credential)) `
                -Message "A plaintext credential leaked into $($file.FullName)"
        }
    }
}

Assert-PathInsideTestRoot $testRoot | Out-Null
$originalConfig = @'
model = "before-model"
model_provider = "before-provider"

[model_providers.before-provider]
name = "Existing provider"
base_url = "https://before.example/v1"
wire_api = "responses"
'@ -replace "`r?`n", "`r`n"

try {
    New-Item -ItemType Directory -Path (Join-Path $testRoot 'codex') -Force |
        Out-Null
    [IO.File]::WriteAllText(
        (Join-Path $testRoot 'codex\config.toml'),
        $originalConfig,
        [Text.UTF8Encoding]::new($false)
    )
    [IO.File]::WriteAllText(
        (Join-Path $testRoot 'mock-codex.cmd'),
        @'
@echo off
if /I not "%~1"=="features" exit /b 21
if /I not "%~2"=="list" exit /b 22
if not exist "%CODEX_HOME%\config.toml" exit /b 23
> "%CODEX_HOME%\mock-codex-checked" echo checked
exit /b 0
'@,
        [Text.ASCIIEncoding]::new()
    )

    $credentialOne = New-TestCredential
    Install-TestClient `
        -Credential $credentialOne `
        -Model 'rk-test-model-one' `
        -CheckCodex

    $configFile = Join-Path $testRoot 'codex\config.toml'
    $settingsFile = Join-Path $testRoot 'state\client.json'
    $credentialFile = Join-Path $testRoot 'state\credential.dpapi.json'
    $helper = Join-Path $testRoot 'client\rk3588-credential-helper.exe'
    $tester = Join-Path $testRoot 'client\test-rk3588-client.ps1'
    $keySetter = Join-Path $testRoot 'client\set-rk3588-client-key.ps1'
    $uninstaller = Join-Path $testRoot 'client\uninstall-rk3588-client.ps1'

    $config = [IO.File]::ReadAllText($configFile)
    Assert-True `
        -Condition $config.Contains('[model_providers.rk3588_jp.auth]') `
        -Message 'Installer did not configure command-backed authentication.'
    Assert-True `
        -Condition $config.Contains('refresh_interval_ms = 0') `
        -Message 'Command-backed authentication must refresh only after an authentication retry.'
    Assert-True `
        -Condition (-not $config.Contains('env_key')) `
        -Message 'Command-backed authentication must not be combined with env_key.'
    Assert-True `
        -Condition (-not $config.Contains('requires_openai_auth')) `
        -Message 'Command-backed authentication must not be combined with requires_openai_auth.'
    Assert-True `
        -Condition $config.Contains('model_provider = "rk3588_jp"') `
        -Message 'Installer did not select the RK3588 provider.'
    Assert-True `
        -Condition (Test-Path -LiteralPath (Join-Path $testRoot 'codex\mock-codex-checked')) `
        -Message 'Installer did not ask Codex to parse the generated config.'

    $envelope = Get-Content -LiteralPath $credentialFile -Raw -Encoding UTF8 |
        ConvertFrom-Json
    Assert-True `
        -Condition ($envelope.protection -eq 'Windows DPAPI CurrentUser') `
        -Message 'Credential envelope is not protected with DPAPI CurrentUser.'
    $credentialAcl = (Get-Item -LiteralPath $credentialFile -Force).
        GetAccessControl([Security.AccessControl.AccessControlSections]::Access)
    Assert-True `
        -Condition (@($credentialAcl.Access | Where-Object IsInherited).Count -eq 0) `
        -Message 'Credential file retained inherited ACL entries.'
    Assert-NoCredentialInArtifacts -Credentials @($credentialOne)

    $checkOutput = @(
        & $helper --state-dir (Join-Path $testRoot 'state') --check 2>&1
    )
    Assert-True `
        -Condition ($LASTEXITCODE -eq 0 -and $checkOutput.Count -eq 0) `
        -Message 'Credential helper check mode must succeed without stdout.'
    $roundTrip = & $helper --state-dir (Join-Path $testRoot 'state')
    Assert-True `
        -Condition ($LASTEXITCODE -eq 0 -and $roundTrip -eq $credentialOne) `
        -Message 'Credential helper did not round-trip the DPAPI value.'
    $roundTrip = $null

    $diagnostic = & $tester `
        -StateDir (Join-Path $testRoot 'state') `
        -SkipTailscaleCheck `
        -SkipEndpointCheck
    Assert-True `
        -Condition (
            $diagnostic.ok -and
            $diagnostic.dpapi -eq 'ok' -and
            $diagnostic.tailscale -eq 'skipped' -and
            $diagnostic.endpoint -eq 'skipped'
        ) `
        -Message 'Offline client diagnostics did not pass.'

    $credentialTwo = New-TestCredential
    $secureTwo = ConvertTo-TestSecureString $credentialTwo
    & $keySetter -StateDir (Join-Path $testRoot 'state') -ClientApiKey $secureTwo
    $rotated = & $helper --state-dir (Join-Path $testRoot 'state')
    Assert-True `
        -Condition ($LASTEXITCODE -eq 0 -and $rotated -eq $credentialTwo) `
        -Message 'Credential rotation did not update the DPAPI value.'
    $rotated = $null
    Assert-NoCredentialInArtifacts -Credentials @($credentialOne, $credentialTwo)

    $protectedEnvelope = [IO.File]::ReadAllText($credentialFile)
    $tamperedEnvelope = $protectedEnvelope | ConvertFrom-Json
    $tamperedEnvelope.ciphertext = [Convert]::ToBase64String(
        [Text.Encoding]::UTF8.GetBytes('not-a-valid-dpapi-payload')
    )
    [IO.File]::WriteAllText(
        $credentialFile,
        ($tamperedEnvelope | ConvertTo-Json -Depth 4),
        [Text.UTF8Encoding]::new($false)
    )
    $previousErrorActionPreference = $ErrorActionPreference
    try {
        $ErrorActionPreference = 'Continue'
        $tamperOutput = @(
            & $helper --state-dir (Join-Path $testRoot 'state') 2>&1
        )
    } finally {
        $ErrorActionPreference = $previousErrorActionPreference
    }
    Assert-True `
        -Condition ($LASTEXITCODE -ne 0) `
        -Message 'Credential helper accepted a tampered DPAPI envelope.'
    $safeError = $tamperOutput -join "`n"
    Assert-True `
        -Condition (
            $safeError.Contains('[rk3588-auth] credential unavailable or invalid') -and
            -not $safeError.Contains($credentialOne) -and
            -not $safeError.Contains($credentialTwo)
        ) `
        -Message 'Credential helper did not return a stable, redacted tamper error.'
    [IO.File]::WriteAllText(
        $credentialFile,
        $protectedEnvelope,
        [Text.UTF8Encoding]::new($false)
    )

    Install-TestClient -Credential $credentialTwo -Model 'rk-test-model-two'
    $settings = Get-Content -LiteralPath $settingsFile -Raw -Encoding UTF8 |
        ConvertFrom-Json
    Assert-True `
        -Condition ($settings.original_config_existed -eq $true) `
        -Message 'Reinstallation lost the original config rollback metadata.'
    Assert-True `
        -Condition (
            [IO.File]::ReadAllText([string]$settings.original_config_backup) -eq
            $originalConfig
        ) `
        -Message 'Reinstallation replaced the original config backup.'

    & $uninstaller -StateDir (Join-Path $testRoot 'state') -PurgeCredential
    Assert-True `
        -Condition ([IO.File]::ReadAllText($configFile) -eq $originalConfig) `
        -Message 'Exact uninstall did not restore the pre-install Codex config.'
    Assert-True `
        -Condition (-not (Test-Path -LiteralPath $credentialFile)) `
        -Message 'Purge uninstall retained the credential envelope.'

    Remove-Item -LiteralPath $configFile -Force
    $credentialWithoutOriginal = New-TestCredential
    Install-TestClient `
        -Credential $credentialWithoutOriginal `
        -Model 'rk-test-model-without-original'
    Install-TestClient `
        -Credential $credentialWithoutOriginal `
        -Model 'rk-test-model-without-original-second-install'
    $uninstaller = Join-Path $testRoot 'client\uninstall-rk3588-client.ps1'
    & $uninstaller -StateDir (Join-Path $testRoot 'state') -PurgeCredential
    Assert-True `
        -Condition (-not (Test-Path -LiteralPath $configFile)) `
        -Message 'Reinstall without an original config lost the delete-on-rollback state.'
    [IO.File]::WriteAllText(
        $configFile,
        $originalConfig,
        [Text.UTF8Encoding]::new($false)
    )

    $credentialThree = New-TestCredential
    Install-TestClient -Credential $credentialThree -Model 'rk-test-model-three'
    Add-Content -LiteralPath $configFile -Encoding UTF8 -Value @'

[user_preserved_after_install]
enabled = true
'@
    $uninstaller = Join-Path $testRoot 'client\uninstall-rk3588-client.ps1'
    & $uninstaller -StateDir (Join-Path $testRoot 'state')
    $surgicalConfig = [IO.File]::ReadAllText($configFile)
    Assert-True `
        -Condition $surgicalConfig.Contains('[user_preserved_after_install]') `
        -Message 'Surgical uninstall discarded a post-install user config change.'
    Assert-True `
        -Condition (-not $surgicalConfig.Contains('[model_providers.rk3588_jp]')) `
        -Message 'Surgical uninstall retained the RK3588 provider.'
    Assert-True `
        -Condition $surgicalConfig.Contains('model_provider = "before-provider"') `
        -Message 'Surgical uninstall did not restore the previous default provider.'
    Assert-NoCredentialInArtifacts -Credentials @($credentialThree)

    Assert-True `
        -Condition (Test-Path -LiteralPath $uninstaller -PathType Leaf) `
        -Message 'Default uninstall did not retain the cleanup command.'
    $beforeSecondStagePurge = [IO.File]::ReadAllText($configFile)
    & $uninstaller -StateDir (Join-Path $testRoot 'state') -PurgeCredential
    Assert-True `
        -Condition (-not (Test-Path -LiteralPath (Join-Path $testRoot 'state'))) `
        -Message 'Second-stage purge retained protected state.'
    Assert-True `
        -Condition ([IO.File]::ReadAllText($configFile) -eq $beforeSecondStagePurge) `
        -Message 'Second-stage purge modified an already rolled-back Codex config.'

    Write-Host 'RK3588 Windows client lifecycle and secret-isolation tests passed'
} finally {
    $safeRoot = Assert-PathInsideTestRoot $testRoot
    if (Test-Path -LiteralPath $safeRoot) {
        Remove-Item -LiteralPath $safeRoot -Recurse -Force
    }
}
