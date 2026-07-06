param(
    [Parameter(Mandatory = $true)]
    [ValidateSet('Proxy', 'Direct')]
    [string]$Route
)

$ErrorActionPreference = 'Stop'
$configDir = Join-Path $HOME '.codex'
$configFile = Join-Path $configDir 'config.toml'
$backupFile = Join-Path $configDir 'config.toml.pre-codex-proxy.bak'
$catalogFile = Join-Path $PSScriptRoot 'codex-models.json'

if (-not (Test-Path -LiteralPath $configFile)) {
    New-Item -ItemType Directory -Path $configDir -Force | Out-Null
    [IO.File]::WriteAllText($configFile, '', [Text.UTF8Encoding]::new($false))
}
if (-not (Test-Path -LiteralPath $backupFile)) {
    Copy-Item -LiteralPath $configFile -Destination $backupFile
}

function Set-TopLevelValue([string]$Text, [string]$Key, [string]$TomlValue) {
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

$text = [IO.File]::ReadAllText($configFile)
if ($Route -eq 'Proxy') {
    $text = Set-TopLevelValue $text 'model' '"deepseek-v4-pro"'
    $text = Set-TopLevelValue $text 'model_provider' '"local_multi_proxy"'
    $catalogToml = "'" + $catalogFile + "'"
    $text = Set-TopLevelValue $text 'model_catalog_json' $catalogToml

    if ($text -notmatch '(?m)^\[model_providers\.local_multi_proxy\]\s*$') {
        $text = $text.TrimEnd() + "`r`n`r`n[model_providers.local_multi_proxy]`r`n" +
            "name = `"Local Multi-Upstream Proxy`"`r`n" +
            "base_url = `"http://localhost:47892/v1`"`r`n" +
            "wire_api = `"responses`"`r`n" +
            "requires_openai_auth = true`r`n"
    } elseif ($text -match '(?m)^\[model_providers\.local_multi_proxy\]\s*$' -and
        $text -notmatch '(?m)^requires_openai_auth\s*=') {
        $text = $text -replace '(?m)(^\[model_providers\.local_multi_proxy\]\s*(?:\r?\n(?!\[).*)*)', "`$1`r`nrequires_openai_auth = true"
    }
} else {
    $text = Set-TopLevelValue $text 'model' '"gpt-5.5"'
    $text = Set-TopLevelValue $text 'model_provider' '"openai"'
    $text = Remove-TopLevelValue $text 'model_catalog_json'
}

$tempFile = "$configFile.tmp"
[IO.File]::WriteAllText($tempFile, $text, [Text.UTF8Encoding]::new($false))
Move-Item -LiteralPath $tempFile -Destination $configFile -Force
Write-Host "[codex-route] Default route: $Route"
