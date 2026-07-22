import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ProcessChatgptLoginService } from '../../src/providers/chatgpt-login-service.js'
import { SequenceIdSource } from '../../src/common/ids.js'

describe('isolated Codex device-auth login adapter (T086)', () => {
  let root: string
  let previousCodexCliJs: string | undefined
  let previousFakeAuthUrl: string | undefined
  let previousFakeExitCode: string | undefined
  let previousLoginProxy: string | undefined

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-editor-chatgpt-login-'))
    previousCodexCliJs = process.env['CODEX_CLI_JS']
    previousFakeAuthUrl = process.env['FAKE_CODEX_AUTH_URL']
    previousFakeExitCode = process.env['FAKE_CODEX_EXIT_CODE']
    previousLoginProxy = process.env['AI_EDITOR_CHATGPT_LOGIN_HTTPS_PROXY']
    const fakeCli = path.join(root, 'fake-codex.mjs')
    fs.writeFileSync(fakeCli, `
      import fs from 'node:fs'
      import path from 'node:path'
      if (process.argv.includes('--version')) {
        console.log('codex-cli 99.0.0-test')
        process.exit(0)
      }
      if (process.argv.includes('--help')) {
        console.log('app-server test help')
        process.exit(0)
      }
      if (process.argv.includes('--device-auth')) {
        console.log(process.env.FAKE_CODEX_AUTH_URL || 'https://auth.openai.com/codex/device')
        console.log('ABCD-EFGHI')
        setTimeout(() => {
          fs.writeFileSync(path.join(process.env.CODEX_HOME, 'login-environment.json'), JSON.stringify({
            httpsProxy: process.env.HTTPS_PROXY || null,
            noProxy: process.env.NO_PROXY || null
          }))
          fs.writeFileSync(path.join(process.env.CODEX_HOME, 'auth.json'), JSON.stringify({
            tokens: {
              access_token: 'isolated-access-secret',
              refresh_token: 'isolated-refresh-secret',
              account_id: 'isolated-account'
            }
          }))
          process.exit(Number(process.env.FAKE_CODEX_EXIT_CODE || 0))
        }, 20)
      }
    `, { encoding: 'utf8', mode: 0o700 })
    process.env['CODEX_CLI_JS'] = fakeCli
  })

  afterEach(() => {
    if (previousCodexCliJs === undefined) delete process.env['CODEX_CLI_JS']
    else process.env['CODEX_CLI_JS'] = previousCodexCliJs
    if (previousFakeAuthUrl === undefined) delete process.env['FAKE_CODEX_AUTH_URL']
    else process.env['FAKE_CODEX_AUTH_URL'] = previousFakeAuthUrl
    if (previousFakeExitCode === undefined) delete process.env['FAKE_CODEX_EXIT_CODE']
    else process.env['FAKE_CODEX_EXIT_CODE'] = previousFakeExitCode
    if (previousLoginProxy === undefined) {
      delete process.env['AI_EDITOR_CHATGPT_LOGIN_HTTPS_PROXY']
    } else {
      process.env['AI_EDITOR_CHATGPT_LOGIN_HTTPS_PROXY'] = previousLoginProxy
    }
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
      verificationUrl: 'https://auth.openai.com/codex/device',
      userCode: 'ABCD-EFGHI'
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
  }, 15_000)

  it('imports a valid isolated auth.json even when Codex exits with code 1', async () => {
    process.env['FAKE_CODEX_EXIT_CODE'] = '1'
    process.env['AI_EDITOR_CHATGPT_LOGIN_HTTPS_PROXY'] = 'http://127.0.0.1:7891'
    const service = new ProcessChatgptLoginService(root, new SequenceIdSource())
    let imported: string | undefined
    let loginEnvironment: { httpsProxy: string | null; noProxy: string | null } | undefined

    await service.start('provider_exit_one', async authJson => {
      imported = authJson
      const sessionDirectory = fs.readdirSync(path.join(root, '.oauth-login'))[0]
      loginEnvironment = JSON.parse(fs.readFileSync(
        path.join(root, '.oauth-login', sessionDirectory, 'login-environment.json'),
        'utf8'
      )) as typeof loginEnvironment
    })
    const deadline = Date.now() + 5000
    while (service.status('provider_exit_one').status === 'waiting' &&
      Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 25))
    }

    expect(service.status('provider_exit_one')).toMatchObject({
      status: 'success',
      message: 'OpenAI 官方登录成功，订阅账号已加入账号池。'
    })
    expect(imported).toContain('isolated-access-secret')
    expect(loginEnvironment).toEqual({
      httpsProxy: 'http://127.0.0.1:7891',
      noProxy: expect.stringContaining('127.0.0.1')
    })
    expect(JSON.stringify(service.status('provider_exit_one')))
      .not.toMatch(/access-secret|refresh-secret|127\.0\.0\.1:7891/)
  })
})
