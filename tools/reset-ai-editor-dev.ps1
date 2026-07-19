[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$DataRoot,
    [Parameter(Mandatory = $true)]
    [string]$ConfirmDataRoot,
    [switch]$Force
)

. (Join-Path $PSScriptRoot 'ai-editor-dev-common.ps1')

$resolved = Resolve-AiEditorDataRoot -DataRoot $DataRoot
$confirmed = [IO.Path]::GetFullPath($ConfirmDataRoot)
if ($resolved -ne $confirmed) {
    throw 'ConfirmDataRoot must exactly match the canonical DataRoot'
}
if (-not $Force) {
    throw 'Reset requires -Force after exact path confirmation'
}
if (-not (Test-Path -LiteralPath $resolved)) {
    Write-Host "Nothing to reset: $resolved"
    return
}
if (-not (Test-Path -LiteralPath (Join-Path $resolved '.ai-editor-dev-root'))) {
    throw 'Reset target is missing the AI Editor development marker'
}

foreach ($mode in @('edge', 'gateway', 'provider-worker')) {
    [void](Stop-AiEditorProcess -Mode $mode -DataRoot $resolved)
}

$repo = Get-AiEditorRepositoryRoot
$requiredParent = [IO.Path]::GetFullPath((Join-Path $repo '.ai-editor-dev')).TrimEnd('\') + '\'
if (-not $resolved.StartsWith($requiredParent, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'Reset target escaped the isolated development parent'
}
Remove-Item -LiteralPath $resolved -Recurse -Force
Write-Host "Reset isolated AI Editor development data: $resolved"
