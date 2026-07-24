[CmdletBinding(SupportsShouldProcess)]
param(
	[ValidateSet('gateway', 'worker', 'both')]
	[string]$Role = 'both',
	[ValidatePattern('^[A-Za-z0-9._-]+$')]
	[string]$GatewayHost = 'torvye-gateway-cn',
	[ValidatePattern('^[A-Za-z0-9._-]+$')]
	[string]$WorkerHost = 'torvye-provider-worker',
	[string]$RemoteRoot = '/home/ubuntu/torvye/codex_proxy',
	[ValidateRange(5, 120)]
	[int]$DeploymentTimeoutMinutes = 45,
	[switch]$AllowDirty
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$repositoryRoot = [IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))
$installer = Join-Path $repositoryRoot 'deploy\preproduction-split\scripts\install-release.sh'
$runner = Join-Path $repositoryRoot 'deploy\preproduction-split\scripts\run-release.sh'
foreach ($releaseScript in @($installer, $runner)) {
	if (-not (Test-Path -LiteralPath $releaseScript -PathType Leaf)) {
		throw "Release script is missing: $releaseScript"
	}
}
if ($RemoteRoot -ne '/home/ubuntu/torvye/codex_proxy') {
	throw 'RemoteRoot must use the reviewed TORVYE deployment root.'
}

function Invoke-Git([string[]]$Arguments) {
	$output = & git.exe -C $repositoryRoot @Arguments 2>&1
	if ($LASTEXITCODE -ne 0) {
		throw "Git failed: $($output -join [Environment]::NewLine)"
	}
	return @($output)
}

function Remove-LocalReleaseFile([string]$Path) {
	$fullPath = [IO.Path]::GetFullPath($Path)
	$temporaryDirectory = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
	$temporaryDirectory = $temporaryDirectory.TrimEnd(
		[IO.Path]::DirectorySeparatorChar,
		[IO.Path]::AltDirectorySeparatorChar
	)
	if (
		-not $fullPath.StartsWith(
			$temporaryDirectory + [IO.Path]::DirectorySeparatorChar,
			[StringComparison]::OrdinalIgnoreCase
		) -or
		-not [IO.Path]::GetFileName($fullPath).StartsWith(
			'torvye-release-',
			[StringComparison]::Ordinal
		)
	) {
		throw "Refusing to remove an unexpected local release path: $fullPath"
	}
	if ([IO.File]::Exists($fullPath)) {
		[IO.File]::Delete($fullPath)
	}
}

function Invoke-NativeProcessWithTimeout(
	[string]$FilePath,
	[string[]]$Arguments,
	[int]$TimeoutSeconds
) {
	$probeId = [Guid]::NewGuid().ToString('N')
	$standardOutput = Join-Path (
		[IO.Path]::GetTempPath()
	) "torvye-release-native-$probeId.out"
	$standardError = Join-Path (
		[IO.Path]::GetTempPath()
	) "torvye-release-native-$probeId.err"
	$process = $null
	try {
		$process = Start-Process `
			-FilePath $FilePath `
			-ArgumentList $Arguments `
			-WindowStyle Hidden `
			-RedirectStandardOutput $standardOutput `
			-RedirectStandardError $standardError `
			-PassThru
		# Windows PowerShell can otherwise return a null ExitCode after the
		# timed WaitForExit overload, even though the child exited normally.
		$null = $process.Handle
		if (-not $process.WaitForExit($TimeoutSeconds * 1000)) {
			Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
			$process.WaitForExit(5000) | Out-Null
			return [pscustomobject]@{
				timedOut = $true
				exitCode = 124
				output = @()
				error = @()
			}
		}
		$process.WaitForExit()
		$process.Refresh()
		return [pscustomobject]@{
			timedOut = $false
			exitCode = $process.ExitCode
			output = if ([IO.File]::Exists($standardOutput)) {
				@([IO.File]::ReadAllLines($standardOutput))
			} else {
				@()
			}
			error = if ([IO.File]::Exists($standardError)) {
				@([IO.File]::ReadAllLines($standardError))
			} else {
				@()
			}
		}
	} finally {
		if ($process) {
			$process.Dispose()
		}
		Remove-LocalReleaseFile -Path $standardOutput
		Remove-LocalReleaseFile -Path $standardError
	}
}

function Invoke-DetachedReleaseStatus(
	[string]$HostName,
	[string]$RunnerPath,
	[int]$TimeoutSeconds = 40
) {
	return Invoke-NativeProcessWithTimeout `
		-FilePath 'ssh.exe' `
		-Arguments @(
			'-o', 'BatchMode=yes',
			'-o', 'ConnectTimeout=20',
			'-o', 'ServerAliveInterval=15',
			'-o', 'ServerAliveCountMax=2',
			$HostName,
			'bash',
			$RunnerPath,
			'--status'
		) `
		-TimeoutSeconds $TimeoutSeconds
}

function Invoke-SshWithRetry(
	[string]$HostName,
	[string[]]$RemoteArguments,
	[int]$Attempts = 5
) {
	$lastOutput = @()
	for ($attempt = 1; $attempt -le $Attempts; $attempt++) {
		$sshArguments = @(
			'-o', 'BatchMode=yes',
			'-o', 'ConnectTimeout=20',
			'-o', 'ServerAliveInterval=15',
			'-o', 'ServerAliveCountMax=2',
			$HostName
		) + $RemoteArguments
		$result = Invoke-NativeProcessWithTimeout `
			-FilePath 'ssh.exe' `
			-Arguments $sshArguments `
			-TimeoutSeconds 60
		$lastOutput = @($result.output) + @($result.error)
		if (-not $result.timedOut -and $result.exitCode -eq 0) {
			return [pscustomobject]@{
				output = @($result.output)
				attempt = $attempt
			}
		}
		if ($attempt -lt $Attempts) {
			Start-Sleep -Seconds ([Math]::Min($attempt * 2, 10))
		}
	}
	throw (
		"SSH command failed on $HostName after $Attempts attempts: " +
		"$($lastOutput -join [Environment]::NewLine)"
	)
}

function Invoke-ScpWithRetry(
	[string[]]$LocalPaths,
	[string]$Destination,
	[int]$Attempts = 5
) {
	$lastOutput = @()
	for ($attempt = 1; $attempt -le $Attempts; $attempt++) {
		$scpArguments = @(
			'-q',
			'-o', 'BatchMode=yes',
			'-o', 'ConnectTimeout=20',
			'-o', 'ServerAliveInterval=15',
			'-o', 'ServerAliveCountMax=2'
		) + $LocalPaths + @($Destination)
		$result = Invoke-NativeProcessWithTimeout `
			-FilePath 'scp.exe' `
			-Arguments $scpArguments `
			-TimeoutSeconds 120
		$lastOutput = @($result.output) + @($result.error)
		if (-not $result.timedOut -and $result.exitCode -eq 0) {
			return
		}
		if ($attempt -lt $Attempts) {
			Start-Sleep -Seconds ([Math]::Min($attempt * 2, 10))
		}
	}
	throw (
		"SCP upload failed after $Attempts attempts: " +
		"$($lastOutput -join [Environment]::NewLine)"
	)
}

if (-not $AllowDirty) {
	$dirty = Invoke-Git @('status', '--porcelain', '--untracked-files=no')
	if (@($dirty).Count -gt 0) {
		throw 'The Proxy repository has tracked changes. Commit and validate them before deployment.'
	}
}

$commit = (Invoke-Git @('rev-parse', 'HEAD') | Select-Object -First 1).Trim()
if ($commit -notmatch '^[0-9a-f]{40}$') {
	throw 'Unable to resolve a full release commit.'
}
& git.exe -C $repositoryRoot cat-file -e "${commit}:deploy/preproduction-split/scripts/install-release.sh"
if ($LASTEXITCODE -ne 0) {
	throw 'The release installer is not committed at HEAD.'
}
& git.exe -C $repositoryRoot cat-file -e "${commit}:deploy/preproduction-split/scripts/run-release.sh"
if ($LASTEXITCODE -ne 0) {
	throw 'The detached release runner is not committed at HEAD.'
}

$sharedBefore = Get-NetTCPConnection `
	-State Listen `
	-LocalAddress 127.0.0.1 `
	-LocalPort 47892 `
	-ErrorAction SilentlyContinue |
	Select-Object -First 1
if (-not $sharedBefore) {
	throw 'Shared Proxy 127.0.0.1:47892 is not listening; deployment will not attempt to repair it.'
}
$sharedLive = Invoke-RestMethod 'http://127.0.0.1:47892/live' -TimeoutSec 10
if ($sharedLive.status -ne 'ok') {
	throw 'Shared Proxy /live is not healthy; deployment will not attempt to repair it.'
}

$localDeploymentId = '{0}-{1}-{2}' -f `
	$commit, `
	$PID, `
	([Guid]::NewGuid().ToString('N').Substring(0, 12))
$temporaryRoot = Join-Path ([IO.Path]::GetTempPath()) "torvye-release-$localDeploymentId"
$archive = "$temporaryRoot.tar.gz"
$manifest = "$temporaryRoot.files"
$deploymentFailure = $null
try {
	Remove-LocalReleaseFile -Path $archive
	Remove-LocalReleaseFile -Path $manifest
	& git.exe -C $repositoryRoot archive --format=tar.gz --output=$archive $commit
	if ($LASTEXITCODE -ne 0) {
		throw 'Unable to create the release archive.'
	}
	$files = Invoke-Git @('ls-tree', '-r', '--name-only', $commit)
	$manifestText = if ($files.Count -gt 0) {
		($files -join "`n") + "`n"
	} else {
		''
	}
	[IO.File]::WriteAllText($manifest, $manifestText, [Text.UTF8Encoding]::new($false))

	$targets = if ($Role -eq 'both') {
		@(
			[ordered]@{ role = 'worker'; host = $WorkerHost },
			[ordered]@{ role = 'gateway'; host = $GatewayHost }
		)
	} elseif ($Role -eq 'worker') {
		@([ordered]@{ role = 'worker'; host = $WorkerHost })
	} else {
		@([ordered]@{ role = 'gateway'; host = $GatewayHost })
	}

	foreach ($target in $targets) {
		if (-not $PSCmdlet.ShouldProcess(
			"$($target.host):$RemoteRoot",
			"deploy $($target.role) commit $commit"
		)) {
			continue
		}
		$deploymentId = '{0}-{1}-{2}' -f `
			$commit.Substring(0, 12), `
			$target.role, `
			([Guid]::NewGuid().ToString('N').Substring(0, 12))
		$remoteDirectory = "/tmp/torvye-release-$deploymentId"
		$remoteArchive = "$remoteDirectory/$([IO.Path]::GetFileName($archive))"
		$remoteManifest = "$remoteDirectory/$([IO.Path]::GetFileName($manifest))"
		$remoteInstaller = "$remoteDirectory/$([IO.Path]::GetFileName($installer))"
		$remoteRunner = "$remoteDirectory/$([IO.Path]::GetFileName($runner))"
		$remoteInstallLog = "$remoteDirectory/install.log"
		$remoteLauncherLog = "$remoteDirectory/launcher.log"
		$remoteExitCode = "$remoteDirectory/exit-code"
		$remoteExitTemp = "$remoteDirectory/exit-code.tmp"
		$remotePid = "$remoteDirectory/launcher.pid"
		$remotePidTemp = "$remoteDirectory/launcher.pid.tmp"
		$remoteLaunchLock = "$remoteDirectory/launch.lock"
		$remoteCreated = $false
		$remoteStarted = $false
		$remoteCompleted = $false
		try {
			$remoteCreated = $true
			$createCommand = "umask 077; mkdir -p -- '$remoteDirectory'; " +
				"chmod 700 '$remoteDirectory'"
			Invoke-SshWithRetry `
				-HostName $target.host `
				-RemoteArguments @($createCommand) | Out-Null
			$remoteDestination = '{0}:{1}/' -f $target.host, $remoteDirectory
			Invoke-ScpWithRetry `
				-LocalPaths @($archive, $manifest, $installer, $runner) `
				-Destination $remoteDestination
			$remoteStarted = $true
			Invoke-SshWithRetry `
				-HostName $target.host `
				-RemoteArguments @(
					'bash',
					$remoteRunner,
					'--launch',
					$remoteInstaller,
					$target.role,
					$remoteArchive,
					$remoteManifest,
					$commit
				) | Out-Null

			$deadline = [DateTimeOffset]::UtcNow.AddMinutes($DeploymentTimeoutMinutes)
			$exitCode = $null
			$lastStatus = $null
			do {
				$statusResult = Invoke-DetachedReleaseStatus `
					-HostName $target.host `
					-RunnerPath $remoteRunner
				if (-not $statusResult.timedOut -and $statusResult.exitCode -eq 0) {
					$statusLines = @($statusResult.output)
					$lastStatus = if ($statusLines.Count -gt 0) {
						([string]$statusLines[-1]).Trim()
					} else {
						$null
					}
					if ($lastStatus -match '^DONE:(\d+)$') {
						$exitCode = [int]$Matches[1]
						$remoteCompleted = $true
						break
					}
					if ($lastStatus -eq 'LOST') {
						throw (
							"$($target.role) detached deployment lost its runner " +
							"on $($target.host); preserved $remoteDirectory for diagnosis."
						)
					}
				}
				Start-Sleep -Seconds 5
			} while ([DateTimeOffset]::UtcNow -lt $deadline)

			if ($null -eq $exitCode) {
				throw (
					"$($target.role) deployment exceeded $DeploymentTimeoutMinutes minutes " +
					"on $($target.host); preserved $remoteDirectory for recovery."
				)
			}

			try {
				$tailResult = Invoke-SshWithRetry `
					-HostName $target.host `
					-RemoteArguments @('tail', '-n', '120', $remoteInstallLog)
				$tailResult.output | ForEach-Object { Write-Host $_ }
			} catch {
				Write-Warning "Unable to retrieve the final release log from $($target.host)."
			}
			if ($exitCode -ne 0) {
				throw "$($target.role) deployment failed on $($target.host) with exit code $exitCode."
			}
		} finally {
			if ($remoteCreated -and (-not $remoteStarted -or $remoteCompleted)) {
				$cleanupCommand = "rm -f -- '$remoteArchive' '$remoteManifest' " +
					"'$remoteInstaller' '$remoteRunner' '$remoteInstallLog' " +
					"'$remoteLauncherLog' '$remoteExitCode' '$remoteExitTemp' " +
					"'$remotePid' '$remotePidTemp' '$remoteLaunchLock'; " +
					"rmdir -- '$remoteDirectory' 2>/dev/null || " +
					"test ! -d '$remoteDirectory'"
				try {
					Invoke-SshWithRetry `
						-HostName $target.host `
						-RemoteArguments @($cleanupCommand) | Out-Null
				} catch {
					Write-Warning "Remote temporary-file cleanup failed on $($target.host)."
				}
			} elseif ($remoteCreated) {
				Write-Warning (
					"Preserved incomplete remote release directory for recovery: " +
					"$($target.host):$remoteDirectory"
				)
			}
		}
	}
} catch {
	$deploymentFailure = $_.Exception
} finally {
	Remove-LocalReleaseFile -Path $archive
	Remove-LocalReleaseFile -Path $manifest
}

$sharedAfter = Get-NetTCPConnection `
	-State Listen `
	-LocalAddress 127.0.0.1 `
	-LocalPort 47892 `
	-ErrorAction SilentlyContinue |
	Select-Object -First 1
if (-not $sharedAfter -or $sharedAfter.OwningProcess -ne $sharedBefore.OwningProcess) {
	throw 'Shared Proxy PID changed during central deployment.'
}
$sharedLiveAfter = Invoke-RestMethod 'http://127.0.0.1:47892/live' -TimeoutSec 10
if ($sharedLiveAfter.status -ne 'ok') {
	throw 'Shared Proxy /live changed during central deployment.'
}
if ($deploymentFailure) {
	throw $deploymentFailure
}

[ordered]@{
	status = 'PASS'
	commit = $commit
	role = $Role
	sharedProxyPid = $sharedAfter.OwningProcess
} | ConvertTo-Json
