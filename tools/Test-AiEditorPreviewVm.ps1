[CmdletBinding()]
param(
	[string]$VmxPath = 'D:\VMware\Virtual Machines\Ubuntu-24.04-LTS\Ubuntu-24.04-LTS.vmx',
	[string]$VmrunPath = 'D:\VMware\Workstation\vmrun.exe',
	[switch]$StartVm,
	[string]$SshUser,
	[string]$SshKeyPath,
	[string]$RemoteRepository = '~/codex_proxy',
	[string]$PublicOrigin
)

$ErrorActionPreference = 'Stop'

function Resolve-GuestIp {
	param([string]$Vmx, [string]$Vmrun)

	$toolsIp = & $Vmrun getGuestIPAddress $Vmx 2>$null
	if ($LASTEXITCODE -eq 0 -and $toolsIp -match '^\d{1,3}(?:\.\d{1,3}){3}$') {
		return $toolsIp.Trim()
	}

	$macLine = Select-String -LiteralPath $Vmx -Pattern '^ethernet0\.generatedAddress = "([^"]+)"$'
	if (-not $macLine) {
		throw 'VMware Tools is unavailable and the VM generated MAC address was not found.'
	}
	$mac = $macLine.Matches[0].Groups[1].Value.ToLowerInvariant()
	$leaseFile = 'C:\ProgramData\VMware\vmnetdhcp.leases'
	if (-not (Test-Path -LiteralPath $leaseFile)) {
		throw 'VMware Tools is unavailable and the VMware NAT lease file was not found.'
	}
	$leases = Get-Content -LiteralPath $leaseFile -Raw
	$matches = [regex]::Matches(
		$leases,
		"lease\s+(?<ip>\d{1,3}(?:\.\d{1,3}){3})\s*\{(?:(?!\n\}).)*?hardware ethernet\s+$([regex]::Escape($mac));",
		[System.Text.RegularExpressions.RegexOptions]::Singleline -bor
		[System.Text.RegularExpressions.RegexOptions]::IgnoreCase
	)
	if ($matches.Count -eq 0) {
		throw "No VMware NAT lease was found for $mac."
	}
	return $matches[$matches.Count - 1].Groups['ip'].Value
}

if (-not (Test-Path -LiteralPath $VmrunPath)) {
	throw "vmrun.exe was not found: $VmrunPath"
}
if (-not (Test-Path -LiteralPath $VmxPath)) {
	throw "VMX was not found: $VmxPath"
}

$running = @(& $VmrunPath list | Select-Object -Skip 1)
if ($running -notcontains $VmxPath) {
	if (-not $StartVm) {
		throw 'The Ubuntu preview VM is not running. Re-run with -StartVm.'
	}
	& $VmrunPath start $VmxPath nogui
	if ($LASTEXITCODE -ne 0) {
		throw 'VMware failed to start the Ubuntu preview VM.'
	}
	Start-Sleep -Seconds 5
}

$guestIp = Resolve-GuestIp -Vmx $VmxPath -Vmrun $VmrunPath
$ping = Test-Connection -ComputerName $guestIp -Count 2 -Quiet
$ssh = Test-NetConnection -ComputerName $guestIp -Port 22 -InformationLevel Quiet

$result = [ordered]@{
	status = if ($ping) { 'reachable' } else { 'unreachable' }
	vmx = $VmxPath
	guestIp = $guestIp
	ping = $ping
	ssh = $ssh
	guestVerification = 'not-requested'
	publicOrigin = $PublicOrigin
	publicLive = $null
}

if ($SshUser -or $SshKeyPath) {
	if (-not $SshUser -or -not $SshKeyPath) {
		throw 'Specify both -SshUser and -SshKeyPath.'
	}
	if (-not (Test-Path -LiteralPath $SshKeyPath)) {
		throw "SSH private key was not found: $SshKeyPath"
	}
	if (-not $ssh) {
		throw "SSH is not reachable at ${guestIp}:22."
	}
	$remoteCommand = "cd $RemoteRepository && ./deploy/preview/scripts/verify-preview.sh"
	$output = & ssh.exe `
		-o BatchMode=yes `
		-o StrictHostKeyChecking=accept-new `
		-i $SshKeyPath `
		"$SshUser@$guestIp" `
		$remoteCommand
	if ($LASTEXITCODE -ne 0) {
		throw 'Guest preview verification failed.'
	}
	$result.guestVerification = ($output -join "`n")
}

if ($PublicOrigin) {
	$url = [Uri]::new($PublicOrigin)
	if ($url.Scheme -ne 'https' -or $url.AbsolutePath -ne '/') {
		throw '-PublicOrigin must be an HTTPS origin without a path.'
	}
	$live = Invoke-RestMethod -Uri "$($url.AbsoluteUri.TrimEnd('/'))/live" -TimeoutSec 15
	$result.publicLive = $live.status
	if ($live.status -ne 'ok') {
		throw 'The public Gateway liveness response was invalid.'
	}
}

$result | ConvertTo-Json -Depth 5
