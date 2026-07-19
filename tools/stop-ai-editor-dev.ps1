[CmdletBinding()]
param(
    [ValidateSet('all', 'gateway', 'edge', 'provider-worker')]
    [string]$Mode = 'all',
    [string]$DataRoot
)

. (Join-Path $PSScriptRoot 'ai-editor-dev-common.ps1')

$repo = Get-AiEditorRepositoryRoot
if ([string]::IsNullOrWhiteSpace($DataRoot)) {
    $DataRoot = Join-Path $repo '.ai-editor-dev\default'
}
$DataRoot = Resolve-AiEditorDataRoot -DataRoot $DataRoot
if (-not (Test-Path -LiteralPath $DataRoot)) {
    Write-Host "AI Editor development data root does not exist: $DataRoot"
    return
}

if ($Mode -in @('all', 'edge')) {
    if (Stop-AiEditorProcess -Mode edge -DataRoot $DataRoot) {
        Write-Host 'Edge stopped'
    }
}
if ($Mode -in @('all', 'gateway')) {
    if (Stop-AiEditorProcess -Mode gateway -DataRoot $DataRoot) {
        Write-Host 'Gateway stopped'
    }
}
if ($Mode -in @('all', 'provider-worker')) {
    if (Stop-AiEditorProcess -Mode provider-worker -DataRoot $DataRoot) {
        Write-Host 'Provider Worker stopped'
    }
}
