import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const PROXY_DIR = path.join(__dirname, '..')
const MODELS_FILE = path.join(PROXY_DIR, 'codex-models.json')
const CONFIG_FILE = path.join(PROXY_DIR, 'codex-proxy-config.json')

function syncRelayModels() {
  let config
  try { config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')) } catch { return }

  let catalog
  try { catalog = JSON.parse(fs.readFileSync(MODELS_FILE, 'utf8')) } catch { return }

  const relays = config.relays || []

  // Remove old relay entries
  catalog.models = (catalog.models || []).filter(m => !m.slug.startsWith('relay-'))

  // Add current relay models
  for (const relay of relays) {
    const models = relay.models || ['gpt-5.5', 'gpt-5.4', 'gpt-5.4-mini']
    for (const modelSlug of models) {
      const slug = `relay-${relay.id}-${modelSlug}`
      catalog.models.push({
        slug,
        display_name: `${modelSlug.toUpperCase()} (${relay.name})`,
        description: `${relay.name} — ${relay.base_url}`,
        default_reasoning_level: 'medium',
        supported_reasoning_levels: [
          { effort: 'low', description: 'Fast' },
          { effort: 'medium', description: 'Balanced' },
          { effort: 'high', description: 'Deep reasoning' },
          { effort: 'xhigh', description: 'Max reasoning' }
        ],
        shell_type: 'shell_command',
        visibility: 'list',
        supported_in_api: true,
        priority: 10,
        supports_reasoning_summaries: true,
        default_reasoning_summary: 'none',
        support_verbosity: true,
        default_verbosity: 'low',
        apply_patch_tool_type: 'freeform',
        web_search_tool_type: 'text_and_image',
        truncation_policy: { mode: 'tokens', limit: 10000 },
        supports_parallel_tool_calls: true,
        supports_image_detail_original: true,
        supports_search_tool: true,
        use_responses_lite: false,
        experimental_supported_tools: [],
        context_window: 372000,
        effective_context_window_percent: 95,
        input_modalities: ['text', 'image'],
        base_instructions: 'You are Codex, a coding agent. Use the provided tools to inspect, edit, and verify the user\'s workspace. Preserve unrelated changes and report completed work concisely.'
      })
    }
  }

  fs.writeFileSync(MODELS_FILE, JSON.stringify(catalog, null, 2), 'utf8')
  console.log('Synced', catalog.models.length, 'models to codex-models.json')
  return catalog.models.length
}

// Run if called directly
if (process.argv[1]?.includes('sync-models')) {
  syncRelayModels()
}

export { syncRelayModels }
