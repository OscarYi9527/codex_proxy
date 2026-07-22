param(
    [string]$StateDir,
    [Security.SecureString]$ClientApiKey,
    [switch]$ClientApiKeyStdin
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0
. (Join-Path $PSScriptRoot 'rk3588-client-common.ps1')

Assert-RkWindows
if ([string]::IsNullOrWhiteSpace($StateDir)) {
    $StateDir = Get-RkDefaultRoot
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

try {
    $credentialFile = Set-RkProtectedCredential `
        -StateDir (ConvertTo-RkFullPath $StateDir) `
        -SecureValue $ClientApiKey
} finally {
    $ClientApiKey.Dispose()
}
Write-Host "[rk3588-key] protected with Windows DPAPI CurrentUser: $credentialFile"
