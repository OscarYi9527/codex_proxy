param(
    [Parameter(Mandatory = $true, Position = 0)]
    [ValidateSet('deepseek', 'gpt-subscription', 'gpt-api')]
    [string]$Route,
    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]]$CodexArgs
)

& (Join-Path $PSScriptRoot 'codex-safe.ps1') --route $Route @CodexArgs
