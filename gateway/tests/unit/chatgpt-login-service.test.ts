import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ProcessChatgptLoginService } from '../../src/providers/chatgpt-login-service.js'
import { SequenceIdSource } from '../../src/common/ids.js'

describe('isolated Codex app-server login adapter (T086)', () => {
  let root: string
  let previousCodexCliJs: string | undefined
  let previousFakeAuthUrl: string | undefined

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-editor-chatgpt-login-'))
    previousCodexCliJs = process.env['CODEX_CLI_JS']
    previousFakeAuthUrl = process.env['FAKE_CODEX_AUTH_URL']
    const fakeCli = path.join(root, 'fake-codex.mjs')
    fs.writeFileSync(fakeCli, `
      import fs from 'node:fs'
      import path from 'node:path'
      import readline from 'node:readline'
      if (process.argv.includes('--version')) {
        console.log('codex-cli 99.0.0-test')
        process.exit(0)
      }
      if (process.argv.includes('--help')) {
        console.log('app-server test help')
        process.exit(0)
      }
      const lines = readline.createInterface({ input: process.stdin })
      lines.on('line', line => {
        const message = JSON.parse(line)
        if (message.id === 1) {
          console.log(JSON.stringify({ id: 1, result: {} }))
        }
        if (message.id === 2) {
          fs.writeFileSync(path.join(process.env.CODEX_HOME, 'auth.json'), JSON.stringify({
            tokens: {
              access_token: 'isolated-access-secret',
              refresh_token: 'isolated-refresh-secret',
              account_id: 'isolated-account'
            }
          }))
          console.log(JSON.stringify({
            id: 2,
            result: {
              loginId: 'login_test',
              authUrl: process.env.FAKE_CODEX_AUTH_URL || 'https://auth.openai.com/authorize'
            }
          }))
          setTimeout(() => console.log(JSON.stringify({
            method: 'account/login/completed',
            params: { loginId: 'login_test', success: true }
          })), 20)
        }
      })
    `, { encoding: 'utf8', mode: 0o700 })
    process.env['CODEX_CLI_JS'] = fakeCli
  })

  afterEach(() => {
    if (previousCodexCliJs === undefined) delete process.env['CODEX_CLI_JS']
    else process.env['CODEX_CLI_JS'] = previousCodexCliJs
    if (previousFakeAuthUrl === undefined) delete process.env['FAKE_CODEX_AUTH_URL']
    else process.env['FAKE_CODEX_AUTH_URL'] = previousFakeAuthUrl
    // Windows can retain the just-exited fake app-server directory handle for
    // a few milliseconds. Retry cleanup so the release gate does not fail
    // after the service has already closed its child successfully.
    fs.rmSync(root, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 50
    })
  })

  it('returns only safe status and imports auth.json before deleting the temp home', async () => {
    const service = new ProcessChatgptLoginService(root, new SequenceIdSource())
    let imported: string | undefined
    const started = await service.start('provider_test', async authJson => {
      imported = authJson
    })
    expect(started).toMatchObject({
      status: 'waiting',
      codexVersion: 'codex-cli 99.0.0-test'
    })
    expect(JSON.stringify(started)).not.toMatch(/access-secret|refresh-secret/)

    const deadline = Date.now() + 5000
    while (service.status('provider_test').status === 'waiting' && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 25))
    }
    expect(service.status('provider_test')).toMatchObject({
      status: 'success',
      verificationUrl: 'https://auth.openai.com/authorize'
    })
    expect(imported).toContain('isolated-access-secret')
    expect(fs.existsSync(path.join(root, '.oauth-login'))).toBe(true)
    expect(fs.readdirSync(path.join(root, '.oauth-login'))).toEqual([])

    process.env['FAKE_CODEX_AUTH_URL'] = 'https://evil.example.test/authorize'
    const rejected = await service.start('provider_evil', async () => {
      throw new Error('An untrusted login URL must never import credentials')
    })
    expect(rejected.status).toBe('waiting')
    const secondDeadline = Date.now() + 5000
    while (service.status('provider_evil').status === 'waiting' &&
      Date.now() < secondDeadline) {
      await new Promise(resolve => setTimeout(resolve, 25))
    }
    expect(service.status('provider_evil')).toMatchObject({
      status: 'error',
      verificationUrl: null
    })
    await service.close()
  })
})
