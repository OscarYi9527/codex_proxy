Set-StrictMode -Version 2.0

$script:RkCredentialEntropy = [Text.Encoding]::UTF8.GetBytes(
    'codex-proxy-rk3588-windows-client-v1'
)
$script:RkCredentialFileName = 'credential.dpapi.json'
$script:RkSettingsFileName = 'client.json'
$script:RkProviderId = 'rk3588_jp'

function Assert-RkWindows {
    $isWindowsVariable = Get-Variable IsWindows -ErrorAction SilentlyContinue
    $isWindows = if ($isWindowsVariable) {
        [bool]$isWindowsVariable.Value
    } else {
        $env:OS -eq 'Windows_NT'
    }
    if (-not $isWindows) {
        throw 'The RK3588 client scripts require Windows.'
    }
}

function Get-RkDefaultRoot {
    $localAppData = [Environment]::GetFolderPath(
        [Environment+SpecialFolder]::LocalApplicationData
    )
    if ([string]::IsNullOrWhiteSpace($localAppData)) {
        throw 'LOCALAPPDATA is unavailable for the current Windows user.'
    }
    return Join-Path $localAppData 'CodexProxy\RK3588'
}

function ConvertTo-RkFullPath {
    param([Parameter(Mandatory = $true)][string]$Path)

    if ([string]::IsNullOrWhiteSpace($Path)) {
        throw 'A required path was empty.'
    }
    return [IO.Path]::GetFullPath($Path)
}

function Get-RkSha256 {
    param([Parameter(Mandatory = $true)][string]$Path)

    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        return $null
    }
    $stream = [IO.File]::OpenRead($Path)
    $sha = [Security.Cryptography.SHA256]::Create()
    try {
        return ([BitConverter]::ToString($sha.ComputeHash($stream))).
            Replace('-', '').
            ToLowerInvariant()
    } finally {
        $sha.Dispose()
        $stream.Dispose()
    }
}

function Protect-RkPathAcl {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][ValidateSet('File', 'Directory')]
        [string]$Kind
    )

    Assert-RkWindows
    $currentSid = [Security.Principal.WindowsIdentity]::GetCurrent().User
    if ($null -eq $currentSid) {
        throw 'The current Windows user SID is unavailable.'
    }
    $systemSid = [Security.Principal.SecurityIdentifier]::new(
        [Security.Principal.WellKnownSidType]::LocalSystemSid,
        $null
    )
    $administratorsSid = [Security.Principal.SecurityIdentifier]::new(
        [Security.Principal.WellKnownSidType]::BuiltinAdministratorsSid,
        $null
    )

    $item = Get-Item -LiteralPath $Path -Force
    $acl = $item.GetAccessControl(
        [Security.AccessControl.AccessControlSections]::Access
    )
    $acl.SetAccessRuleProtection($true, $false)
    foreach ($existingRule in @($acl.Access)) {
        [void]$acl.RemoveAccessRuleAll($existingRule)
    }

    if ($Kind -eq 'Directory') {
        $inheritance = [Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit'
        $propagation = [Security.AccessControl.PropagationFlags]::None
        foreach ($sid in @($currentSid, $systemSid, $administratorsSid)) {
            $rule = [Security.AccessControl.FileSystemAccessRule]::new(
                $sid,
                [Security.AccessControl.FileSystemRights]::FullControl,
                $inheritance,
                $propagation,
                [Security.AccessControl.AccessControlType]::Allow
            )
            [void]$acl.AddAccessRule($rule)
        }
    } else {
        foreach ($sid in @($currentSid, $systemSid, $administratorsSid)) {
            $rule = [Security.AccessControl.FileSystemAccessRule]::new(
                $sid,
                [Security.AccessControl.FileSystemRights]::FullControl,
                [Security.AccessControl.AccessControlType]::Allow
            )
            [void]$acl.AddAccessRule($rule)
        }
    }
    $item.SetAccessControl($acl)
}

function Ensure-RkPrivateDirectory {
    param([Parameter(Mandatory = $true)][string]$Path)

    $fullPath = ConvertTo-RkFullPath $Path
    if (-not (Test-Path -LiteralPath $fullPath)) {
        New-Item -ItemType Directory -Path $fullPath -Force | Out-Null
    }
    if (-not (Test-Path -LiteralPath $fullPath -PathType Container)) {
        throw "Expected a directory: $fullPath"
    }
    Protect-RkPathAcl -Path $fullPath -Kind Directory
    return $fullPath
}

function Write-RkUtf8Atomic {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][AllowEmptyString()][string]$Text,
        [switch]$Private
    )

    $fullPath = ConvertTo-RkFullPath $Path
    $parent = Split-Path -Parent $fullPath
    if (-not (Test-Path -LiteralPath $parent -PathType Container)) {
        New-Item -ItemType Directory -Path $parent -Force | Out-Null
    }
    $existingAcl = $null
    if (Test-Path -LiteralPath $fullPath -PathType Leaf) {
        $existingAcl = (Get-Item -LiteralPath $fullPath -Force).GetAccessControl(
            [Security.AccessControl.AccessControlSections]::Access
        )
    }
    $temp = Join-Path $parent ('.{0}.{1}.{2}.tmp' -f
        [IO.Path]::GetFileName($fullPath), $PID, [Guid]::NewGuid().ToString('N'))
    try {
        [IO.File]::WriteAllText($temp, $Text, [Text.UTF8Encoding]::new($false))
        if ($Private) {
            Protect-RkPathAcl -Path $temp -Kind File
        } elseif ($existingAcl) {
            (Get-Item -LiteralPath $temp -Force).SetAccessControl($existingAcl)
        }
        Move-Item -LiteralPath $temp -Destination $fullPath -Force
        if ($Private) {
            Protect-RkPathAcl -Path $fullPath -Kind File
        }
    } finally {
        if (Test-Path -LiteralPath $temp) {
            Remove-Item -LiteralPath $temp -Force
        }
    }
}

function Build-RkCredentialHelper {
    param(
        [Parameter(Mandatory = $true)][string]$SourcePath,
        [Parameter(Mandatory = $true)][string]$OutputPath
    )

    Assert-RkWindows
    $source = ConvertTo-RkFullPath $SourcePath
    $output = ConvertTo-RkFullPath $OutputPath
    if (-not (Test-Path -LiteralPath $source -PathType Leaf)) {
        throw "Credential helper source is missing: $source"
    }
    $parent = Split-Path -Parent $output
    if (-not (Test-Path -LiteralPath $parent -PathType Container)) {
        New-Item -ItemType Directory -Path $parent -Force | Out-Null
    }
    $temp = Join-Path $parent (
        '.rk3588-credential-helper.{0}.{1}.exe' -f
        $PID,
        [Guid]::NewGuid().ToString('N')
    )
    $provider = [Microsoft.CSharp.CSharpCodeProvider]::new()
    $parameters = [CodeDom.Compiler.CompilerParameters]::new()
    $parameters.GenerateExecutable = $true
    $parameters.GenerateInMemory = $false
    $parameters.IncludeDebugInformation = $false
    $parameters.TreatWarningsAsErrors = $true
    $parameters.WarningLevel = 4
    $parameters.CompilerOptions = '/optimize+ /platform:anycpu /nologo'
    $parameters.OutputAssembly = $temp
    foreach ($assembly in @(
        'System.dll',
        'System.Core.dll',
        'System.Runtime.Serialization.dll',
        'System.Security.dll',
        'System.Xml.dll'
    )) {
        [void]$parameters.ReferencedAssemblies.Add($assembly)
    }

    try {
        $result = $provider.CompileAssemblyFromFile($parameters, $source)
        if ($result.Errors.Count -gt 0 -or -not (Test-Path -LiteralPath $temp -PathType Leaf)) {
            $errorCodes = @($result.Errors | ForEach-Object {
                if ($_.ErrorNumber) { $_.ErrorNumber } else { 'compiler-error' }
            }) -join ', '
            throw "Credential helper compilation failed: $errorCodes"
        }
        Protect-RkPathAcl -Path $temp -Kind File
        Move-Item -LiteralPath $temp -Destination $output -Force
        Protect-RkPathAcl -Path $output -Kind File
    } finally {
        $provider.Dispose()
        if (Test-Path -LiteralPath $temp) {
            Remove-Item -LiteralPath $temp -Force
        }
    }
    return $output
}

function ConvertFrom-RkSecureString {
    param([Parameter(Mandatory = $true)][Security.SecureString]$SecureValue)

    $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($SecureValue)
    try {
        return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)
    } finally {
        [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer)
    }
}

function ConvertTo-RkSecureString {
    param([Parameter(Mandatory = $true)][AllowEmptyString()][string]$Value)

    $secureValue = [Security.SecureString]::new()
    foreach ($character in $Value.ToCharArray()) {
        $secureValue.AppendChar($character)
    }
    $secureValue.MakeReadOnly()
    return $secureValue
}

function Assert-RkCredentialText {
    param([Parameter(Mandatory = $true)][string]$Value)

    $byteCount = [Text.Encoding]::UTF8.GetByteCount($Value)
    $hasNonPrintableAscii = $false
    foreach ($character in $Value.ToCharArray()) {
        $codePoint = [int][char]$character
        if ($codePoint -lt 0x21 -or $codePoint -gt 0x7e) {
            $hasNonPrintableAscii = $true
            break
        }
    }
    if (
        $byteCount -lt 32 -or
        $byteCount -gt 4096 -or
        $Value -ne $Value.Trim() -or
        $hasNonPrintableAscii
    ) {
        throw 'The RK3588 client key must be one 32-4096 byte printable ASCII value.'
    }
}

function Set-RkProtectedCredential {
    param(
        [Parameter(Mandatory = $true)][string]$StateDir,
        [Parameter(Mandatory = $true)][Security.SecureString]$SecureValue
    )

    Assert-RkWindows
    Add-Type -AssemblyName System.Security
    $privateStateDir = Ensure-RkPrivateDirectory $StateDir
    $plainText = $null
    $plainBytes = $null
    $protectedBytes = $null
    try {
        $plainText = ConvertFrom-RkSecureString $SecureValue
        Assert-RkCredentialText $plainText
        $plainBytes = [Text.Encoding]::UTF8.GetBytes($plainText)
        $protectedBytes = [Security.Cryptography.ProtectedData]::Protect(
            $plainBytes,
            $script:RkCredentialEntropy,
            [Security.Cryptography.DataProtectionScope]::CurrentUser
        )
        $envelope = [ordered]@{
            schema_version = 1
            protection = 'Windows DPAPI CurrentUser'
            created_at = [DateTimeOffset]::UtcNow.ToString('o')
            ciphertext = [Convert]::ToBase64String($protectedBytes)
        }
        $credentialFile = Join-Path $privateStateDir $script:RkCredentialFileName
        Write-RkUtf8Atomic -Path $credentialFile `
            -Text ($envelope | ConvertTo-Json -Depth 4) -Private
        return $credentialFile
    } finally {
        $plainText = $null
        if ($plainBytes) {
            [Array]::Clear($plainBytes, 0, $plainBytes.Length)
        }
        if ($protectedBytes) {
            [Array]::Clear($protectedBytes, 0, $protectedBytes.Length)
        }
    }
}

function ConvertTo-RkTomlString {
    param([Parameter(Mandatory = $true)][AllowEmptyString()][string]$Value)

    $escaped = $Value.Replace('\', '\\').
        Replace('"', '\"').
        Replace("`b", '\b').
        Replace("`t", '\t').
        Replace("`n", '\n').
        Replace("`f", '\f').
        Replace("`r", '\r')
    return '"' + $escaped + '"'
}

function Remove-RkTomlProvider {
    param(
        [AllowEmptyString()][string]$Text,
        [string]$ProviderId = $script:RkProviderId
    )

    $lines = [regex]::Split([string]$Text, '\r?\n')
    $kept = [Collections.Generic.List[string]]::new()
    $skip = $false
    $tablePrefix = "model_providers.$ProviderId"
    foreach ($line in $lines) {
        $match = [regex]::Match($line, '^\s*\[([^\]]+)\]\s*(?:#.*)?$')
        if ($match.Success) {
            $table = $match.Groups[1].Value.Trim()
            $skip = $table -eq $tablePrefix -or
                $table.StartsWith("$tablePrefix.", [StringComparison]::Ordinal)
        }
        if (-not $skip) {
            [void]$kept.Add($line)
        }
    }
    return (($kept -join "`r`n").TrimEnd() + "`r`n")
}

function Get-RkTopLevelLine {
    param(
        [AllowEmptyString()][string]$Text,
        [Parameter(Mandatory = $true)][string]$Key
    )

    foreach ($line in [regex]::Split([string]$Text, '\r?\n')) {
        if ($line -match '^\s*\[') {
            break
        }
        if ($line -match ('^\s*' + [regex]::Escape($Key) + '\s*=')) {
            return $line
        }
    }
    return $null
}

function Set-RkTopLevelLine {
    param(
        [AllowEmptyString()][string]$Text,
        [Parameter(Mandatory = $true)][string]$Key,
        [AllowNull()][string]$Line
    )

    if ([string]::IsNullOrWhiteSpace($Text)) {
        if ($null -eq $Line) {
            return ''
        }
        return $Line + "`r`n"
    }
    $lines = [Collections.Generic.List[string]]::new()
    foreach ($item in [regex]::Split([string]$Text, '\r?\n')) {
        [void]$lines.Add($item)
    }
    $tableIndex = $lines.Count
    $existingIndex = -1
    for ($index = 0; $index -lt $lines.Count; $index += 1) {
        if ($lines[$index] -match '^\s*\[') {
            $tableIndex = $index
            break
        }
        if ($lines[$index] -match ('^\s*' + [regex]::Escape($Key) + '\s*=')) {
            $existingIndex = $index
            break
        }
    }
    if ($existingIndex -ge 0) {
        if ($null -eq $Line) {
            $lines.RemoveAt($existingIndex)
        } else {
            $lines[$existingIndex] = $Line
        }
    } elseif ($null -ne $Line) {
        $lines.Insert($tableIndex, $Line)
    }
    return (($lines -join "`r`n").TrimEnd() + "`r`n")
}

function Get-RkValidatedBaseUrl {
    param([Parameter(Mandatory = $true)][string]$BaseUrl)

    $candidate = $BaseUrl.TrimEnd('/')
    try {
        $uri = [Uri]$candidate
    } catch {
        throw 'BaseUrl must be an absolute HTTPS URL ending in /v1.'
    }
    if (
        -not $uri.IsAbsoluteUri -or
        $uri.Scheme -ne 'https' -or
        -not [string]::IsNullOrEmpty($uri.UserInfo) -or
        -not [string]::IsNullOrEmpty($uri.Query) -or
        -not [string]::IsNullOrEmpty($uri.Fragment) -or
        $uri.AbsolutePath -ne '/v1'
    ) {
        throw 'BaseUrl must be an absolute HTTPS URL ending in /v1, without credentials, query, or fragment.'
    }
    if (-not $uri.DnsSafeHost) {
        throw 'BaseUrl must contain a DNS host.'
    }
    return $uri.AbsoluteUri.TrimEnd('/')
}

function Get-RkSettings {
    param([Parameter(Mandatory = $true)][string]$StateDir)

    $settingsFile = Join-Path (ConvertTo-RkFullPath $StateDir) $script:RkSettingsFileName
    $file = Get-Item -LiteralPath $settingsFile -ErrorAction Stop
    if ($file.Length -le 0 -or $file.Length -gt 262144) {
        throw 'The RK3588 client settings file has an invalid size.'
    }
    $settings = Get-Content -LiteralPath $settingsFile -Raw -Encoding UTF8 |
        ConvertFrom-Json
    if (
        $settings.schema_version -ne 1 -or
        $settings.provider_id -ne $script:RkProviderId
    ) {
        throw 'The RK3588 client settings file is invalid.'
    }
    return $settings
}

function Get-RkTailscaleExecutable {
    $command = Get-Command tailscale.exe -ErrorAction SilentlyContinue
    if ($command -and $command.Source) {
        return [IO.Path]::GetFullPath($command.Source)
    }
    $programFiles = [Environment]::GetFolderPath(
        [Environment+SpecialFolder]::ProgramFiles
    )
    if ($programFiles) {
        $candidate = Join-Path $programFiles 'Tailscale\tailscale.exe'
        if (Test-Path -LiteralPath $candidate -PathType Leaf) {
            return [IO.Path]::GetFullPath($candidate)
        }
    }
    throw 'Tailscale CLI was not found. Install Tailscale and sign in first.'
}

function Invoke-RkCodexConfigCheck {
    param(
        [Parameter(Mandatory = $true)][string]$CodexHome,
        [string]$CodexCommand
    )

    if ([string]::IsNullOrWhiteSpace($CodexCommand)) {
        $command = Get-Command codex.exe, codex.cmd, codex `
            -ErrorAction SilentlyContinue |
            Select-Object -First 1
        if (-not $command -or -not $command.Source) {
            throw 'Codex CLI was not found. Install a current Codex CLI and rerun the installer.'
        }
        $CodexCommand = $command.Source
    }
    $CodexCommand = ConvertTo-RkFullPath $CodexCommand
    if (-not (Test-Path -LiteralPath $CodexCommand -PathType Leaf)) {
        throw "Codex command was not found: $CodexCommand"
    }

    $previousCodexHome = [Environment]::GetEnvironmentVariable(
        'CODEX_HOME',
        [EnvironmentVariableTarget]::Process
    )
    try {
        [Environment]::SetEnvironmentVariable(
            'CODEX_HOME',
            (ConvertTo-RkFullPath $CodexHome),
            [EnvironmentVariableTarget]::Process
        )
        $previousErrorActionPreference = $ErrorActionPreference
        try {
            $ErrorActionPreference = 'Continue'
            $output = @(& $CodexCommand features list 2>&1)
            $exitCode = $LASTEXITCODE
        } finally {
            $ErrorActionPreference = $previousErrorActionPreference
        }
        if ($exitCode -ne 0) {
            throw 'Codex rejected the generated config.'
        }
    } finally {
        [Environment]::SetEnvironmentVariable(
            'CODEX_HOME',
            $previousCodexHome,
            [EnvironmentVariableTarget]::Process
        )
        $output = $null
    }
    return [pscustomobject]@{
        executable = $CodexCommand
        config_parsed = $true
    }
}

function Invoke-RkTailscaleCheck {
    param([Parameter(Mandatory = $true)][string]$HostName)

    $tailscale = Get-RkTailscaleExecutable
    $previousErrorActionPreference = $ErrorActionPreference
    try {
        $ErrorActionPreference = 'Continue'
        $statusOutput = @(& $tailscale status --json 2>&1)
        $statusExitCode = $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $previousErrorActionPreference
    }
    if ($statusExitCode -ne 0) {
        throw 'Tailscale status failed. Confirm that the Windows service is running and signed in.'
    }
    $statusText = ($statusOutput -join "`n")
    $jsonStart = $statusText.IndexOf('{')
    if ($jsonStart -lt 0) {
        throw 'Tailscale status did not return JSON.'
    }
    try {
        $status = $statusText.Substring($jsonStart) | ConvertFrom-Json
    } catch {
        throw 'Tailscale status JSON could not be parsed.'
    }
    if ([string]$status.BackendState -ne 'Running') {
        throw "Tailscale is not connected (state: $([string]$status.BackendState))."
    }

    try {
        $ErrorActionPreference = 'Continue'
        $pingOutput = @(
            & $tailscale ping --timeout=5s --c=1 --until-direct=false $HostName 2>&1
        )
        $pingExitCode = $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $previousErrorActionPreference
    }
    if ($pingExitCode -ne 0) {
        throw "Tailscale cannot reach the RK3588 peer: $HostName"
    }
    return [pscustomobject]@{
        executable = $tailscale
        backend_state = [string]$status.BackendState
        peer_reachable = $true
    }
}
