$ErrorActionPreference = 'Stop'

function Invoke-DryRun([string]$Route) {
    $previousDryRun = $env:CODEX_SAFE_DRY_RUN
    try {
        $env:CODEX_SAFE_DRY_RUN = '1'
        $json = & (Join-Path $PSScriptRoot 'codex-safe.ps1') --route $Route --version 2>$null
        return ($json | Out-String | ConvertFrom-Json)
    } finally {
        if ($null -ne $previousDryRun) { $env:CODEX_SAFE_DRY_RUN = $previousDryRun }
        else { Remove-Item Env:CODEX_SAFE_DRY_RUN -ErrorAction SilentlyContinue }
    }
}

function Assert([bool]$Condition, [string]$Message) {
    if (-not $Condition) { throw $Message }
}

$deepseek = Invoke-DryRun 'deepseek'
Assert ($deepseek.mode -eq 'deepseek') 'DeepSeek route was not selected.'
Assert ($deepseek.arguments -contains 'deepseek-v4-pro') 'DeepSeek model override is missing.'
Assert ($deepseek.arguments -contains 'model_provider="local_multi_proxy"') 'Local multi-upstream provider override is missing.'
Assert ($deepseek.arguments -contains 'model_providers.local_multi_proxy.base_url="http://localhost:47892/v1"') 'Local multi-upstream base URL must use localhost for Codex compatibility.'
Assert ($deepseek.arguments -contains 'model_providers.local_multi_proxy.requires_openai_auth=true') 'Local multi-upstream provider must keep ChatGPT account info visible.'
Assert (($deepseek.arguments | Where-Object { $_ -like 'model_catalog_json=*' }).Count -eq 1) 'DeepSeek model catalog override is missing.'

$subscription = Invoke-DryRun 'gpt-subscription'
Assert ($subscription.mode -eq 'gpt-subscription') 'GPT subscription route was not selected.'
Assert ($subscription.codex_home -like '*\.codex') 'GPT subscription must reuse the logged-in default CODEX_HOME.'
Assert ($subscription.arguments -notcontains 'deepseek-v4-pro') 'GPT subscription route leaked DeepSeek arguments.'

$api = Invoke-DryRun 'gpt-api'
Assert ($api.mode -eq 'gpt-api') 'GPT API route was not selected.'
Assert ($api.codex_home -like '*\.codex-modes\gpt-api') 'GPT API CODEX_HOME is incorrect.'
Assert ($api.arguments -notcontains 'deepseek-v4-pro') 'GPT API route leaked DeepSeek arguments.'

Write-Output 'codex routing tests: ok'
