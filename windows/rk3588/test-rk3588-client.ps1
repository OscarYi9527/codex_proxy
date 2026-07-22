param(
    [string]$StateDir,
    [switch]$SkipTailscaleCheck,
    [switch]$SkipEndpointCheck,
    [switch]$Json
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0
. (Join-Path $PSScriptRoot 'rk3588-client-common.ps1')

Assert-RkWindows
if ([string]::IsNullOrWhiteSpace($StateDir)) {
    $StateDir = Get-RkDefaultRoot
}
$StateDir = ConvertTo-RkFullPath $StateDir
$settings = Get-RkSettings -StateDir $StateDir
$baseUrl = Get-RkValidatedBaseUrl ([string]$settings.base_url)
$uri = [Uri]$baseUrl
$helper = Join-Path ([string]$settings.install_dir) 'rk3588-credential-helper.exe'
if (-not (Test-Path -LiteralPath $helper -PathType Leaf)) {
    throw "The installed credential helper is missing: $helper"
}

$checkOutput = @(
    & $helper --state-dir $StateDir --check 2>&1
)
if ($LASTEXITCODE -ne 0 -or $checkOutput.Count -ne 0) {
    throw 'The DPAPI credential helper self-check failed.'
}

$result = [ordered]@{
    schema_version = 1
    ok = $false
    base_url = $baseUrl
    provider_id = [string]$settings.provider_id
    dpapi = 'ok'
    tailscale = if ($SkipTailscaleCheck) { 'skipped' } else { 'pending' }
    endpoint = if ($SkipEndpointCheck) { 'skipped' } else { 'pending' }
    model_count = $null
}

if (-not $SkipTailscaleCheck) {
    [void](Invoke-RkTailscaleCheck -HostName $uri.DnsSafeHost)
    $result.tailscale = 'ok'
}

if (-not $SkipEndpointCheck) {
    $previousErrorActionPreference = $ErrorActionPreference
    try {
        $ErrorActionPreference = 'Continue'
        $modelOutput = @(
            & $helper `
                --state-dir $StateDir `
                --models-url "$baseUrl/models" 2>&1
        )
        $modelExitCode = $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $previousErrorActionPreference
    }
    $modelCount = 0
    if (
        $modelExitCode -ne 0 -or
        $modelOutput.Count -ne 1 -or
        -not [int]::TryParse([string]$modelOutput[0], [ref]$modelCount) -or
        $modelCount -lt 0
    ) {
        throw 'The RK3588 /v1/models endpoint check failed.'
    }
    $result.model_count = $modelCount
    $result.endpoint = 'ok'
}

$result.ok = $true
$output = [pscustomobject]$result
if ($Json) {
    $output | ConvertTo-Json -Depth 5
} else {
    $output
}
