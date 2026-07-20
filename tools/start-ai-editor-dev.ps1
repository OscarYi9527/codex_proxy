[CmdletBinding()]
param(
    [ValidateSet('all', 'gateway', 'edge', 'provider-worker')]
    [string]$Mode = 'all',
    [string]$DataRoot,
    [int]$GatewayPort = 47920,
    [int]$EdgePort = 47921,
    [int]$ProviderWorkerPort = 47930,
    [ValidateSet('ready', 'login_required', 'account_unavailable', 'service_unavailable', 'password_change_required')]
    [string]$MockState = 'ready',
    [ValidateSet('real', 'mock')]
    [string]$AuthenticationMode,
    [ValidateSet('mock', 'chatgpt-sub')]
    [string]$ProviderWorkerExecutor,
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
$ProviderWorkerExecutor = if ([string]::IsNullOrWhiteSpace($ProviderWorkerExecutor)) {
    if ($AuthenticationMode -eq 'real') { 'chatgpt-sub' } else { 'mock' }
} else {
    $ProviderWorkerExecutor
}
Assert-AiEditorPort -Port $GatewayPort -Name 'Gateway'
Assert-AiEditorPort -Port $EdgePort -Name 'Edge'
Assert-AiEditorPort -Port $ProviderWorkerPort -Name 'Provider Worker'
if (@(@($GatewayPort, $EdgePort, $ProviderWorkerPort) | Select-Object -Unique).Count -ne 3) {
    throw 'Gateway, Edge, and Provider Worker ports must be different'
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
        providerWorker = "http://127.0.0.1:$ProviderWorkerPort"
        providerWorkerExecutor = $ProviderWorkerExecutor
        authenticationMode = $AuthenticationMode
    }
    return
}

foreach ($port in @($GatewayPort, $EdgePort, $ProviderWorkerPort)) {
    if (($Mode -eq 'all') -or
        ($Mode -eq 'gateway' -and $port -eq $GatewayPort) -or
        ($Mode -eq 'edge' -and $port -eq $EdgePort) -or
        ($Mode -eq 'provider-worker' -and $port -eq $ProviderWorkerPort)) {
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
if ($Mode -in @('all', 'provider-worker')) {
    Assert-AiEditorProcessSlotAvailable -Mode provider-worker -DataRoot $DataRoot
}
$localNonceBytes = [byte[]](1..32 | ForEach-Object { Get-Random -Maximum 256 })
$localNonce = [Convert]::ToBase64String($localNonceBytes)
[IO.File]::WriteAllText(
    (Join-Path $DataRoot 'edge-local-nonce.secret'),
    $localNonce,
    (New-Object Text.UTF8Encoding($false))
)
$providerWorkerSecretBytes = New-Object byte[] 48
$random = [Security.Cryptography.RandomNumberGenerator]::Create()
try {
    $random.GetBytes($providerWorkerSecretBytes)
} finally {
    $random.Dispose()
}
$providerWorkerSigningSecret = [Convert]::ToBase64String($providerWorkerSecretBytes)

$startedModes = New-Object 'System.Collections.Generic.List[string]'
try {
    if ($Mode -in @('all', 'provider-worker')) {
        $providerWorkerRoot = Join-Path $DataRoot 'provider-worker'
        Initialize-AiEditorDataRoot -DataRoot $providerWorkerRoot
        $processId = Start-AiEditorProcess `
            -Mode provider-worker `
            -NodePath $node `
            -Arguments @((Join-Path $repo 'src\launcher.js'), '--mode', 'provider-worker') `
            -Environment @{
                NODE_ENV = 'development'
                CODEX_PROXY_MODE = 'provider-worker'
                AI_EDITOR_PROVIDER_WORKER_HOST = '127.0.0.1'
                AI_EDITOR_PROVIDER_WORKER_PORT = $ProviderWorkerPort
                AI_EDITOR_PROVIDER_WORKER_DATA_ROOT = $providerWorkerRoot
                AI_EDITOR_PROVIDER_WORKER_GATEWAY_IDS = 'gateway-local'
                AI_EDITOR_PROVIDER_WORKER_SIGNING_SECRET = $providerWorkerSigningSecret
                AI_EDITOR_PROVIDER_WORKER_EXECUTOR = $ProviderWorkerExecutor
            } `
            -DataRoot $DataRoot
        $startedModes.Add('provider-worker')
        Wait-AiEditorServiceHealthy `
            -Mode provider-worker `
            -Port $ProviderWorkerPort `
            -ProcessId $processId `
            -DataRoot $DataRoot
        Write-Host "Provider Worker healthy: PID $processId, http://127.0.0.1:$ProviderWorkerPort, executor=$ProviderWorkerExecutor"
    }

    if ($Mode -in @('all', 'gateway')) {
        $gatewayRoot = Join-Path $DataRoot 'gateway'
        Initialize-AiEditorDataRoot -DataRoot $gatewayRoot
        $gatewayEnvironment = @{
            NODE_ENV = 'development'
            AI_EDITOR_GATEWAY_HOST = '127.0.0.1'
            AI_EDITOR_GATEWAY_PORT = $GatewayPort
            AI_EDITOR_GATEWAY_DATA_ROOT = $gatewayRoot
            AI_EDITOR_GATEWAY_AUTH_MODE = $AuthenticationMode
            AI_EDITOR_MOCK_STATE = $MockState
        }
        if ($Mode -eq 'all') {
            $gatewayEnvironment.AI_EDITOR_PROVIDER_WORKER_ORIGIN =
                "http://127.0.0.1:$ProviderWorkerPort"
            $gatewayEnvironment.AI_EDITOR_PROVIDER_WORKER_GATEWAY_ID = 'gateway-local'
            $gatewayEnvironment.AI_EDITOR_PROVIDER_WORKER_SIGNING_SECRET =
                $providerWorkerSigningSecret
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
