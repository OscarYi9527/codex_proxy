$ErrorActionPreference = 'Stop'
$repo = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$start = Join-Path $repo 'tools\start-ai-editor-dev.ps1'
$stop = Join-Path $repo 'tools\stop-ai-editor-dev.ps1'
$reset = Join-Path $repo 'tools\reset-ai-editor-dev.ps1'
$testRoot = Join-Path $repo '.ai-editor-dev\script-contract-test'
$pidGuardRoot = Join-Path $repo '.ai-editor-dev\script-pid-guard-test'
$lifecycleRoot = Join-Path $repo '.ai-editor-dev\script-lifecycle-test'

function Assert-Throws {
    param(
        [Parameter(Mandatory = $true)][scriptblock]$Action,
        [Parameter(Mandatory = $true)][string]$Message
    )
    $threw = $false
    try {
        & $Action
    } catch {
        $threw = $true
    }
    if (-not $threw) {
        throw $Message
    }
}

function Wait-HttpReady {
    param(
        [Parameter(Mandatory = $true)][string]$Uri,
        [int]$TimeoutSeconds = 20
    )
    $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
    do {
        try {
            return Invoke-RestMethod -Uri $Uri -TimeoutSec 2
        } catch {
            Start-Sleep -Milliseconds 250
        }
    } while ([DateTime]::UtcNow -lt $deadline)
    throw "Timed out waiting for $Uri"
}

try {
    $valid = & $start -Mode all -DataRoot $testRoot -GatewayPort 47920 -EdgePort 47921 `
        -ProviderWorkerPort 47930 -ValidateOnly
    if (-not $valid.valid) {
        throw 'Expected valid isolated configuration'
    }

    Assert-Throws -Message 'Shared port 47892 must be rejected' -Action {
        & $start -Mode gateway -DataRoot $testRoot -GatewayPort 47892 -ValidateOnly
    }
    Assert-Throws -Message 'Repository root must be rejected as a data root' -Action {
        & $start -Mode gateway -DataRoot $repo -ValidateOnly
    }
    Assert-Throws -Message 'Equal Gateway and Edge ports must be rejected' -Action {
        & $start -Mode all -DataRoot $testRoot -GatewayPort 47920 -EdgePort 47920 `
            -ProviderWorkerPort 47930 -ValidateOnly
    }
    Assert-Throws -Message 'Provider Worker must use isolated port 47930' -Action {
        & $start -Mode provider-worker -DataRoot $testRoot -ProviderWorkerPort 47892 -ValidateOnly
    }

    New-Item -ItemType Directory -Force -Path $testRoot | Out-Null
    Set-Content -LiteralPath (Join-Path $testRoot '.ai-editor-dev-root') -Value 'test'
    Set-Content -LiteralPath (Join-Path $testRoot 'sentinel.txt') -Value 'preserve until exact confirmation'
    Assert-Throws -Message 'Reset must reject a mismatched confirmation path' -Action {
        & $reset -DataRoot $testRoot -ConfirmDataRoot (Join-Path $testRoot 'wrong') -Force
    }
    if (-not (Test-Path -LiteralPath (Join-Path $testRoot 'sentinel.txt'))) {
        throw 'Rejected reset removed the sentinel'
    }
    & $reset -DataRoot $testRoot -ConfirmDataRoot $testRoot -Force
    if (Test-Path -LiteralPath $testRoot) {
        throw 'Confirmed reset did not remove the isolated target'
    }

    New-Item -ItemType Directory -Force -Path $pidGuardRoot | Out-Null
    Set-Content -LiteralPath (Join-Path $pidGuardRoot '.ai-editor-dev-root') -Value 'test'
    @{
        pid = $PID
        mode = 'gateway'
        repository = $repo
        data_root = $pidGuardRoot
        started_at = [DateTimeOffset]::UtcNow.ToString('o')
    } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $pidGuardRoot 'gateway.pid.json')
    Assert-Throws -Message 'Live recorded PID metadata must block startup' -Action {
        & $start -Mode gateway -DataRoot $pidGuardRoot -GatewayPort 47920
    }
    Remove-Item -LiteralPath (Join-Path $pidGuardRoot 'gateway.pid.json') -Force
    & $reset -DataRoot $pidGuardRoot -ConfirmDataRoot $pidGuardRoot -Force

    foreach ($port in @(47920, 47921, 47930)) {
        if (Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue) {
            throw "Lifecycle test requires unused development port $port"
        }
    }
    $sharedBefore = Get-NetTCPConnection -LocalPort 47892 -State Listen -ErrorAction SilentlyContinue |
        Select-Object -First 1
    & $start -Mode all -DataRoot $lifecycleRoot -GatewayPort 47920 -EdgePort 47921 `
        -ProviderWorkerPort 47930 -AuthenticationMode mock
    Assert-Throws -Message 'A second start must not overwrite live PID metadata' -Action {
        & $start -Mode all -DataRoot $lifecycleRoot -GatewayPort 47920 -EdgePort 47921 `
            -ProviderWorkerPort 47930 -AuthenticationMode mock
    }
    $gatewayLive = Wait-HttpReady -Uri 'http://127.0.0.1:47920/live'
    $edgeLive = Wait-HttpReady -Uri 'http://127.0.0.1:47921/live'
    $workerLive = Wait-HttpReady -Uri 'http://127.0.0.1:47930/live'
    if (
        $gatewayLive.mode -ne 'gateway' -or
        $edgeLive.mode -ne 'edge' -or
        $workerLive.mode -ne 'provider-worker'
    ) {
        throw 'Lifecycle test started an unexpected service mode'
    }
    foreach ($mode in @('gateway', 'edge', 'provider-worker')) {
        $metadata = Get-Content -LiteralPath (Join-Path $lifecycleRoot "$mode.pid.json") -Raw |
            ConvertFrom-Json
        $process = Get-CimInstance Win32_Process -Filter "ProcessId=$([int]$metadata.pid)"
        if (([string]$process.CommandLine).IndexOf($repo, [StringComparison]::OrdinalIgnoreCase) -lt 0) {
            throw "$mode PID does not belong to the repository"
        }
    }
    & $stop -Mode all -DataRoot $lifecycleRoot
    Start-Sleep -Milliseconds 500
    foreach ($port in @(47920, 47921, 47930)) {
        if (Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue) {
            throw "Lifecycle stop left port $port listening"
        }
    }
    if ($null -ne $sharedBefore) {
        $sharedAfter = Get-NetTCPConnection -LocalPort 47892 -State Listen -ErrorAction SilentlyContinue |
            Select-Object -First 1
        if ($null -eq $sharedAfter -or $sharedAfter.OwningProcess -ne $sharedBefore.OwningProcess) {
            throw 'Lifecycle scripts changed the shared 47892 process'
        }
    }
    & $reset -DataRoot $lifecycleRoot -ConfirmDataRoot $lifecycleRoot -Force
    Write-Host 'AI Editor development script contract tests passed'
} finally {
    if (Test-Path -LiteralPath $pidGuardRoot) {
        $pidFile = Join-Path $pidGuardRoot 'gateway.pid.json'
        if (Test-Path -LiteralPath $pidFile) {
            Remove-Item -LiteralPath $pidFile -Force
        }
        if (Test-Path -LiteralPath (Join-Path $pidGuardRoot '.ai-editor-dev-root')) {
            try {
                & $reset -DataRoot $pidGuardRoot -ConfirmDataRoot $pidGuardRoot -Force
            } catch {
                Write-Warning "PID guard cleanup could not reset its isolated root: $($_.Exception.Message)"
            }
        }
    }
    if (Test-Path -LiteralPath $lifecycleRoot) {
        try {
            & $stop -Mode all -DataRoot $lifecycleRoot
        } catch {
            Write-Warning "Lifecycle cleanup could not stop child processes: $($_.Exception.Message)"
        }
        if (Test-Path -LiteralPath (Join-Path $lifecycleRoot '.ai-editor-dev-root')) {
            try {
                & $reset -DataRoot $lifecycleRoot -ConfirmDataRoot $lifecycleRoot -Force
            } catch {
                Write-Warning "Lifecycle cleanup could not reset its isolated root: $($_.Exception.Message)"
            }
        }
    }
    if (Test-Path -LiteralPath $testRoot) {
        Remove-Item -LiteralPath $testRoot -Recurse -Force
    }
}
