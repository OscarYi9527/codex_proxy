[CmdletBinding(SupportsShouldProcess)]
param(
	[ValidateSet('gateway', 'worker', 'both')]
	[string]$Role = 'both',
	[ValidatePattern('^[A-Za-z0-9._-]+$')]
	[string]$GatewayHost = 'torvye-gateway-cn',
	[ValidatePattern('^[A-Za-z0-9._-]+$')]
	[string]$WorkerHost = 'torvye-provider-worker',
	[string]$RemoteRoot = '/home/ubuntu/torvye/codex_proxy',
	[switch]$AllowDirty
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$repositoryRoot = [IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))
$installer = Join-Path $repositoryRoot 'deploy\preproduction-split\scripts\install-release.sh'
if (-not (Test-Path -LiteralPath $installer -PathType Leaf)) {
	throw "Release installer is missing: $installer"
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

if (-not $AllowDirty) {
	$dirty = Invoke-Git @('status', '--porcelain', '--untracked-files=no')
	if ($dirty.Count -gt 0) {
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

$temporaryRoot = Join-Path ([IO.Path]::GetTempPath()) "torvye-release-$commit"
$archive = "$temporaryRoot.tar.gz"
$manifest = "$temporaryRoot.files"
$deploymentFailure = $null
try {
	Remove-Item -LiteralPath $archive, $manifest -Force -ErrorAction SilentlyContinue
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
		$remoteCreated = $false
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
				$remoteDestination
			if ($LASTEXITCODE -ne 0) {
				throw "Upload to $($target.host) failed."
			}
			& ssh.exe `
				-o BatchMode=yes `
				-o ConnectTimeout=20 `
				$target.host `
				bash `
				$remoteInstaller `
				$target.role `
				$remoteArchive `
				$remoteManifest `
				$commit
			if ($LASTEXITCODE -ne 0) {
				throw "$($target.role) deployment failed on $($target.host)."
			}
		} finally {
			if ($remoteCreated) {
				& ssh.exe -o BatchMode=yes -o ConnectTimeout=20 $target.host `
					"rm -f -- '$remoteArchive' '$remoteManifest' '$remoteInstaller'; rmdir -- '$remoteDirectory'"
				if ($LASTEXITCODE -ne 0 -and -not $deploymentFailure) {
					Write-Warning "Remote temporary-file cleanup failed on $($target.host)."
				}
			}
		}
	}
} catch {
	$deploymentFailure = $_.Exception
} finally {
	Remove-Item -LiteralPath $archive, $manifest -Force -ErrorAction SilentlyContinue
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
