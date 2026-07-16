import {
  beginAuthorization,
  createPkce,
  createRealGatewayFixture,
  type RealGatewayFixture
} from '../helpers/auth-fixture.js'

describe('authorization code + PKCE contract (T023)', () => {
  let fixture: RealGatewayFixture

  beforeEach(async () => {
    fixture = await createRealGatewayFixture()
  })

  afterEach(async () => {
    await fixture.gateway.close()
  })

  it('binds state, exact loopback redirect and S256 verifier, then consumes the code once', async () => {
    const authorization = await beginAuthorization(fixture, {
      state: 'state-contract-0123456789'
    })
    const login = await fixture.gateway.app.inject({
      method: 'POST',
      url: '/api/v1/oauth/authorize/login',
      payload: {
        authorizationTransactionId: authorization.transactionId,
        identifier: 'admin',
        password: fixture.bootstrap.password
      }
    })
    expect(login.statusCode).toBe(303)
    const redirect = new URL(login.headers.location as string)
    expect(redirect.origin + redirect.pathname).toBe(authorization.redirectUri)
    expect(redirect.searchParams.get('state')).toBe('state-contract-0123456789')
    const code = redirect.searchParams.get('code') as string
    expect(code).toBeTruthy()

    const { verifier } = createPkce()
    const wrongVerifier = await fixture.gateway.app.inject({
      method: 'POST',
      url: '/api/v1/oauth/token',
      payload: {
        grantType: 'authorization_code',
        clientId: 'ai-editor-code',
        code,
        codeVerifier: 'w'.repeat(64),
        redirectUri: authorization.redirectUri,
        device: { name: 'PC', platform: 'windows' }
      }
    })
    expect(wrongVerifier.statusCode).toBe(401)
    expect(wrongVerifier.json().error.code).toBe('invalid_grant')

    const accepted = await fixture.gateway.app.inject({
      method: 'POST',
      url: '/api/v1/oauth/token',
      payload: {
        grantType: 'authorization_code',
        clientId: 'ai-editor-code',
        code,
        codeVerifier: verifier,
        redirectUri: authorization.redirectUri,
        device: { name: 'PC', platform: 'windows' }
      }
    })
    expect(accepted.statusCode).toBe(200)
    expect(accepted.json()).toMatchObject({
      accessTokenExpiresIn: 300,
      refreshTokenExpiresIn: 2_592_000,
      account: {
        role: 'level1',
        mustChangePassword: true,
        mustProvideEmail: true
      }
    })

    const replay = await fixture.gateway.app.inject({
      method: 'POST',
      url: '/api/v1/oauth/token',
      payload: {
        grantType: 'authorization_code',
        clientId: 'ai-editor-code',
        code,
        codeVerifier: verifier,
        redirectUri: authorization.redirectUri,
        device: { name: 'PC', platform: 'windows' }
      }
    })
    expect(replay.statusCode).toBe(401)
    expect(replay.json().error.code).toBe('invalid_grant')
  })

  it('rejects non-loopback callbacks and expired authorization transactions', async () => {
    const { challenge } = createPkce()
    const rejected = await fixture.gateway.app.inject({
      method: 'GET',
      url: `/api/v1/oauth/authorize?${new URLSearchParams({
        client_id: 'ai-editor-code',
        redirect_uri: 'https://evil.example/callback',
        response_type: 'code',
        code_challenge: challenge,
        code_challenge_method: 'S256',
        state: 'state-contract-0123456789'
      })}`
    })
    expect(rejected.statusCode).toBe(400)
    expect(rejected.json().error.code).toBe('invalid_redirect_uri')

    const authorization = await beginAuthorization(fixture)
    fixture.clock.advance(5 * 60_000 + 1)
    const expired = await fixture.gateway.app.inject({
      method: 'POST',
      url: '/api/v1/oauth/authorize/login',
      payload: {
        authorizationTransactionId: authorization.transactionId,
        identifier: 'admin',
        password: fixture.bootstrap.password
      }
    })
    expect(expired.statusCode).toBe(400)
    expect(expired.json().error.code).toBe('authorization_transaction_invalid')
  })

  it('redirects browser login failures with only a safe OAuth code and original state', async () => {
    const authorization = await beginAuthorization(fixture, {
      state: 'state-safe-error-0123456789'
    })
    const rejected = await fixture.gateway.app.inject({
      method: 'POST',
      url: '/api/v1/oauth/authorize/login',
      payload: {
        authorizationTransactionId: authorization.transactionId,
        identifier: 'admin',
        password: 'WrongPassword123'
      }
    })
    expect(rejected.statusCode).toBe(303)
    const redirect = new URL(rejected.headers.location as string)
    expect(redirect.origin + redirect.pathname).toBe(authorization.redirectUri)
    expect(redirect.searchParams.get('error')).toBe('access_denied')
    expect(redirect.searchParams.get('state')).toBe('state-safe-error-0123456789')
    expect(redirect.toString()).not.toMatch(/password|credential|account_disabled/i)
  })
})
