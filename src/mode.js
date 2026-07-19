export const PROXY_MODES = Object.freeze(['standalone', 'edge', 'gateway', 'provider-worker'])

export function parseProxyMode(options = {}) {
  const argv = options.argv || process.argv.slice(2)
  const env = options.env || process.env
  let value = env.CODEX_PROXY_MODE || 'standalone'
  const index = argv.findIndex(item => item === '--mode')
  if (index >= 0) {
    if (!argv[index + 1]) {
      throw new Error('--mode requires standalone, edge, gateway, or provider-worker')
    }
    value = argv[index + 1]
  }
  const inline = argv.find(item => item.startsWith('--mode='))
  if (inline) value = inline.slice('--mode='.length)
  if (!PROXY_MODES.includes(value)) throw new Error(`Unsupported proxy mode: ${value}`)
  return value
}
