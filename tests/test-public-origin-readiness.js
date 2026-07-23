import { describe, it } from 'node:test'
import assert from 'node:assert'
import {
  inspectPublicOrigin,
  validatePublicOrigin
} from '../scripts/check-public-origin.mjs'

const origin = 'https://gateway.torvye.com'
const expectedHostname = 'gateway.torvye.com'
const now = new Date('2026-07-23T00:00:00.000Z')

function passingProbes(overrides = {}) {
  return {
    dns: async () => ({
      addresses: ['203.1.1.20', '2001:4860:4860::8888'],
      cnames: []
    }),
    tls: async () => ({
      authorized: true,
      protocol: 'TLSv1.3',
      validTo: '2026-10-23T00:00:00.000Z'
    }),
    live: async () => ({
      statusCode: 200,
      contentType: 'application/json; charset=utf-8',
      body: {
        status: 'ok',
        service: 'ai-editor-gateway',
        mode: 'gateway'
      }
    }),
    ...overrides
  }
}

describe('public Gateway origin preflight', () => {
  it('accepts only the frozen stable HTTPS origin', () => {
    assert.strictEqual(validatePublicOrigin(origin, expectedHostname).valid, true)
    for (const candidate of [
      'http://gateway.torvye.com',
      'https://gateway.torvye.com:8443',
      'https://gateway.torvye.com/admin',
      'https://gateway.torvye.com?ticket=secret',
      'https://127.0.0.1',
      'https://temporary.trycloudflare.com',
      'https://worker.torvye.com'
    ]) {
      assert.strictEqual(
        validatePublicOrigin(candidate, expectedHostname).valid,
        false,
        candidate
      )
    }
  })

  it('passes routable DNS, authorized TLS and a healthy /live endpoint', async () => {
    const report = await inspectPublicOrigin(
      { origin, expectedHostname, now },
      passingProbes()
    )
    assert.strictEqual(report.result, 'PASS')
    assert.deepStrictEqual(report.summary, {
      pass: 3,
      blocked: 0,
      fail: 0,
      total: 3
    })
  })

  it('keeps an unconfigured or fake-IP DNS record blocked', async () => {
    const report = await inspectPublicOrigin(
      { origin, expectedHostname, now },
      passingProbes({
        dns: async () => ({
          addresses: ['198.18.0.26'],
          cnames: []
        })
      })
    )
    assert.strictEqual(report.result, 'BLOCKED')
    assert.strictEqual(
      report.checks.find(check => check.id === 'origin.dns')?.result,
      'BLOCKED'
    )
  })

  it('reports DNS/TLS/network provisioning gaps as blocked without leaking errors', async () => {
    const networkError = Object.assign(
      new Error('connect failed with a sensitive local path'),
      { code: 'ENOTFOUND' }
    )
    const report = await inspectPublicOrigin(
      { origin, expectedHostname, now },
      passingProbes({
        dns: async () => { throw networkError },
        tls: async () => { throw networkError },
        live: async () => { throw networkError }
      })
    )
    assert.strictEqual(report.result, 'BLOCKED')
    assert.strictEqual(report.summary.blocked, 3)
    assert.ok(JSON.stringify(report).includes('ENOTFOUND'))
    assert.ok(!JSON.stringify(report).includes('sensitive local path'))
  })

  it('fails closed when an authorized HTTPS endpoint is not the Gateway /live service', async () => {
    const report = await inspectPublicOrigin(
      { origin, expectedHostname, now },
      passingProbes({
        live: async () => ({
          statusCode: 200,
          contentType: 'text/html',
          body: undefined
        })
      })
    )
    assert.strictEqual(report.result, 'FAIL')
    assert.strictEqual(
      report.checks.find(check => check.id === 'origin.live')?.result,
      'FAIL'
    )
  })
})
