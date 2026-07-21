import { describe, it } from 'node:test'
import assert from 'node:assert'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import {
  assertNoSecrets,
  redactSecretText,
  scanTextSecrets,
  scanValueSecrets,
  sensitiveArtifactKind
} from '../src/secret-scan.js'
import {
  scanGitChanges,
  scanUnifiedDiff
} from '../scripts/secret-scan.mjs'
import { safeErrorText } from '../src/logger.js'
import { sendJson } from '../src/server-utils.js'

function opaque(prefix, length = 32) {
  return `${prefix}_${'x'.repeat(length)}`
}

function jwtFixture() {
  return [
    `eyJ${'a'.repeat(16)}`,
    'b'.repeat(24),
    'c'.repeat(32)
  ].join('.')
}

function git(cwd, args) {
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    windowsHide: true
  })
  assert.strictEqual(result.status, 0, result.stderr)
}

describe('全链路 Secret Scanner', () => {
  it('识别 JWT、OAuth、API Key、Authorization、兑换 ID、ticket、nonce 和 Provider payload', () => {
    const jwt = jwtFixture()
    const value = {
      authorization: `Bearer ${jwt}`,
      access_token: opaque('access'),
      refresh_token: opaque('refresh'),
      api_key: `sk-proj-${'k'.repeat(32)}`,
      redeem_request_id: opaque('redeem'),
      oauth_code: opaque('oauth'),
      user_code: opaque('user'),
      webview_ticket: opaque('ticket'),
      edge_nonce: opaque('nonce'),
      secret_payload: opaque('provider')
    }
    const findings = scanValueSecrets(value, { source: 'fixture' })
    const kinds = new Set(findings.map(item => item.kind))
    for (const kind of [
      'authorization',
      'access-token',
      'refresh-token',
      'api-key',
      'redeem-request-id',
      'oauth-authorization-code',
      'oauth-user-code',
      'webview-ticket',
      'edge-nonce',
      'provider-secret-payload'
    ]) {
      assert.ok(kinds.has(kind), `missing ${kind}`)
    }
    const report = JSON.stringify(findings)
    for (const secret of Object.values(value)) {
      assert.ok(!report.includes(secret), 'finding metadata must not echo a secret')
    }
    assert.ok(scanValueSecrets({
      openaiApiKey: opaque('generic')
    }).some(item => item.kind === 'api-key'))
    assert.deepStrictEqual(scanValueSecrets({
      openaiApiKey: 'sk-p***',
      api_key: 'relay***',
      mustChangePassword: false,
      hasAccessToken: true
    }), [])
    const environmentKey = ['OPENAI', 'API', 'KEY'].join('_')
    assert.ok(scanTextSecrets(
      `${environmentKey}=${opaque('environment')}`
    ).some(item => item.kind === 'api-key'))
  })

  it('允许受保护信封和 digest，但拒绝错误对象中的裸秘密', () => {
    const envelope = JSON.stringify({
      version: 1,
      algorithm: 'AES-256-GCM',
      key_id: 'provider-key-test',
      nonce: Buffer.alloc(12, 1).toString('base64'),
      ciphertext: Buffer.alloc(24, 2).toString('base64'),
      tag: Buffer.alloc(16, 3).toString('base64')
    })
    assert.deepStrictEqual(scanValueSecrets({
      secret_payload: envelope,
      refresh_token_digest: 'a'.repeat(64)
    }, {
      source: 'database',
      allowProtectedValues: true
    }), [])
    const protectedAccessToken = `dpapi-aesgcm:v1:${[
      Buffer.alloc(12, 4).toString('base64'),
      Buffer.alloc(16, 5).toString('base64'),
      Buffer.alloc(24, 6).toString('base64')
    ].join(':')}`
    assert.ok(scanValueSecrets({
      access_token: protectedAccessToken,
      secret_payload: { encrypted: true }
    }).length >= 2)
    assert.deepStrictEqual(scanValueSecrets({
      access_token: protectedAccessToken
    }, {
      allowProtectedValues: true
    }), [])

    const jwt = jwtFixture()
    const error = new Error(`upstream failed with Bearer ${jwt}`)
    assert.throws(
      () => assertNoSecrets({ error }, { source: 'error-object' }),
      /Secret scan rejected/
    )
    const safe = safeErrorText(error)
    assert.ok(!safe.includes(jwt))
    assert.match(safe, /Bearer \[REDACTED\]/)
    const keyFindings = scanValueSecrets({ [jwt]: true })
    assert.ok(keyFindings.some(item => item.kind === 'jwt'))
    assert.ok(!JSON.stringify(keyFindings).includes(jwt))
  })

  it('扫描 unified diff 的新增行且报告不包含原文', () => {
    const token = `sk-proj-${'d'.repeat(32)}`
    const diff = [
      'diff --git a/config.js b/config.js',
      '--- a/config.js',
      '+++ b/config.js',
      '@@ -0,0 +1 @@',
      `+const configured = "${token}"`,
      ''
    ].join('\n')
    const findings = scanUnifiedDiff(diff)
    assert.strictEqual(findings[0].path, 'config.js')
    assert.strictEqual(findings[0].line, 1)
    assert.strictEqual(findings[0].kind, 'openai-api-key')
    assert.ok(!JSON.stringify(findings).includes(token))

    const field = ['access', 'token'].join('_')
    const opaqueToken = opaque('multiline')
    const privateKeyHeader = ['-----BEGIN', 'PRIVATE KEY-----'].join(' ')
    const multilineDiff = [
      'diff --git a/config.json b/config.json',
      '--- a/config.json',
      '+++ b/config.json',
      '@@ -0,0 +1,4 @@',
      '+{',
      `+  "${field}":`,
      `+  "${opaqueToken}",`,
      `+  "${privateKeyHeader}": true`,
      ''
    ].join('\n')
    const multilineFindings = scanUnifiedDiff(multilineDiff)
    assert.ok(multilineFindings.some(item => item.kind === 'access-token'))
    assert.ok(multilineFindings.some(item => item.kind === 'private-key'))
    assert.ok(!JSON.stringify(multilineFindings).includes(opaqueToken))
  })

  it('真实拦截 Git staged secret 和敏感运行文件', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-secret-git-'))
    try {
      git(root, ['init'])
      git(root, ['config', 'user.email', 'test@example.invalid'])
      git(root, ['config', 'user.name', 'Secret Scan Test'])
      fs.writeFileSync(path.join(root, 'README.md'), '# safe\n')
      git(root, ['add', 'README.md'])
      git(root, ['commit', '-m', 'baseline'])

      const token = jwtFixture()
      fs.writeFileSync(path.join(root, 'unsafe.txt'), `Bearer ${token}\n`)
      fs.writeFileSync(path.join(root, '.env'), 'SAFE=false\n')
      git(root, ['add', 'unsafe.txt', '.env'])

      const report = scanGitChanges({ cwd: root, mode: 'staged' })
      assert.ok(report.findings.some(item => item.kind === 'jwt'))
      assert.ok(report.findings.some(item => item.kind === 'sensitive-config-artifact'))
      assert.ok(!JSON.stringify(report).includes(token))
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('阻止 standalone 管理 API 返回未知字段中的秘密', () => {
    const jwt = jwtFixture()
    const response = {
      status: 0,
      body: '',
      secretScanResponse: true,
      proxyMeta: {},
      writeHead(status) {
        this.status = status
      },
      end(body) {
        this.body = String(body)
      }
    }
    sendJson(response, 200, { diagnosticNote: `unexpected ${jwt}` })
    assert.strictEqual(response.status, 500)
    assert.ok(!response.body.includes(jwt))
    assert.match(response.body, /secret_scan_blocked/)
  })

  it('分类敏感制品路径但允许示例环境文件', () => {
    assert.strictEqual(sensitiveArtifactKind('.env.example'), null)
    assert.strictEqual(sensitiveArtifactKind('.env'), 'sensitive-config-artifact')
    assert.strictEqual(
      sensitiveArtifactKind('runtime/gateway.sqlite'),
      'sensitive-binary-or-log-artifact'
    )
    assert.strictEqual(scanTextSecrets('normal source text').length, 0)
    assert.ok(redactSecretText(`Bearer ${jwtFixture()}`).includes('[REDACTED]'))
  })
})
