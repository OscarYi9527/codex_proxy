$ErrorActionPreference = 'Stop'

$proxyDir = $PSScriptRoot
$proxyHealthUrl = 'http://127.0.0.1:47892'
$proxyBaseUrl = 'http://localhost:47892'
$catalog = Join-Path $proxyDir 'codex-models.json'
$baseCodexHome = Join-Path $HOME '.codex'
$modeHomeRoot = Join-Path $HOME '.codex-modes'
$failureThreshold = 3

function Test-Proxy {
    try {
        $health = Invoke-RestMethod "$proxyHealthUrl/health" -TimeoutSec 1
        return $health.status -eq 'ok'
    } catch {
        return $false
    }
}

function Find-CodexExe {
    $root = $env:CODEX_MANAGED_PACKAGE_ROOT
    if ($root) {
        $candidate = Join-Path $root 'node_modules\@openai\codex-win32-x64\vendor\x86_64-pc-windows-msvc\bin\codex.exe'
        if (Test-Path $candidate) { return $candidate }
    }
    $command = Get-Command codex.exe -ErrorAction SilentlyContinue
    if ($command) { return $command.Source }
    $cmdShim = Get-Command codex.cmd -ErrorAction SilentlyContinue
    if ($cmdShim) {
        $packageRoot = Join-Path (Split-Path $cmdShim.Source) 'node_modules\@openai\codex'
        $candidate = Join-Path $packageRoot 'node_modules\@openai\codex-win32-x64\vendor\x86_64-pc-windows-msvc\bin\codex.exe'
        if (Test-Path $candidate) { return $candidate }
    }
    throw 'codex.exe was not found.'
}

function Normalize-Route([string]$Route) {
    if (-not $Route) { return 'deepseek' }
    switch ($Route.ToLowerInvariant()) {
        'auto' { 'deepseek' }
        'deepseek' { 'deepseek' }
        'proxy' { 'deepseek' }
        'gpt' { 'gpt-subscription' }
        'subscription' { 'gpt-subscription' }
        'chatgpt' { 'gpt-subscription' }
        'gpt-subscription' { 'gpt-subscription' }
        'api' { 'gpt-api' }
        'gpt-api' { 'gpt-api' }
        default { throw "Unsupported route '$Route'. Use deepseek, gpt-subscription, or gpt-api." }
    }
}

function Remove-ConfigBlock([string]$Text, [string]$BlockName) {
    $pattern = "(?ms)\r?\n\[$([regex]::Escape($BlockName))\].*?(?=\r?\n\[|\z)"
    return [regex]::Replace($Text, $pattern, "`r`n")
}

function Ensure-TopLevelValue([string]$Text, [string]$Key, [string]$TomlValue) {
    $pattern = '(?m)^' + [regex]::Escape($Key) + '\s*=.*(?:\r?\n)?'
    $line = "$Key = $TomlValue`r`n"
    if ([regex]::IsMatch($Text, $pattern)) {
        return [regex]::Replace($Text, $pattern, $line, 1)
    }
    return $line + $Text
}

function Remove-TopLevelValue([string]$Text, [string]$Key) {
    $pattern = '(?m)^' + [regex]::Escape($Key) + '\s*=.*(?:\r?\n)?'
    return [regex]::Replace($Text, $pattern, '', 1)
}

function Ensure-Directory([string]$Path) {
    if (-not (Test-Path -LiteralPath $Path)) {
        New-Item -ItemType Directory -Path $Path -Force | Out-Null
    }
}

function Get-RouteHome([string]$Route) {
    switch ($Route) {
        'deepseek' { return $baseCodexHome }
        'gpt-subscription' { return $baseCodexHome }
        'gpt-api' { return (Join-Path $modeHomeRoot 'gpt-api') }
        default { throw "Unknown route '$Route'." }
    }
}

function Build-OpenAIConfig([string]$LoginMethod) {
    $sourceFile = Join-Path $baseCodexHome 'config.toml'
    $text = if (Test-Path -LiteralPath $sourceFile) {
        [IO.File]::ReadAllText($sourceFile)
    } else {
        @"
model = "gpt-5.5"
model_provider = "openai"
model_reasoning_effort = "high"

[projects.'c:\users\oscar']
trust_level = "trusted"

[windows]
sandbox = "elevated"
"@
    }

    $text = Remove-ConfigBlock $text 'model_providers.local_multi_proxy'
    $text = Remove-TopLevelValue $text 'model_catalog_json'
    $text = Ensure-TopLevelValue $text 'model' '"gpt-5.5"'
    $text = Ensure-TopLevelValue $text 'model_provider' '"openai"'
    $text = Ensure-TopLevelValue $text 'forced_login_method' ("`"$LoginMethod`"")
    return $text.TrimEnd() + "`r`n"
}

function Ensure-RouteHome([string]$Route) {
    $routeHome = Get-RouteHome $Route
    Ensure-Directory $routeHome

    if ($Route -in @('deepseek', 'gpt-subscription')) {
        return $routeHome
    }

    $configFile = Join-Path $routeHome 'config.toml'
    $loginMethod = if ($Route -eq 'gpt-api') { 'api' } else { 'chatgpt' }
    [IO.File]::WriteAllText($configFile, (Build-OpenAIConfig $loginMethod), [Text.UTF8Encoding]::new($false))
    return $routeHome
}

function Remove-ForwardedRouteArgs([string[]]$ArgsList, [ref]$SelectedRoute, [ref]$AutoFailover) {
    $remaining = New-Object System.Collections.Generic.List[string]
    for ($i = 0; $i -lt $ArgsList.Count; $i++) {
        $arg = $ArgsList[$i]
        if ([string]::IsNullOrWhiteSpace($arg)) {
            continue
        }
        if ($arg -eq '--route' -and $i + 1 -lt $ArgsList.Count) {
            $SelectedRoute.Value = Normalize-Route $ArgsList[$i + 1]
            $i++
            continue
        }
        if ($arg -like '--route=*') {
            $SelectedRoute.Value = Normalize-Route ($arg.Split('=', 2)[1])
            continue
        }
        if ($i -eq 0 -and $arg -eq '--direct') {
            $SelectedRoute.Value = 'gpt-subscription'
            continue
        }
        if ($arg -eq '--auto-failover') {
            $AutoFailover.Value = $true
            continue
        }
        if ($arg -eq '--no-auto-failover') {
            $AutoFailover.Value = $false
            continue
        }
        $remaining.Add($arg)
    }
    return ,$remaining.ToArray()
}

$selectedRoute = $null
$autoFailover = $env:CODEX_SAFE_AUTO_FAILOVER -eq '1'
$forwardArgs = Remove-ForwardedRouteArgs -ArgsList @($args) -SelectedRoute ([ref]$selectedRoute) -AutoFailover ([ref]$autoFailover)
if (-not $selectedRoute) {
    $selectedRoute = Normalize-Route $env:CODEX_ROUTE
}

$codexExe = Find-CodexExe

if ($selectedRoute -eq 'deepseek' -and -not (Test-Proxy) -and $env:CODEX_SAFE_NO_START -ne '1') {
    try {
        if (-not $env:DEEPSEEK_API_KEY) { throw 'DEEPSEEK_API_KEY is not set.' }
        & (Join-Path $env:SystemRoot 'System32\cscript.exe') //nologo (Join-Path $proxyDir 'start-codex-proxy.vbs')
        for ($attempt = 0; $attempt -lt 20 -and -not (Test-Proxy); $attempt++) {
            Start-Sleep -Milliseconds 250
        }
        $listener = Get-NetTCPConnection -State Listen -LocalPort 47892 -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($listener) {
            $listener.OwningProcess | Set-Content -Path (Join-Path $proxyDir '.codex-proxy.pid') -Encoding ascii
        }
    } catch {
        Write-Warning "Local multi-upstream proxy unavailable: $($_.Exception.Message)"
    }
}

if ($selectedRoute -eq 'deepseek' -and -not (Test-Proxy)) {
    if ($autoFailover) {
        Write-Warning @"
AUTO-FAILOVER ENABLED: local_multi_proxy is unavailable before launch.
Switching this invocation to GPT subscription mode.
To avoid automatic model changes, omit --auto-failover and leave CODEX_SAFE_AUTO_FAILOVER unset.
"@
        $selectedRoute = 'gpt-subscription'
    } else {
        Write-Error @"
local_multi_proxy is unavailable and automatic failover is disabled.
No model/provider switch was performed.

Next steps:
  1. Start the proxy:  powershell -ExecutionPolicy Bypass -File "$proxyDir\start-codex-proxy.ps1"
  2. Or explicitly choose GPT:  codex-mode.ps1 gpt-subscription
  3. Or opt in to automatic failover:  codex-mode.ps1 deepseek --auto-failover
"@
        exit 66
    }
}

$activeHome = Ensure-RouteHome $selectedRoute
$env:CODEX_HOME = $activeHome
$previousCodexRoute = $env:CODEX_ROUTE
$env:CODEX_ROUTE = $selectedRoute
$previousOpenAIBaseUrl = $env:OPENAI_BASE_URL
Remove-Item Env:OPENAI_BASE_URL -ErrorAction SilentlyContinue

$launchArgs = $forwardArgs
if ($selectedRoute -eq 'deepseek') {
    $hasExplicitModel = @($forwardArgs | Where-Object { $_ -eq '-m' -or $_ -eq '--model' -or $_ -like '--model=*' }).Count -gt 0
    $modelArgs = if ($hasExplicitModel) { @() } else { @('-m', 'deepseek-v4-pro') }
    $launchArgs = $modelArgs + @(
        '-c', 'model_provider="local_multi_proxy"',
        '-c', 'model_providers.local_multi_proxy.name="Local Multi-Upstream Proxy"',
        '-c', ('model_providers.local_multi_proxy.base_url="{0}/v1"' -f $proxyBaseUrl),
        '-c', 'model_providers.local_multi_proxy.wire_api="responses"',
        '-c', 'model_providers.local_multi_proxy.requires_openai_auth=true',
        '-c', ("model_catalog_json='{0}'" -f $catalog)
    ) + $forwardArgs
} elseif ($selectedRoute -eq 'gpt-subscription') {
    # Override the global config which may still point to local_multi_proxy
    $launchArgs = @(
        '-c', 'model_provider="openai"'
    ) + $forwardArgs
}

switch ($selectedRoute) {
    'deepseek' { [Console]::Error.WriteLine('[codex-safe] Using local multi-upstream proxy.') }
    'gpt-api' { [Console]::Error.WriteLine('[codex-safe] Using GPT API mode.') }
    default { [Console]::Error.WriteLine('[codex-safe] Using GPT subscription mode.') }
}

if ($env:CODEX_SAFE_DRY_RUN -eq '1') {
    [pscustomobject]@{
        mode = $selectedRoute
        auto_failover = $autoFailover
        codex_home = $activeHome
        executable = $codexExe
        arguments = $launchArgs
    } | ConvertTo-Json -Depth 4
    if ($null -ne $previousOpenAIBaseUrl) { $env:OPENAI_BASE_URL = $previousOpenAIBaseUrl }
    if ($null -ne $previousCodexRoute) { $env:CODEX_ROUTE = $previousCodexRoute } else { Remove-Item Env:CODEX_ROUTE -ErrorAction SilentlyContinue }
    exit 0
}

$failoverMarker = Join-Path $env:TEMP ("codex-proxy-failover-{0}.marker" -f [guid]::NewGuid().ToString('N'))
$parentPid = $PID
$monitor = $null
if ($selectedRoute -eq 'deepseek') {
    $monitor = Start-Job -ArgumentList $proxyHealthUrl, $parentPid, $failoverMarker, $failureThreshold -ScriptBlock {
        param($Url, $ParentPid, $Marker, $Threshold)
        $failures = 0
        while ($true) {
            Start-Sleep -Seconds 2
            try {
                $health = Invoke-RestMethod "$Url/health" -TimeoutSec 1
                if ($health.status -eq 'ok') { $failures = 0 } else { $failures++ }
            } catch {
                $failures++
            }
            if ($failures -lt $Threshold) { continue }

            $children = Get-CimInstance Win32_Process -Filter "ParentProcessId=$ParentPid" -ErrorAction SilentlyContinue |
                Where-Object { $_.Name -eq 'codex.exe' }
            Set-Content -Path $Marker -Value 'proxy-offline' -Encoding ascii
            foreach ($child in $children) {
                Stop-Process -Id $child.ProcessId -Force -ErrorAction SilentlyContinue
            }
            break
        }
    }
}

try {
    # Native Codex writes progress/status lines to stderr during `exec`. In
    # Windows PowerShell 5, ErrorActionPreference=Stop converts those lines into
    # terminating NativeCommandError records even when the process is healthy.
    $ErrorActionPreference = 'Continue'
    & $codexExe @launchArgs
    $exitCode = $LASTEXITCODE
} finally {
    $ErrorActionPreference = 'Stop'
    if ($monitor) {
        Stop-Job $monitor -ErrorAction SilentlyContinue
        Remove-Job $monitor -Force -ErrorAction SilentlyContinue
    }
    if ($null -ne $previousOpenAIBaseUrl) {
        $env:OPENAI_BASE_URL = $previousOpenAIBaseUrl
    } else {
        Remove-Item Env:OPENAI_BASE_URL -ErrorAction SilentlyContinue
    }
}

if ($selectedRoute -eq 'deepseek' -and (Test-Path $failoverMarker)) {
    Remove-Item $failoverMarker -Force -ErrorAction SilentlyContinue
    if (-not $autoFailover) {
        Write-Error @"
local_multi_proxy went offline during this Codex run.
The child Codex process was stopped to avoid continuing with a broken proxy.
Automatic GPT failover is disabled, so no model/provider switch was performed.

Next steps:
  1. Restart the proxy:  powershell -ExecutionPolicy Bypass -File "$proxyDir\start-codex-proxy.ps1"
  2. Resume manually after the proxy is healthy.
  3. If you intentionally want automatic GPT fallback, rerun with --auto-failover or set CODEX_SAFE_AUTO_FAILOVER=1.
"@
        exit 75
    }
    Write-Warning @"
AUTO-FAILOVER ENABLED: local_multi_proxy went offline during this Codex run.
Switching this thread to GPT subscription mode and resuming the last session.
"@
    $env:CODEX_ROUTE = 'gpt-subscription'
    $resumeArgs = @(
        '-m', 'gpt-5.5', '-c', 'model_provider="openai"',
        'resume', '--last',
        'The local model proxy went offline. Continue the interrupted task from this thread.'
    )
    & $codexExe @resumeArgs
    exit $LASTEXITCODE
}

if ($null -ne $previousCodexRoute) {
    $env:CODEX_ROUTE = $previousCodexRoute
} else {
    Remove-Item Env:CODEX_ROUTE -ErrorAction SilentlyContinue
}
exit $exitCode
