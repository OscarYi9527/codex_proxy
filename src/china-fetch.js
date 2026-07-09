// Some upstreams (chatgpt.com, api.openai.com) are only reachable through the
// user's local HTTP proxy on this machine. Node's global fetch (undici built
// into Node core) and the standalone `undici` npm package are different
// internal implementations — a ProxyAgent built from the package can't
// dispatch through the built-in global fetch. So whenever a proxy is
// configured, callers must use the package's own fetch as well.
import { ProxyAgent, fetch as undiciFetch } from 'undici'

const PROXY_URL = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy || null
export const chinaDispatcher = PROXY_URL ? new ProxyAgent(PROXY_URL) : undefined

export function chinaFetch(fallbackFetchImpl) {
  return chinaDispatcher ? undiciFetch : fallbackFetchImpl
}

export function withChinaDispatcher(options) {
  return chinaDispatcher ? { ...options, dispatcher: chinaDispatcher } : options
}
