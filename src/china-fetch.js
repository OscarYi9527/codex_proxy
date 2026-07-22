// Some upstreams (chatgpt.com, api.openai.com) are only reachable through the
// user's local HTTP proxy on this machine. Node's global fetch (undici built
// into Node core) and the standalone `undici` npm package are different
// internal implementations — a ProxyAgent built from the package can't
// dispatch through the built-in global fetch. So whenever a proxy is
// configured, callers must use the package's own fetch as well.
import { ProxyAgent, fetch as undiciFetch } from 'undici'

const PROXY_URL = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy || null
const PROXY_CONNECTIONS = Math.max(
  1,
  Math.min(16, Number(process.env.CODEX_OUTBOUND_PROXY_CONNECTIONS) || 6)
)
export const chinaDispatcher = PROXY_URL
  ? new ProxyAgent({
      uri: PROXY_URL,
      // Keep the local desktop proxy from being flooded by account checks,
      // foreground turns, and retries opening independent sockets at once.
      connections: PROXY_CONNECTIONS,
      pipelining: 1,
      keepAliveTimeout: 10000,
      keepAliveMaxTimeout: 30000
    })
  : undefined

export function chinaFetch(fallbackFetchImpl) {
  return chinaDispatcher ? undiciFetch : fallbackFetchImpl
}

export function withChinaDispatcher(options) {
  return chinaDispatcher ? { ...options, dispatcher: chinaDispatcher } : options
}
