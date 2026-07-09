const fs = require('fs')
const path = require('path')
const os = require('os')

async function main() {
  console.log('[刷新] 从代理获取模型列表...')
  let modelsResp
  try {
    const r = await fetch('http://127.0.0.1:47892/v1/models')
    modelsResp = await r.json()
  } catch (e) {
    console.error('[刷新] 无法连接代理: ' + e.message)
    process.exit(1)
  }
  console.log('[刷新] 获取到 ' + modelsResp.data.length + ' 个模型')

  // 生成模型注入代码
  const modelObjects = []
  for (const m of modelsResp.data) {
    let displayName = m.id
    let defaultEffort = 'medium'
    let efforts = '[{reasoningEffort:`low`,description:`Fast`},{reasoningEffort:`medium`,description:`Balanced`},{reasoningEffort:`high`,description:`Deep reasoning`},{reasoningEffort:`xhigh`,description:`Max reasoning`}]'
    let modalities = '[`text`,`image`]'

    if (m.id === 'deepseek-v4-pro') {
      displayName = 'DeepSeek V4 Pro'
      defaultEffort = 'high'
      efforts = '[{reasoningEffort:`low`,description:`Faster responses`},{reasoningEffort:`medium`,description:`Balanced reasoning`},{reasoningEffort:`high`,description:`Deeper reasoning`}]'
      modalities = '[`text`]'
    } else if (m.id === 'gpt-5.5') {
      displayName = 'GPT-5.5 (订阅)'
    } else if (m.id === 'gpt-5.4') {
      displayName = 'GPT-5.4 (订阅)'
    } else if (m.id === 'gpt-5.4-mini') {
      displayName = 'GPT-5.4 Mini (订阅)'
    } else if (m.id === 'openai-api-gpt-5.5') {
      displayName = 'GPT-5.5 (API Key)'
    } else if (m.id === 'openai-api-gpt-5.4') {
      displayName = 'GPT-5.4 (API Key)'
    } else if (m.id === 'openai-api-gpt-5.4-mini') {
      displayName = 'GPT-5.4 Mini (API Key)'
    } else if (m.id.startsWith('relay-')) {
      const parts = m.id.split('-')
      displayName = parts[parts.length - 1].toUpperCase() + ' (中转站: ' + parts[1] + ')'
    }

    modelObjects.push(
      '{id:`' + m.id + '`,model:`' + m.id + '`,displayName:`' + displayName + '`,description:`' + displayName + '`,hidden:!1,isDefault:!1,defaultReasoningEffort:`' + defaultEffort + '`,supportedReasoningEfforts:' + efforts + ',inputModalities:' + modalities + ',additionalSpeedTiers:[],serviceTiers:[],defaultServiceTier:null,availabilityNux:null,supportsPersonality:!1,upgrade:null}'
    )
  }

  const customModels = 'for(const l of [' + modelObjects.join(',') + ']){o=o.some(e=>e.model===l.model)?o:[l,...o];n&&typeof n.add===`function`&&n.add(l.model)}let c=[]'
  console.log('[刷新] 生成 ' + modelObjects.length + ' 个模型定义')

  // 查找 VSCode Codex 扩展的 webview 文件
  const extDir = path.join(os.homedir(), '.vscode', 'extensions')

  // 直接匹配文件路径模式
  function findModelFilterFiles(dir) {
    const results = []
    try {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name)
        try {
          if (entry.isDirectory()) {
            // Only traverse into openai.chatgpt-* and webview/assets
            if (entry.name.startsWith('openai.chatgpt-') || entry.name === 'webview' || entry.name === 'assets') {
              results.push(...findModelFilterFiles(full))
            }
          } else if (entry.name.startsWith('model-list-filter-') && entry.name.endsWith('.js')) {
            results.push(full)
          }
        } catch {}
      }
    } catch {}
    return results
  }

  const assetFiles = findModelFilterFiles(extDir)
  console.log('[刷新] 找到 ' + assetFiles.length + ' 个 model-list-filter 文件')

  if (assetFiles.length === 0) {
    console.error('[刷新] 未找到文件，请确认已安装 Codex 插件')
    process.exit(1)
  }

  let patchedCount = 0
  for (const file of assetFiles) {
    const text = fs.readFileSync(file, 'utf8')

    // Check: already injected?
    const injectionRegex = /for\(const l of \[.*?\]\)\{o=o\.some\(e=>e\.model===l\.model\)\?o:\[l,\.\.\.o\];n&&typeof n\.add===`function`&&n\.add\(l\.model\)\}/
    const needsInjection = !injectionRegex.test(text) && text.includes('function t({authMethod')

    if (needsInjection) {
      // Fresh injection: replace `let c=[]` at the start of the model filter function
      const needle = 'function t({authMethod:t,availableModels:n,defaultModel:r,enabledReasoningEfforts:i,includeUltraReasoningEffort:a,models:o,useHiddenModels:s}){let c=[]'
      const idx = text.indexOf(needle)
      if (idx >= 0) {
        const patched = text.replace(needle, 'function t({authMethod:t,availableModels:n,defaultModel:r,enabledReasoningEfforts:i,includeUltraReasoningEffort:a,models:o,useHiddenModels:s}){' + customModels)
        fs.copyFileSync(file, file + '.refresh.bak')
        fs.writeFileSync(file, patched, 'utf8')
        console.log('[刷新] ✅ 注入: ' + path.basename(file))
        patchedCount++
      } else {
        console.log('[刷新] ⚠️ 未找到注入点: ' + path.basename(file))
      }
    } else if (injectionRegex.test(text)) {
      // Already injected - replace with fresh models
      const patched = text.replace(injectionRegex, customModels)
      fs.copyFileSync(file, file + '.refresh.bak')
      fs.writeFileSync(file, patched, 'utf8')
      console.log('[刷新] ✅ 更新: ' + path.basename(file))
      patchedCount++
    } else {
      console.log('[刷新] ⚠️ 不支持的文件格式: ' + path.basename(file))
    }
  }

  if (patchedCount === 0) {
    console.log('[刷新] ⚠️ 没有文件被更新')
  } else {
    console.log('[刷新] ✅ 更新了 ' + patchedCount + ' 个文件')
  }
  console.log('[刷新] 请在 VSCode 中 Ctrl+Shift+P → Reload Window 重新加载')
}

main().catch(e => { console.error(e); process.exit(1) })