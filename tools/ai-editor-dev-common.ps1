Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Get-AiEditorRepositoryRoot {
    return [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
}

function Resolve-AiEditorDataRoot {
    param([Parameter(Mandatory = $true)][string]$DataRoot)

    $repo = Get-AiEditorRepositoryRoot
    $resolved = [IO.Path]::GetFullPath($DataRoot)
    $requiredParent = [IO.Path]::GetFullPath((Join-Path $repo '.ai-editor-dev'))
    $prefix = $requiredParent.TrimEnd('\') + '\'
    if ($resolved -eq $repo -or $resolved -eq $requiredParent -or
        -not $resolved.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) {
        throw "DataRoot must be a child of $requiredParent"
    }
    return $resolved
}

function Assert-AiEditorPort {
    param(
        [Parameter(Mandatory = $true)][int]$Port,
        [Parameter(Mandatory = $true)][string]$Name
    )
    $expected = if ($Name -eq 'Gateway') { 47920 } else { 47921 }
    if ($Port -ne $expected) {
        throw "$Name development port must be fixed at $expected and cannot use shared port 47892"
    }
}

function Test-AiEditorPortAvailable {
    param([Parameter(Mandatory = $true)][int]$Port)
    $listener = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
    return $null -eq $listener
}

function Assert-AiEditorProcessSlotAvailable {
    param(
        [Parameter(Mandatory = $true)][ValidateSet('gateway', 'edge')][string]$Mode,
        [Parameter(Mandatory = $true)][string]$DataRoot
    )

    $pidFile = Join-Path $DataRoot "$Mode.pid.json"
    if (-not (Test-Path -LiteralPath $pidFile)) {
        return
    }
    try {
        $metadata = Get-Content -LiteralPath $pidFile -Raw -Encoding utf8 | ConvertFrom-Json
        $recordedProcessId = [int]$metadata.pid
    } catch {
        throw "Refusing to overwrite malformed $Mode PID metadata: $pidFile"
    }
    $process = Get-CimInstance Win32_Process `
        -Filter "ProcessId=$recordedProcessId" `
        -ErrorAction SilentlyContinue
    if ($null -ne $process) {
        throw "Refusing to start ${Mode}: recorded PID $recordedProcessId is still running"
    }
    Remove-Item -LiteralPath $pidFile -Force
}

function Initialize-AiEditorDataRoot {
    param([Parameter(Mandatory = $true)][string]$DataRoot)
    New-Item -ItemType Directory -Force -Path $DataRoot | Out-Null
    [IO.File]::WriteAllText(
        (Join-Path $DataRoot '.ai-editor-dev-root'),
        "isolated-ai-editor-development`n",
        (New-Object Text.UTF8Encoding($false))
    )
}

function Wait-AiEditorServiceHealthy {
    param(
        [Parameter(Mandatory = $true)][ValidateSet('gateway', 'edge')][string]$Mode,
        [Parameter(Mandatory = $true)][int]$Port,
        [Parameter(Mandatory = $true)][int]$ProcessId,
        [Parameter(Mandatory = $true)][string]$DataRoot,
        [int]$TimeoutSeconds = 20
    )

    $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
    $lastError = $null
    do {
        if ($null -eq (Get-Process -Id $ProcessId -ErrorAction SilentlyContinue)) {
            $stderr = Join-Path $DataRoot "$Mode.stderr.log"
            throw "$Mode exited before /live became healthy; inspect the isolated log at $stderr"
        }
        try {
            $health = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/live" -TimeoutSec 2
            if ($health.status -eq 'ok' -and $health.mode -eq $Mode) {
                return
            }
            $lastError = "unexpected /live response"
        } catch {
            $lastError = $_.Exception.Message
        }
        Start-Sleep -Milliseconds 250
    } while ([DateTime]::UtcNow -lt $deadline)
    throw "$Mode did not pass /live within $TimeoutSeconds seconds: $lastError"
}

function Start-AiEditorProcess {
    param(
        [Parameter(Mandatory = $true)][ValidateSet('gateway', 'edge')][string]$Mode,
        [Parameter(Mandatory = $true)][string]$NodePath,
        [Parameter(Mandatory = $true)][string[]]$Arguments,
        [Parameter(Mandatory = $true)][hashtable]$Environment,
        [Parameter(Mandatory = $true)][string]$DataRoot
    )

    $repo = Get-AiEditorRepositoryRoot
    $stdout = Join-Path $DataRoot "$Mode.stdout.log"
    $stderr = Join-Path $DataRoot "$Mode.stderr.log"
    $quotedArguments = foreach ($argument in $Arguments) {
        '"' + ([string]$argument).Replace('"', '\"') + '"'
    }
    $argumentLine = $quotedArguments -join ' '
    $previousEnvironment = @{}
    try {
        foreach ($entry in $Environment.GetEnumerator()) {
            $previousEnvironment[$entry.Key] = [Environment]::GetEnvironmentVariable(
                [string]$entry.Key,
                [EnvironmentVariableTarget]::Process
            )
            [Environment]::SetEnvironmentVariable(
                [string]$entry.Key,
                [string]$entry.Value,
                [EnvironmentVariableTarget]::Process
            )
        }
        $process = Start-Process `
            -FilePath $NodePath `
            -ArgumentList $argumentLine `
            -WorkingDirectory $repo `
            -WindowStyle Hidden `
            -RedirectStandardOutput $stdout `
            -RedirectStandardError $stderr `
            -PassThru
    } finally {
        foreach ($entry in $Environment.GetEnumerator()) {
            [Environment]::SetEnvironmentVariable(
                [string]$entry.Key,
                $previousEnvironment[$entry.Key],
                [EnvironmentVariableTarget]::Process
            )
        }
    }
    if ($null -eq $process) {
        throw "Failed to start $Mode"
    }

    $metadata = [ordered]@{
        pid = $process.Id
        mode = $Mode
        repository = $repo
        data_root = $DataRoot
        started_at = [DateTimeOffset]::UtcNow.ToString('o')
    }
    $metadata | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $DataRoot "$Mode.pid.json") -Encoding utf8
    return $process.Id
}

function Stop-AiEditorProcess {
    param(
        [Parameter(Mandatory = $true)][ValidateSet('gateway', 'edge')][string]$Mode,
        [Parameter(Mandatory = $true)][string]$DataRoot
    )
    $pidFile = Join-Path $DataRoot "$Mode.pid.json"
    if (-not (Test-Path -LiteralPath $pidFile)) {
        return $false
    }
    $metadata = Get-Content -LiteralPath $pidFile -Raw -Encoding utf8 | ConvertFrom-Json
    $process = Get-CimInstance Win32_Process -Filter "ProcessId=$([int]$metadata.pid)" -ErrorAction SilentlyContinue
    if ($null -ne $process) {
        $repo = Get-AiEditorRepositoryRoot
        $processTree = New-Object 'System.Collections.Generic.List[object]'
        $pending = New-Object 'System.Collections.Generic.Queue[object]'
        $pending.Enqueue($process)
        while ($pending.Count -gt 0) {
            $candidate = $pending.Dequeue()
            if (([string]$candidate.CommandLine).IndexOf($repo, [StringComparison]::OrdinalIgnoreCase) -lt 0) {
                throw "Refusing to stop PID $($candidate.ProcessId): command does not belong to $repo"
            }
            $processTree.Add($candidate)
            $children = Get-CimInstance Win32_Process `
                -Filter "ParentProcessId=$([int]$candidate.ProcessId)" `
                -ErrorAction SilentlyContinue
            foreach ($child in @($children)) {
                if ([string]$child.Name -ieq 'node.exe') {
                    $pending.Enqueue($child)
                }
            }
        }
        for ($index = $processTree.Count - 1; $index -ge 0; $index--) {
            Stop-Process -Id ([int]$processTree[$index].ProcessId) -Force -ErrorAction SilentlyContinue
        }
    }
    Remove-Item -LiteralPath $pidFile -Force
    return $true
}
