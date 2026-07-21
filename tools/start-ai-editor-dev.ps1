[CmdletBinding()]
param(
    [ValidateSet('all', 'gateway', 'edge')]
    [string]$Mode = 'all',
    [string]$DataRoot,
    [int]$GatewayPort = 47920,
    [int]$EdgePort = 47921,
    [ValidateSet('ready', 'login_required', 'account_unavailable', 'service_unavailable', 'password_change_required')]
    [string]$MockState = 'ready',
    [ValidateSet('real', 'mock')]
    [string]$AuthenticationMode,
    [switch]$ValidateOnly
)

. (Join-Path $PSScriptRoot 'ai-editor-dev-common.ps1')

$repo = Get-AiEditorRepositoryRoot
if ([string]::IsNullOrWhiteSpace($DataRoot)) {
    $DataRoot = Join-Path $repo '.ai-editor-dev\default'
}
$DataRoot = Resolve-AiEditorDataRoot -DataRoot $DataRoot
$AuthenticationMode = if ([string]::IsNullOrWhiteSpace($AuthenticationMode)) {
    if ($PSBoundParameters.ContainsKey('MockState')) { 'mock' } else { 'real' }
} else {
    $AuthenticationMode
}
Assert-AiEditorPort -Port $GatewayPort -Name 'Gateway'
Assert-AiEditorPort -Port $EdgePort -Name 'Edge'
if ($GatewayPort -eq $EdgePort) {
    throw 'Gateway and Edge ports must be different'
}

$node = (Get-Command node -ErrorAction Stop).Source
$npm = (Get-Command npm.cmd -ErrorAction Stop).Source
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
        authenticationMode = $AuthenticationMode
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
if ($Mode -in @('all', 'gateway')) {
    Assert-AiEditorProcessSlotAvailable -Mode gateway -DataRoot $DataRoot
}
if ($Mode -in @('all', 'edge')) {
    Assert-AiEditorProcessSlotAvailable -Mode edge -DataRoot $DataRoot
}
$localNonceBytes = [byte[]](1..32 | ForEach-Object { Get-Random -Maximum 256 })
$localNonce = [Convert]::ToBase64String($localNonceBytes)
[IO.File]::WriteAllText(
    (Join-Path $DataRoot 'edge-local-nonce.secret'),
    $localNonce,
    (New-Object Text.UTF8Encoding($false))
)

$startedModes = New-Object 'System.Collections.Generic.List[string]'
try {
    if ($Mode -in @('all', 'gateway')) {
        $gatewayRoot = Join-Path $DataRoot 'gateway'
        Initialize-AiEditorDataRoot -DataRoot $gatewayRoot
        $gatewayEnvironment = @{
            NODE_ENV = 'development'
            NODE_TLS_REJECT_UNAUTHORIZED = '1'
            AI_EDITOR_GATEWAY_HOST = '127.0.0.1'
            AI_EDITOR_GATEWAY_PORT = $GatewayPort
            AI_EDITOR_GATEWAY_DATA_ROOT = $gatewayRoot
            AI_EDITOR_GATEWAY_AUTH_MODE = $AuthenticationMode
            AI_EDITOR_MOCK_STATE = $MockState
        }
        if ($AuthenticationMode -eq 'real') {
            Invoke-AiEditorForegroundProcess `
                -NodePath $npm `
                -Arguments @('run', 'admin:build') `
                -Environment $gatewayEnvironment
            Invoke-AiEditorForegroundProcess `
                -NodePath $node `
                -Arguments @('--import', 'tsx', (Join-Path $repo 'gateway\src\bootstrap-cli.ts')) `
                -Environment $gatewayEnvironment
        }
        $processId = Start-AiEditorProcess `
            -Mode gateway `
            -NodePath $node `
            -Arguments @('--import', 'tsx', (Join-Path $repo 'gateway\src\server.ts')) `
            -Environment $gatewayEnvironment `
            -DataRoot $DataRoot
        $startedModes.Add('gateway')
        Wait-AiEditorServiceHealthy `
            -Mode gateway `
            -Port $GatewayPort `
            -ProcessId $processId `
            -DataRoot $DataRoot
        Write-Host "Gateway healthy: PID $processId, http://127.0.0.1:$GatewayPort"
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
                NODE_TLS_REJECT_UNAUTHORIZED = '1'
                CODEX_PROXY_MODE = 'edge'
                AI_EDITOR_EDGE_HOST = '127.0.0.1'
                AI_EDITOR_EDGE_PORT = $EdgePort
                AI_EDITOR_EDGE_DATA_ROOT = $edgeRoot
                AI_EDITOR_GATEWAY_ORIGIN = "http://127.0.0.1:$GatewayPort"
                AI_EDITOR_EDGE_LOCAL_NONCE = $localNonce
                AI_EDITOR_EDGE_AUTH_MODE = $AuthenticationMode
                AI_EDITOR_MOCK_STATE = $MockState
                AI_EDITOR_ENABLE_MOCK_CONTROL = if ($AuthenticationMode -eq 'mock') { 'true' } else { 'false' }
            } `
            -DataRoot $DataRoot
        $startedModes.Add('edge')
        Wait-AiEditorServiceHealthy `
            -Mode edge `
            -Port $EdgePort `
            -ProcessId $processId `
            -DataRoot $DataRoot
        Write-Host "Edge healthy: PID $processId, http://127.0.0.1:$EdgePort"
    }
} catch {
    for ($index = $startedModes.Count - 1; $index -ge 0; $index--) {
        try {
            [void](Stop-AiEditorProcess -Mode $startedModes[$index] -DataRoot $DataRoot)
        } catch {
            Write-Warning "Startup rollback could not stop $($startedModes[$index]): $($_.Exception.Message)"
        }
    }
    throw
}
