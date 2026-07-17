import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { SafeError } from '../common/errors.js'
import { AuthorizationService } from '../auth/authorization-service.js'
import { TokenService } from '../auth/token-service.js'
import { AccountService } from '../auth/account-service.js'
import type { AccessTokenVerifier } from './middleware/authentication.js'
import { requireAccessToken } from './middleware/authentication.js'

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new SafeError({
      code: 'invalid_request',
      message: '请求正文无效。',
      statusCode: 400
    })
  }
  return value as Record<string, unknown>
}

function requiredString(value: Record<string, unknown>, key: string): string {
  const candidate = value[key]
  if (typeof candidate !== 'string' || !candidate) {
    throw new SafeError({
      code: 'invalid_request',
      message: `缺少字段：${key}。`,
      statusCode: 400
    })
  }
  return candidate
}

function optionalString(value: Record<string, unknown>, key: string): string | undefined {
  const candidate = value[key]
  if (candidate === undefined) return undefined
  if (typeof candidate !== 'string') {
    throw new SafeError({
      code: 'invalid_request',
      message: `字段格式无效：${key}。`,
      statusCode: 400
    })
  }
  return candidate
}

function requireIdentity(request: FastifyRequest) {
  if (!request.accountIdentity) {
    throw new SafeError({
      code: 'login_required',
      message: '需要登录 AI Editor 产品账号。',
      statusCode: 401
    })
  }
  return request.accountIdentity
}

function authorizationPage(transactionId: string): string {
  const escaped = transactionId.replaceAll('&', '&amp;').replaceAll('"', '&quot;')
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>AI Editor 登录</title>
  <style>
    body{font:16px system-ui;margin:0;background:#f5f7fb;color:#172033}
    main{max-width:520px;margin:8vh auto;padding:32px;background:#fff;border-radius:16px}
    form{display:grid;gap:12px;margin:24px 0}input,button{font:inherit;padding:11px}
    button{background:#1769e0;color:#fff;border:0;border-radius:8px}
  </style>
</head>
<body><main>
  <h1>AI Editor 产品账号</h1>
  <form method="post" action="/api/v1/oauth/authorize/login">
    <input type="hidden" name="authorizationTransactionId" value="${escaped}">
    <label>账号或邮箱 <input name="identifier" required autocomplete="username"></label>
    <label>密码 <input name="password" type="password" required autocomplete="current-password"></label>
    <button type="submit">登录</button>
  </form>
  <hr>
  <form method="post" action="/api/v1/auth/register">
    <input type="hidden" name="authorizationTransactionId" value="${escaped}">
    <label>邀请码 <input name="invitationCode" required autocomplete="off"></label>
    <label>邮箱 <input name="email" type="email" required autocomplete="email"></label>
    <label>密码 <input name="password" type="password" required autocomplete="new-password"></label>
    <button type="submit">注册并登录</button>
  </form>
</main></body></html>`
}

export function registerAuthRoutes(app: FastifyInstance, options: {
  authorization: AuthorizationService
  tokens: TokenService
  accounts: AccountService
  verifier: AccessTokenVerifier
  statusVerifier?: AccessTokenVerifier
  accountAuthenticator?: (
    request: FastifyRequest,
    reply: FastifyReply
  ) => Promise<void>
  currentModel: () => Promise<string | null>
  issueWebviewTicket: (
    identity: ReturnType<typeof requireIdentity>,
    body: Record<string, unknown>
  ) => Promise<{ ticket: string; expiresIn: number }>
}): void {
  const authenticate = requireAccessToken(options.verifier)
  const authenticateStatus = requireAccessToken(options.statusVerifier || options.verifier)
  const authenticateAccount = options.accountAuthenticator || authenticate

  app.get('/api/v1/oauth/authorize', async (request, reply) => {
    const query = asRecord(request.query)
    const transaction = options.authorization.start({
      clientId: requiredString(query, 'client_id'),
      redirectUri: requiredString(query, 'redirect_uri'),
      responseType: requiredString(query, 'response_type'),
      codeChallenge: requiredString(query, 'code_challenge'),
      codeChallengeMethod: requiredString(query, 'code_challenge_method'),
      state: requiredString(query, 'state')
    })
    await reply
      .header('Cache-Control', 'no-store')
      .type('text/html; charset=utf-8')
      .send(authorizationPage(transaction.authorizationTransactionId))
  })

  app.post('/api/v1/oauth/authorize/login', async (request, reply) => {
    const body = asRecord(request.body)
    const authorizationTransactionId = requiredString(body, 'authorizationTransactionId')
    try {
      const completion = await options.authorization.login({
        authorizationTransactionId,
        identifier: requiredString(body, 'identifier'),
        password: requiredString(body, 'password')
      })
      await reply.redirect(completion.redirectUri, 303)
    } catch (error) {
      if (!(error instanceof SafeError) || error.code === 'authorization_transaction_invalid') {
        throw error
      }
      await reply.redirect(
        options.authorization.fail(authorizationTransactionId, 'access_denied'),
        303
      )
    }
  })

  app.post('/api/v1/auth/register', async (request, reply) => {
    const body = asRecord(request.body)
    const authorizationTransactionId = requiredString(body, 'authorizationTransactionId')
    try {
      const completion = await options.authorization.register({
        authorizationTransactionId,
        invitationCode: requiredString(body, 'invitationCode'),
        email: requiredString(body, 'email'),
        password: requiredString(body, 'password')
      })
      if (String(request.headers['content-type'] || '').includes('application/x-www-form-urlencoded')) {
        await reply.redirect(completion.redirectUri, 303)
        return
      }
      return { redirectUri: completion.redirectUri }
    } catch (error) {
      if (!(error instanceof SafeError) || error.code === 'authorization_transaction_invalid') {
        throw error
      }
      if (!String(request.headers['content-type'] || '').includes('application/x-www-form-urlencoded')) {
        throw error
      }
      const redirectUri = options.authorization.fail(
        authorizationTransactionId,
        error.code === 'password_policy_failed' || error.code === 'email_invalid'
          ? 'invalid_request'
          : 'access_denied'
      )
      await reply.redirect(redirectUri, 303)
    }
  })

  app.post('/api/v1/oauth/token', async request => {
    const body = asRecord(request.body)
    const grantType = requiredString(body, 'grantType')
    if (grantType === 'authorization_code') {
      const device = asRecord(body['device'])
      return options.tokens.exchangeAuthorizationCode({
        clientId: requiredString(body, 'clientId'),
        code: requiredString(body, 'code'),
        codeVerifier: requiredString(body, 'codeVerifier'),
        redirectUri: requiredString(body, 'redirectUri'),
        device: {
          name: requiredString(device, 'name'),
          platform: requiredString(device, 'platform') as 'windows' | 'macos' | 'other'
        }
      })
    }
    if (grantType === 'refresh_token') {
      return options.tokens.rotateRefreshToken({
        clientId: requiredString(body, 'clientId'),
        refreshToken: requiredString(body, 'refreshToken'),
        deviceSessionId: requiredString(body, 'deviceSessionId')
      })
    }
    throw new SafeError({
      code: 'unsupported_grant_type',
      message: '不支持的登录凭据类型。',
      statusCode: 400
    })
  })

  app.get('/api/v1/account/status', { preHandler: authenticateStatus }, async request =>
    options.accounts.status(requireIdentity(request), await options.currentModel()))

  app.get('/api/v1/account/me', { preHandler: authenticateAccount }, async request =>
    options.accounts.me(requireIdentity(request)))

  app.post('/api/v1/account/password/change', { preHandler: authenticateAccount }, async request => {
    const body = asRecord(request.body)
    const email = optionalString(body, 'email')
    return options.accounts.changePassword({
      identity: requireIdentity(request),
      currentPassword: requiredString(body, 'currentPassword'),
      newPassword: requiredString(body, 'newPassword'),
      ...(email === undefined ? {} : { email })
    })
  })

  app.post('/api/v1/account/webview-ticket', { preHandler: authenticate }, async request =>
    options.issueWebviewTicket(requireIdentity(request), asRecord(request.body)))

  app.get('/api/v1/account/devices', { preHandler: authenticateAccount }, async request =>
    options.accounts.devices(requireIdentity(request)))

  app.delete('/api/v1/account/devices/:sessionId', { preHandler: authenticateAccount }, async (request, reply) => {
    const params = asRecord(request.params)
    const query = asRecord(request.query)
    await options.accounts.revokeDevice(
      requireIdentity(request),
      requiredString(params, 'sessionId'),
      query['confirmCurrent'] === 'true'
    )
    await reply.status(204).send()
  })

  app.post('/api/v1/account/logout', { preHandler: authenticate }, async (request, reply) => {
    await options.accounts.logout(requireIdentity(request))
    await reply.status(204).send()
  })
}
