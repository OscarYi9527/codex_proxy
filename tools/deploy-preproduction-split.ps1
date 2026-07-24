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

function Invoke-DetachedReleaseStatus(
	[string]$HostName,
	[string]$RunnerPath,
	[int]$TimeoutSeconds = 40
) {
	$probeId = [Guid]::NewGuid().ToString('N')
	$standardOutput = Join-Path (
		[IO.Path]::GetTempPath()
	) "torvye-release-ssh-$probeId.out"
	$standardError = Join-Path (
		[IO.Path]::GetTempPath()
	) "torvye-release-ssh-$probeId.err"
	$process = $null
	try {
		$process = Start-Process `
			-FilePath 'ssh.exe' `
			-ArgumentList @(
				'-o', 'BatchMode=yes',
				'-o', 'ConnectTimeout=20',
				'-o', 'ServerAliveInterval=15',
				'-o', 'ServerAliveCountMax=2',
				$HostName,
				'bash',
				$RunnerPath,
				'--status'
			) `
			-WindowStyle Hidden `
			-RedirectStandardOutput $standardOutput `
			-RedirectStandardError $standardError `
			-PassThru
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
		$remoteCreated = $false
		$remoteStarted = $false
		$remoteCompleted = $false
		try {
			& ssh.exe `
				-o BatchMode=yes `
				-o ConnectTimeout=20 `
				$target.host `
				"umask 077; mkdir -m 700 -- '$remoteDirectory'"
			if ($LASTEXITCODE -ne 0) {
				throw "Unable to create the remote staging directory on $($target.host)."
			}
			$remoteCreated = $true
			$remoteDestination = '{0}:{1}/' -f $target.host, $remoteDirectory
			& scp.exe -q `
				$archive `
				$manifest `
				$installer `
				$runner `
				$remoteDestination
			if ($LASTEXITCODE -ne 0) {
				throw "Upload to $($target.host) failed."
			}
			$launchCommand = "cd '$remoteDirectory'; " +
				"nohup bash '$remoteRunner' '$remoteInstaller' '$($target.role)' " +
				"'$remoteArchive' '$remoteManifest' '$commit' " +
				">'$remoteLauncherLog' 2>&1 < /dev/null & " +
				"printf '%s\n' " + '$!' + " >'$remotePid'"
			$remoteStarted = $true
			& ssh.exe `
				-o BatchMode=yes `
				-o ConnectTimeout=20 `
				$target.host `
				$launchCommand
			if ($LASTEXITCODE -ne 0) {
				Write-Warning (
					"Launch connection to $($target.host) closed unexpectedly; " +
					'the detached release status will still be polled.'
				)
			}

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

			$releaseTail = & ssh.exe `
				-o BatchMode=yes `
				-o ConnectTimeout=20 `
				$target.host `
				tail `
				-n 120 `
				$remoteInstallLog 2>&1
			if ($LASTEXITCODE -eq 0) {
				$releaseTail | ForEach-Object { Write-Host $_ }
			} else {
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
					"'$remotePid'; rmdir -- '$remoteDirectory'"
				& ssh.exe -o BatchMode=yes -o ConnectTimeout=20 $target.host `
					$cleanupCommand
				if ($LASTEXITCODE -ne 0 -and -not $deploymentFailure) {
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
