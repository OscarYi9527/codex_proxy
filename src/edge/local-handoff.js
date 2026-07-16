import crypto from 'node:crypto'

function opaque(prefix) {
  return `${prefix}_${crypto.randomUUID().replaceAll('-', '')}`
}

function secret(bytes = 32) {
  return crypto.randomBytes(bytes).toString('base64url')
}

function edgeError(code, message, statusCode = 400) {
  return Object.assign(new Error(message), { code, statusCode })
}

export class LocalHandoffService {
  constructor(options) {
    this.bindingStore = options.bindingStore
    this.now = options.now || (() => Date.now())
    this.grants = new Map()
  }

  start(state) {
    if (typeof state !== 'string' || state.length < 8 || state.length > 512) {
      throw edgeError('invalid_login_state', 'Invalid login state')
    }
    this.prune()
    const handoffId = opaque('lh')
    const nonce = secret()
    this.grants.set(handoffId, {
      nonce,
      state,
      expiresAt: this.now() + 60_000
    })
    return { handoffId, nonce, expiresIn: 60 }
  }

  async complete(body) {
    const grant = this.grants.get(body?.handoffId)
    this.grants.delete(body?.handoffId)
    if (
      !grant ||
      grant.expiresAt < this.now() ||
      grant.nonce !== body?.nonce ||
      grant.state !== body?.state
    ) {
      throw edgeError('handoff_invalid', 'Local handoff is invalid or expired')
    }
    if (
      typeof body.deviceSessionId !== 'string' ||
      typeof body.refreshToken !== 'string' ||
      typeof body.accessToken !== 'string' ||
      !Number.isFinite(Number(body.accessTokenExpiresIn)) ||
      Number(body.accessTokenExpiresIn) <= 0
    ) {
      throw edgeError('handoff_incomplete', 'Local handoff payload is incomplete')
    }
    const bindingVersion = await this.bindingStore.completeHandoff({
      deviceSessionId: body.deviceSessionId,
      refreshToken: body.refreshToken,
      accessToken: body.accessToken,
      accessTokenExpiresIn: Number(body.accessTokenExpiresIn)
    })
    return { status: 'completed', bindingVersion }
  }

  prune() {
    const now = this.now()
    for (const [id, grant] of this.grants) {
      if (grant.expiresAt < now) this.grants.delete(id)
    }
  }
}
