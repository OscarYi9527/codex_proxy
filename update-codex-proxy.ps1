param(
    [string]$SourceDir = $PSScriptRoot,
    [string]$InstallDir = (Join-Path $HOME '.codex-local-multi-proxy'),
    [int]$Port = 47892,
    [int]$HealthTimeoutSeconds = 45,
    [switch]$NoRestart,
    [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
$SourceDir = [IO.Path]::GetFullPath($SourceDir)
$InstallDir = [IO.Path]::GetFullPath($InstallDir)
$RuntimeListFile = Join-Path $SourceDir 'runtime-files.json'
$ReleaseManifestFile = Join-Path $InstallDir '.release-manifest.json'
$DeploymentResultFile = Join-Path $InstallDir '.last-deployment.json'

function Write-Step([string]$Message) {
    Write-Host "[update] $Message"
}

function Ensure-Directory([string]$Path) {
    if (-not (Test-Path -LiteralPath $Path)) {
        New-Item -ItemType Directory -Path $Path -Force | Out-Null
    }
}

function Write-AtomicBytes([string]$Path, [byte[]]$Bytes) {
    Ensure-Directory (Split-Path -Parent $Path)
    $temp = Join-Path (Split-Path -Parent $Path) ('.{0}.{1}.{2}.tmp' -f (Split-Path -Leaf $Path), $PID, [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds())
    try {
        [IO.File]::WriteAllBytes($temp, $Bytes)
        Move-Item -LiteralPath $temp -Destination $Path -Force
    } finally {
        Remove-Item -LiteralPath $temp -Force -ErrorAction SilentlyContinue
    }
}

function Write-AtomicJson([string]$Path, $Value) {
    $json = $Value | ConvertTo-Json -Depth 12
    Write-AtomicBytes $Path ([Text.UTF8Encoding]::new($false).GetBytes($json))
}

function Get-Hash([string]$Path) {
    if (-not (Test-Path -LiteralPath $Path)) { return $null }
    return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}

function Get-GitCommit([string]$Root) {
    try {
        $commit = (& git -C $Root rev-parse HEAD 2>$null | Select-Object -First 1).Trim()
        if ($LASTEXITCODE -eq 0 -and $commit) { return $commit }
    } catch {}
    return $null
}

function Invoke-ProxyStart {
    $startScript = Join-Path $InstallDir 'start-codex-proxy.ps1'
    if (-not (Test-Path -LiteralPath $startScript)) {
        throw "Missing installed start script: $startScript"
    }
    & (Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe') `
        -NoProfile -ExecutionPolicy Bypass -File $startScript
}

function Request-ProxyRestart {
    try {
        Invoke-RestMethod -Uri "http://127.0.0.1:$Port/admin/api/proxy/restart" -Method Post -TimeoutSec 5 | Out-Null
        Write-Step 'graceful restart requested'
        return $true
    } catch {
        Write-Step "proxy restart endpoint unavailable: $($_.Exception.Message)"
        return $false
    }
}

function Get-ListenerPid {
    $listener = Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($listener) { return [int]$listener.OwningProcess }
    return 0
}

function Stop-InstalledListener {
    $listenerPid = Get-ListenerPid
    if (-not $listenerPid) { return }
    $process = Get-CimInstance Win32_Process -Filter "ProcessId=$listenerPid" -ErrorAction SilentlyContinue
    $expected = (Join-Path $InstallDir 'src\server.js').ToLowerInvariant()
    if ($process -and ([string]$process.CommandLine).ToLowerInvariant().Contains($expected)) {
        Stop-Process -Id $listenerPid -Force -ErrorAction Stop
        Write-Step "stopped installed proxy pid=$listenerPid"
    } else {
        throw "Port $Port is owned by a process outside the installation; refusing to stop it"
    }
}

function Restart-InstalledProxy {
    $previousPid = Get-ListenerPid
    $requested = Request-ProxyRestart
    if ($requested -and $previousPid) {
        $stopDeadline = (Get-Date).AddSeconds(20)
        while ((Get-Date) -lt $stopDeadline) {
            Start-Sleep -Milliseconds 250
            $currentPid = Get-ListenerPid
            if (-not $currentPid -or $currentPid -ne $previousPid) { break }
        }
    }
    $currentPid = Get-ListenerPid
    if ($currentPid -and $currentPid -eq $previousPid) {
        Write-Step 'graceful restart did not release the listener in time; stopping installed process'
        Stop-InstalledListener
    }
    Invoke-ProxyStart
    return $previousPid
}

function Wait-ProxyHealthy([string]$ExpectedCommit, [bool]$RequireSynchronized = $true, [int]$PreviousPid = 0) {
    $deadline = (Get-Date).AddSeconds($HealthTimeoutSeconds)
    while ((Get-Date) -lt $deadline) {
        Start-Sleep -Milliseconds 750
        try {
            $live = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/live" -TimeoutSec 2
            if ($live.status -ne 'ok') { continue }
            $runtime = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/admin/api/runtime-info" -TimeoutSec 3
            $pathOk = [IO.Path]::GetFullPath([string]$runtime.runtime.path).TrimEnd('\') -ieq $InstallDir.TrimEnd('\')
            $commitOk = -not $ExpectedCommit -or [string]$runtime.runtime.commit -eq $ExpectedCommit
            $syncOk = -not $RequireSynchronized -or $runtime.consistency.synchronized -eq $true
            $pidOk = -not $PreviousPid -or [int]$runtime.runtime.pid -ne $PreviousPid
            if ($pathOk -and $commitOk -and $syncOk -and $pidOk) { return $runtime }
        } catch {}
    }
    return $null
}

if (-not (Test-Path -LiteralPath $RuntimeListFile)) {
    throw "Missing runtime file list: $RuntimeListFile"
}
if ([IO.Path]::GetFullPath($SourceDir).TrimEnd('\') -ieq [IO.Path]::GetFullPath($InstallDir).TrimEnd('\')) {
    throw 'SourceDir and InstallDir must be different directories'
}

$runtimeList = Get-Content -LiteralPath $RuntimeListFile -Raw -Encoding UTF8 | ConvertFrom-Json
$files = @($runtimeList.files | ForEach-Object { ([string]$_).Replace('/', '\') })
if (-not $files.Count) { throw 'runtime-files.json contains no files' }

Write-Step "source=$SourceDir"
Write-Step "installation=$InstallDir"
Write-Step "files=$($files.Count)"

& node --check (Join-Path $SourceDir 'src\server.js')
if ($LASTEXITCODE -ne 0) { throw 'Source server syntax validation failed' }

$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$backupRoot = Join-Path $InstallDir ".deploy-backups\$stamp"
$changed = [Collections.Generic.List[object]]::new()
$sourceHashes = [ordered]@{}
$version = (Get-Content -LiteralPath (Join-Path $SourceDir 'package.json') -Raw -Encoding UTF8 | ConvertFrom-Json).version
$commit = Get-GitCommit $SourceDir
$startedAt = (Get-Date).ToUniversalTime().ToString('o')
$manifestHadTarget = Test-Path -LiteralPath $ReleaseManifestFile
$manifestBackupCreated = $false
$manifestWritten = $false

try {
    if ($manifestHadTarget -and -not $DryRun) {
        Ensure-Directory $backupRoot
        Copy-Item -LiteralPath $ReleaseManifestFile -Destination (Join-Path $backupRoot '.release-manifest.json') -Force
        $manifestBackupCreated = $true
    }

    foreach ($relativePath in $files) {
        $source = Join-Path $SourceDir $relativePath
        $target = Join-Path $InstallDir $relativePath
        if (-not (Test-Path -LiteralPath $source)) {
            throw "Required runtime file is missing: $relativePath"
        }
        $sourceHash = Get-Hash $source
        $targetHash = Get-Hash $target
        $sourceHashes[$relativePath.Replace('\', '/')] = $sourceHash
        if ($sourceHash -eq $targetHash) { continue }
        $hadTarget = Test-Path -LiteralPath $target
        if ($hadTarget -and -not $DryRun) {
            $backup = Join-Path $backupRoot $relativePath
            Ensure-Directory (Split-Path -Parent $backup)
            Copy-Item -LiteralPath $target -Destination $backup -Force
        }
        $changed.Add([pscustomobject]@{ path = $relativePath; had_target = $hadTarget })
        if (-not $DryRun) {
            Write-AtomicBytes $target ([IO.File]::ReadAllBytes($source))
        }
        Write-Step "deployed $relativePath"
    }

    if ($DryRun) {
        Write-Step "dry run complete; $($changed.Count) file(s) would change"
        return
    }

    $manifest = [ordered]@{
        schema_version = 1
        version = $version
        commit = $commit
        source_root = $SourceDir
        install_root = $InstallDir
        deployed_at = $startedAt
        files = $sourceHashes
    }
    Write-AtomicJson $ReleaseManifestFile $manifest
    $manifestWritten = $true

    $runtime = $null
    if ($NoRestart) {
        Write-Step 'deployment completed without restart'
    } else {
        $previousPid = Restart-InstalledProxy
        $runtime = Wait-ProxyHealthy $commit $true $previousPid
        if (-not $runtime) { throw 'Updated proxy failed runtime path/version/health validation' }
        Write-Step "healthy version=$($runtime.runtime.version) commit=$($runtime.runtime.commit)"
    }

    Write-AtomicJson $DeploymentResultFile ([ordered]@{
        status = 'success'
        deployed_at = $startedAt
        version = $version
        commit = $commit
        source_root = $SourceDir
        backup_root = $backupRoot
        changed_files = @($changed.path)
    })
    Write-Step "success; changed=$($changed.Count); backup=$backupRoot"
} catch {
    $failure = $_.Exception.Message
    Write-Warning "deployment failed: $failure"
    if (-not $DryRun) {
        for ($index = $changed.Count - 1; $index -ge 0; $index--) {
            $item = $changed[$index]
            $target = Join-Path $InstallDir $item.path
            $backup = Join-Path $backupRoot $item.path
            if ($item.had_target -and (Test-Path -LiteralPath $backup)) {
                Write-AtomicBytes $target ([IO.File]::ReadAllBytes($backup))
            } elseif (-not $item.had_target -and (Test-Path -LiteralPath $target)) {
                Remove-Item -LiteralPath $target -Force
            }
        }
        if ($manifestWritten) {
            $manifestBackup = Join-Path $backupRoot '.release-manifest.json'
            if ($manifestBackupCreated -and (Test-Path -LiteralPath $manifestBackup)) {
                Write-AtomicBytes $ReleaseManifestFile ([IO.File]::ReadAllBytes($manifestBackup))
            } elseif (-not $manifestHadTarget -and (Test-Path -LiteralPath $ReleaseManifestFile)) {
                Remove-Item -LiteralPath $ReleaseManifestFile -Force
            }
        }
        if (-not $NoRestart) {
            try {
                $failedPid = Restart-InstalledProxy
                $restored = Wait-ProxyHealthy $null $false $failedPid
                if (-not $restored) { Write-Warning 'rollback files restored but proxy health could not be confirmed' }
            } catch {
                Write-Warning "rollback restart failed: $($_.Exception.Message)"
            }
        }
        Write-AtomicJson $DeploymentResultFile ([ordered]@{
            status = 'rolled_back'
            failed_at = (Get-Date).ToUniversalTime().ToString('o')
            error = $failure
            source_root = $SourceDir
            backup_root = $backupRoot
        })
    }
    throw
}
