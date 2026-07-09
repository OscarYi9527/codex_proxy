# 刷新 VSCode Codex 模型列表
# 用法: powershell -ExecutionPolicy Bypass -File refresh-vscode-models.ps1

param([switch]$PatchWebview)

$ErrorActionPreference = 'Stop'

$proxyUrl = 'http://127.0.0.1:47892/v1/models'

Write-Host "[refresh] 从代理获取模型列表..."
try {
    $modelsResp = Invoke-RestMethod $proxyUrl -TimeoutSec 5
} catch {
    Write-Host "[refresh] 错误: 无法连接代理服务 $_"
    exit 1
}

Write-Host "[refresh] 获取到 $($modelsResp.data.Count) 个模型"

# 查找 VSCode Codex 扩展的 webview 资产文件
$extensionRoot = Join-Path $HOME '.vscode\extensions'
$assetFiles = @(Get-ChildItem -LiteralPath $extensionRoot -Recurse -Filter 'model-list-filter-*.js' -ErrorAction SilentlyContinue |
    Where-Object { $_.FullName -match '\\openai\.chatgpt-[^\\]+\\webview\\assets\\model-list-filter-' })

if ($assetFiles.Count -eq 0) {
    Write-Host "[refresh] 未找到 VSCode Codex 扩展的 model-list-filter 文件"
    Write-Host "[refresh] 请确认已安装 Codex 插件"
    exit 1
}

# 根据当前模型列表生成注入代码
$modelObjects = @()
foreach ($m in $modelsResp.data) {
    $efforts = if ($m.id -match '^relay-' -or $m.id -match '^openai-api-') {
        '[{reasoningEffort:`low`,description:`Fast`},{reasoningEffort:`medium`,description:`Balanced`},{reasoningEffort:`high`,description:`Deep reasoning`},{reasoningEffort:`xhigh`,description:`Max reasoning`}]'
    } elseif ($m.id -eq 'deepseek-v4-pro') {
        '[{reasoningEffort:`low`,description:`Faster responses`},{reasoningEffort:`medium`,description:`Balanced reasoning`},{reasoningEffort:`high`,description:`Deeper reasoning`}]'
    } else {
        '[{reasoningEffort:`low`,description:`Fast responses with lighter reasoning`},{reasoningEffort:`medium`,description:`Balanced speed and reasoning`},{reasoningEffort:`high`,description:`Greater reasoning depth`},{reasoningEffort:`xhigh`,description:`Maximum reasoning depth`}]'
    }
    $defaultEffort = if ($m.id -eq 'deepseek-v4-pro') { 'high' } else { 'medium' }
    $modalities = if ($m.id -eq 'deepseek-v4-pro') { '[`text`]' } else { '[`text`,`image`]' }
    $isHidden = if ($m.owned_by -eq 'relay') { '!1' } else { '!1' } # all visible
    
    $displayName = switch -Wildcard ($m.id) {
        'deepseek-v4-pro' { 'DeepSeek V4 Pro' }
        'gpt-5.5' { 'GPT-5.5 (订阅)' }
        'gpt-5.4' { 'GPT-5.4 (订阅)' }
        'gpt-5.4-mini' { 'GPT-5.4 Mini (订阅)' }
        'openai-api-gpt-5.5' { 'GPT-5.5 (API Key)' }
        'openai-api-gpt-5.4' { 'GPT-5.4 (API Key)' }
        'openai-api-gpt-5.4-mini' { 'GPT-5.4 Mini (API Key)' }
        default { $m.id }
    }
    
    # For relay models, extract name from slug
    if ($m.id -match '^relay-') {
        $parts = $m.id -split '-'
        $displayName = "$($parts[-1].ToUpper()) (中转站: $($parts[1]))"
    }
    
    $modelObj = "{id:`$($m.id)`,model:`$($m.id)`,displayName:`$displayName`,description:`$displayName`,hidden:$isHidden,isDefault:!1,defaultReasoningEffort:`$defaultEffort,supportedReasoningEfforts:$efforts,inputModalities:$modalities,additionalSpeedTiers:[],serviceTiers:[],defaultServiceTier:null,availabilityNux:null,supportsPersonality:!1,upgrade:null}"
    $modelObjects += $modelObj
}

$customModels = 'for(const l of [' + ($modelObjects -join ',') + ']){o=o.some(e=>e.model===l.model)?o:[l,...o];n&&typeof n.add===`function`&&n.add(l.model)}let c=[]'

Write-Host "[refresh] 生成 $($modelObjects.Count) 个模型定义"

foreach ($assetFile in $assetFiles) {
    $text = [IO.File]::ReadAllText($assetFile.FullName)
    
    # 查找旧的注入代码并替换
    $pattern = 'for\(const l of \[.*?\]\)\{o=o\.some\(e=>e\.model===l\.model\)\?o:\[l,\.\.\.o\];n&&typeof n\.add===`function`&&n\.add\(l\.model\)\}'
    
    if ($text -match $pattern) {
        $patched = $text -replace $pattern, $customModels
        $backupPath = "$($assetFile.FullName).refresh.bak"
        if (-not (Test-Path $backupPath)) {
            Copy-Item -LiteralPath $assetFile.FullName -Destination $backupPath -Force
        }
        [IO.File]::WriteAllText($assetFile.FullName, $patched, [Text.UTF8Encoding]::new($false))
        Write-Host "[refresh] ✅ 已更新: $($assetFile.Name)"
    } else {
        Write-Host "[refresh] ⚠️ 未找到注入点: $($assetFile.Name)"
    }
}

Write-Host ""
Write-Host "[refresh] 完成! 请重新加载 VSCode 窗口 (Ctrl+Shift+P -> Reload Window)"
