import crypto from 'node:crypto'
import { Readable } from 'node:stream'

const ACCESS_REFRESH_SKEW_MS = 30_000
const JSON_LIMIT = 1024 * 1024
const LOGIN_REQUIRED_CODES = new Set([
  'login_required',
  'invalid_grant',
  'refresh_token_reuse_detected'
])

function edgeError(code, message, statusCode = 401, retryable = false) {
  return Object.assign(new Error(message), { code, statusCode, retryable })
}

async function readJsonResponse(response) {
  const text = await response.text()
  if (Buffer.byteLength(text) > JSON_LIMIT) {
    throw edgeError('account_service_unavailable', 'Gateway response is too large', 503, true)
  }
  let value = {}
  if (text) {
    try {
      value = JSON.parse(text)
    } catch {
      throw edgeError('account_service_unavailable', 'Gateway returned invalid JSON', 503, true)
    }
  }
  if (!response.ok) {
    const code = value?.error?.code
    throw edgeError(
      typeof code === 'string' ? code : 'account_service_unavailable',
      'Gateway rejected the request',
      response.status,
      Boolean(value?.error?.retryable)
    )
  }
  return value
}

export class GatewayClient {
  constructor(options) {
    this.gatewayOrigin = options.gatewayOrigin
    this.bindingStore = options.bindingStore
    this.fetchImpl = options.fetchImpl || fetch
    this.now = options.now || (() => Date.now())
    this.refreshFlight = null
  }

  async initialize() {
    await this.bindingStore.initialize()
  }

  async getSafeStatus() {
    let snapshot
    try {
      snapshot = await this.getAuthenticatedSnapshot()
    } catch (error) {
      if (!LOGIN_REQUIRED_CODES.has(error.code)) throw error
      const current = this.bindingStore.snapshot()
      if (current) await this.bindingStore.clear(current.bindingVersion)
      snapshot = null
    }
    if (!snapshot) {
      return {
        state: 'login_required',
        checkedAt: new Date(this.now()).toISOString(),
        actions: ['login']
      }
    }
    try {
      const status = await this.requestJson('/api/v1/account/status', 'GET', undefined, snapshot)
      if (status.state !== 'ready') {
        return {
          state: status.state,
          checkedAt: status.checkedAt || new Date(this.now()).toISOString(),
          errorId: status.errorId,
          actions: Array.isArray(status.actions) ? status.actions : ['openAccount']
        }
      }
      const me = await this.requestJson('/api/v1/account/me', 'GET', undefined, snapshot)
      return {
        state: 'ready',
        checkedAt: status.checkedAt || new Date(this.now()).toISOString(),
        account: {
          display: me.account?.email || me.account?.loginName || 'AI Editor 账号',
          role: me.account?.role || 'user'
        },
        currentModel: status.safeSummary?.currentModel || null,
        availableCredits: status.safeSummary?.availableCredits || '0.000000',
        usedCreditsPercent: status.safeSummary?.usedCreditsPercent || '0',
        actions: []
      }
    } catch (error) {
      if (LOGIN_REQUIRED_CODES.has(error.code)) {
        await this.bindingStore.clear(snapshot.bindingVersion)
        return {
          state: 'login_required',
          checkedAt: new Date(this.now()).toISOString(),
          actions: ['login']
        }
      }
      if (error.code === 'password_change_required') {
        return {
          state: 'password_change_required',
          checkedAt: new Date(this.now()).toISOString(),
          errorId: `err_${crypto.randomUUID().replaceAll('-', '')}`,
          actions: ['openAccount']
        }
      }
      if (['account_disabled', 'account_expired'].includes(error.code)) {
        return {
          state: 'account_unavailable',
          checkedAt: new Date(this.now()).toISOString(),
          errorId: `err_${crypto.randomUUID().replaceAll('-', '')}`,
          actions: ['openAccount']
        }
      }
      return {
        state: 'service_unavailable',
        checkedAt: new Date(this.now()).toISOString(),
        errorId: `err_${crypto.randomUUID().replaceAll('-', '')}`,
        actions: ['retry']
      }
    }
  }

  async requestWebviewTicket() {
    const snapshot = await this.getAuthenticatedSnapshot()
    return this.requestJson('/api/v1/account/webview-ticket', 'POST', {
      audience: this.gatewayOrigin,
      purpose: 'account-management'
    }, snapshot)
  }

  async logout() {
    const snapshot = this.bindingStore.snapshot()
    if (!snapshot) return
    try {
      const authenticated = await this.getAuthenticatedSnapshot()
      await this.requestJson('/api/v1/account/logout', 'POST', {}, authenticated, true)
    } finally {
      await this.bindingStore.clear(snapshot.bindingVersion)
    }
  }

  async models() {
    const snapshot = await this.getAuthenticatedSnapshot()
    return this.requestJson('/v1/models', 'GET', undefined, snapshot)
  }

  async forward(path, localRequest, localResponse, body) {
    const snapshot = await this.getAuthenticatedSnapshot()
    const turnId = String(localRequest.headers['x-ai-editor-turn-id'] || '')
      || `turn_${crypto.randomUUID().replaceAll('-', '')}`
    let requestBody
    try {
      requestBody = body === undefined ? undefined : Buffer.from(JSON.stringify(body), 'utf8')
      const response = await this.fetchImpl(new URL(path, this.gatewayOrigin), {
        method: localRequest.method,
        headers: {
          accept: String(localRequest.headers.accept || 'application/json'),
          'content-type': 'application/json',
          authorization: `Bearer ${snapshot.accessToken}`,
          'x-ai-editor-device-session': snapshot.deviceSessionId,
          'x-ai-editor-turn-id': turnId,
          'x-ai-editor-client': 'edge/2.x'
        },
        body: requestBody
      })
      const headers = {
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff'
      }
      // Preserve only safe routing metadata from the central Gateway. This
      // lets the local Edge and product diagnostics distinguish the actual
      // Provider Worker route from unrelated local processes such as the
      // shared standalone Proxy on 47892.
      for (const name of [
        'content-type',
        'x-request-id',
        'x-codex-proxy-request-id',
        'x-ai-editor-provider-id',
        'x-ai-editor-idempotent-replay'
      ]) {
        const value = response.headers.get(name)
        if (value) headers[name] = value
      }
      localResponse.writeHead(response.status, headers)
      if (!response.body) {
        localResponse.end()
        return
      }
      await new Promise((resolve, reject) => {
        const stream = Readable.fromWeb(response.body)
        stream.on('error', reject)
        localResponse.on('error', reject)
        localResponse.on('finish', resolve)
        stream.pipe(localResponse)
      })
    } finally {
      requestBody?.fill(0)
    }
  }

  async getAuthenticatedSnapshot() {
    await this.bindingStore.initialize()
    let snapshot = this.bindingStore.snapshot()
    if (!snapshot) throw edgeError('login_required', 'AI Editor login required')
    if (
      snapshot.accessToken &&
      snapshot.accessTokenExpiresAt > this.now() + ACCESS_REFRESH_SKEW_MS
    ) {
      return snapshot
    }
    if (!this.refreshFlight || this.refreshFlight.version !== snapshot.bindingVersion) {
      const promise = this.refresh(snapshot)
      this.refreshFlight = { version: snapshot.bindingVersion, promise }
      promise.finally(() => {
        if (this.refreshFlight?.promise === promise) this.refreshFlight = null
      }).catch(() => undefined)
    }
    await this.refreshFlight.promise
    snapshot = this.bindingStore.snapshot()
    if (!snapshot?.accessToken) throw edgeError('login_required', 'AI Editor login required')
    return snapshot
  }

  async refresh(snapshot) {
    const result = await this.requestJson('/api/v1/oauth/token', 'POST', {
      grantType: 'refresh_token',
      clientId: 'ai-editor-edge',
      refreshToken: snapshot.refreshToken,
      deviceSessionId: snapshot.deviceSessionId
    })
    const updated = await this.bindingStore.updateAfterRefresh(snapshot.bindingVersion, {
      deviceSessionId: result.deviceSessionId,
      refreshToken: result.refreshToken,
      accessToken: result.accessToken,
      accessTokenExpiresIn: result.accessTokenExpiresIn
    })
    if (!updated) throw edgeError('login_required', 'Account binding changed during refresh')
  }

  async requestJson(path, method, body, snapshot, allowEmpty = false) {
    let requestBody
    try {
      requestBody = body === undefined ? undefined : Buffer.from(JSON.stringify(body), 'utf8')
      const response = await this.fetchImpl(new URL(path, this.gatewayOrigin), {
        method,
        headers: {
          accept: 'application/json',
          ...(requestBody ? {
            'content-type': 'application/json'
          } : {}),
          ...(snapshot ? {
            authorization: `Bearer ${snapshot.accessToken}`,
            'x-ai-editor-device-session': snapshot.deviceSessionId,
            'x-ai-editor-client': 'edge/2.x'
          } : {})
        },
        body: requestBody
      })
      if (allowEmpty && response.status === 204) return {}
      return await readJsonResponse(response)
    } catch (error) {
      if (error?.code) throw error
      throw edgeError('account_service_unavailable', 'Gateway is unavailable', 503, true)
    } finally {
      requestBody?.fill(0)
    }
  }
}
