[CmdletBinding()]
param(
    [ValidateSet('all', 'gateway', 'edge')]
    [string]$Mode = 'all',
    [string]$DataRoot,
    [int]$GatewayPort = 47920,
    [int]$EdgePort = 47921,
    [ValidateSet('ready', 'login_required', 'account_unavailable', 'service_unavailable', 'password_change_required')]
    [string]$MockState = 'ready',
    [switch]$ValidateOnly
)

. (Join-Path $PSScriptRoot 'ai-editor-dev-common.ps1')

$repo = Get-AiEditorRepositoryRoot
if ([string]::IsNullOrWhiteSpace($DataRoot)) {
    $DataRoot = Join-Path $repo '.ai-editor-dev\default'
}
$DataRoot = Resolve-AiEditorDataRoot -DataRoot $DataRoot
Assert-AiEditorPort -Port $GatewayPort -Name 'Gateway'
Assert-AiEditorPort -Port $EdgePort -Name 'Edge'
if ($GatewayPort -eq $EdgePort) {
    throw 'Gateway and Edge ports must be different'
}

$node = (Get-Command node -ErrorAction Stop).Source
$tsxPackage = Join-Path $repo 'node_modules\tsx\package.json'
if (-not (Test-Path -LiteralPath $tsxPackage)) {
    throw 'tsx is not installed; run npm install first'
}

if ($ValidateOnly) {
    [pscustomobject]@{
        valid = $true
        mode = $Mode
        dataRoot = $DataRoot
        gateway = "http://127.0.0.1:$GatewayPort"
        edge = "http://127.0.0.1:$EdgePort"
    }
    return
}

foreach ($port in @($GatewayPort, $EdgePort)) {
    if (($Mode -eq 'all') -or
        ($Mode -eq 'gateway' -and $port -eq $GatewayPort) -or
        ($Mode -eq 'edge' -and $port -eq $EdgePort)) {
        if (-not (Test-AiEditorPortAvailable -Port $port)) {
            throw "Port $port is already in use"
        }
    }
}

Initialize-AiEditorDataRoot -DataRoot $DataRoot
$localNonceBytes = [byte[]](1..32 | ForEach-Object { Get-Random -Maximum 256 })
$localNonce = [Convert]::ToBase64String($localNonceBytes)
[IO.File]::WriteAllText(
    (Join-Path $DataRoot 'edge-local-nonce.secret'),
    $localNonce,
    (New-Object Text.UTF8Encoding($false))
)

if ($Mode -in @('all', 'gateway')) {
    $gatewayRoot = Join-Path $DataRoot 'gateway'
    Initialize-AiEditorDataRoot -DataRoot $gatewayRoot
    $processId = Start-AiEditorProcess `
        -Mode gateway `
        -NodePath $node `
        -Arguments @('--import', 'tsx', (Join-Path $repo 'gateway\src\server.ts')) `
        -Environment @{
            NODE_ENV = 'development'
            AI_EDITOR_GATEWAY_HOST = '127.0.0.1'
            AI_EDITOR_GATEWAY_PORT = $GatewayPort
            AI_EDITOR_GATEWAY_DATA_ROOT = $gatewayRoot
            AI_EDITOR_MOCK_STATE = $MockState
        } `
        -DataRoot $DataRoot
    Write-Host "Gateway started: PID $processId, http://127.0.0.1:$GatewayPort"
}

if ($Mode -in @('all', 'edge')) {
    $edgeRoot = Join-Path $DataRoot 'edge'
    Initialize-AiEditorDataRoot -DataRoot $edgeRoot
    $processId = Start-AiEditorProcess `
        -Mode edge `
        -NodePath $node `
        -Arguments @((Join-Path $repo 'src\launcher.js'), '--mode', 'edge') `
        -Environment @{
            NODE_ENV = 'development'
            CODEX_PROXY_MODE = 'edge'
            AI_EDITOR_EDGE_HOST = '127.0.0.1'
            AI_EDITOR_EDGE_PORT = $EdgePort
            AI_EDITOR_EDGE_DATA_ROOT = $edgeRoot
            AI_EDITOR_GATEWAY_ORIGIN = "http://127.0.0.1:$GatewayPort"
            AI_EDITOR_EDGE_LOCAL_NONCE = $localNonce
            AI_EDITOR_MOCK_STATE = $MockState
            AI_EDITOR_ENABLE_MOCK_CONTROL = 'true'
        } `
        -DataRoot $DataRoot
    Write-Host "Edge started: PID $processId, http://127.0.0.1:$EdgePort"
}
