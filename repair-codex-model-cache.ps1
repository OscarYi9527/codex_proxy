$ErrorActionPreference = 'Stop'

$codexHome = Join-Path $HOME '.codex'
$cachePath = Join-Path $codexHome 'models_cache.json'
$catalogPath = Join-Path $PSScriptRoot 'codex-models.json'

if (-not (Test-Path -LiteralPath $cachePath)) {
    throw "Missing Codex models cache: $cachePath"
}
if (-not (Test-Path -LiteralPath $catalogPath)) {
    throw "Missing local model catalog: $catalogPath"
}

$cache = Get-Content -Raw -LiteralPath $cachePath | ConvertFrom-Json
$catalog = Get-Content -Raw -LiteralPath $catalogPath | ConvertFrom-Json
$deepseek = @($catalog.models | Where-Object { $_.slug -eq 'deepseek-v4-pro' } | Select-Object -First 1)[0]
if (-not $deepseek) {
    throw "deepseek-v4-pro not found in $catalogPath"
}

$existing = @($cache.models | Where-Object { $_.slug -eq 'deepseek-v4-pro' })
if ($existing.Count -gt 0) {
    Write-Host '[repair] models_cache.json already contains deepseek-v4-pro'
} else {
    $deepseekCacheModel = [pscustomobject]@{
        slug = $deepseek.slug
        display_name = $deepseek.display_name
        description = $deepseek.description
        default_reasoning_level = $deepseek.default_reasoning_level
        supported_reasoning_levels = $deepseek.supported_reasoning_levels
        shell_type = $deepseek.shell_type
        visibility = 'list'
        supported_in_api = $true
        priority = 0
        additional_speed_tiers = @()
        service_tiers = @()
        availability_nux = $null
        upgrade = $null
        base_instructions = $deepseek.base_instructions
        model_messages = $null
        supports_reasoning_summaries = $false
        default_reasoning_summary = 'none'
        support_verbosity = $false
        default_verbosity = 'low'
        apply_patch_tool_type = $deepseek.apply_patch_tool_type
        web_search_tool_type = $deepseek.web_search_tool_type
        truncation_policy = $deepseek.truncation_policy
        supports_parallel_tool_calls = $false
        supports_image_detail_original = $false
        context_window = $deepseek.context_window
        max_context_window = $deepseek.context_window
        comp_hash = 'local'
        effective_context_window_percent = $deepseek.effective_context_window_percent
        experimental_supported_tools = @()
        input_modalities = $deepseek.input_modalities
        supports_search_tool = $true
        use_responses_lite = $false
        tool_mode = 'code_mode_only'
        multi_agent_version = 'v2'
    }

    $models = New-Object System.Collections.Generic.List[object]
    $models.Add($deepseekCacheModel)
    foreach ($model in @($cache.models)) {
        if ($model.PSObject.Properties.Name -contains 'priority' -and $null -ne $model.priority) {
            $model.priority = [int]$model.priority + 1
        }
        $models.Add($model)
    }
    $cache | Add-Member -NotePropertyName models -NotePropertyValue @($models.ToArray()) -Force
    $cache.fetched_at = (Get-Date).ToUniversalTime().ToString('o')

    $json = $cache | ConvertTo-Json -Depth 100
    [IO.File]::WriteAllText($cachePath, $json + "`r`n", [Text.UTF8Encoding]::new($false))
    Write-Host '[repair] injected deepseek-v4-pro into models_cache.json'
}

$baseAuthPath = Join-Path $codexHome 'auth.json'
$subscriptionHome = Join-Path (Join-Path $HOME '.codex-modes') 'gpt-subscription'
$subscriptionAuthPath = Join-Path $subscriptionHome 'auth.json'
if ((Test-Path -LiteralPath $baseAuthPath) -and (Test-Path -LiteralPath $subscriptionHome)) {
    Copy-Item -LiteralPath $baseAuthPath -Destination $subscriptionAuthPath -Force
    Write-Host '[repair] synced chatgpt auth.json into gpt-subscription mode'
}
