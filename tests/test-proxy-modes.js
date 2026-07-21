import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { parseProxyMode, PROXY_MODES } from '../src/mode.js'
import { loadEdgeConfig } from '../src/edge/edge-config.js'

describe('Proxy standalone/edge/gateway modes', () => {
  it('keeps standalone as the compatibility default', () => {
    assert.equal(parseProxyMode({ argv: [], env: {} }), 'standalone')
    assert.deepEqual(PROXY_MODES, ['standalone', 'edge', 'gateway'])
  })

  it('accepts explicit CLI and environment selection', () => {
    assert.equal(parseProxyMode({ argv: ['--mode', 'edge'], env: {} }), 'edge')
    assert.equal(parseProxyMode({ argv: ['--mode=gateway'], env: {} }), 'gateway')
    assert.equal(parseProxyMode({ argv: [], env: { CODEX_PROXY_MODE: 'edge' } }), 'edge')
    assert.throws(() => parseProxyMode({ argv: ['--mode', 'invalid'], env: {} }), /Unsupported/)
  })

  it('isolates Edge port, Gateway origin, and data root from standalone', () => {
    const repositoryRoot = path.resolve('F:/isolated-repository')
    const env = { AI_EDITOR_EDGE_LOCAL_NONCE: 'test-local-nonce-at-least-32-bytes' }
    const config = loadEdgeConfig(env, { repositoryRoot })
    assert.equal(config.host, '127.0.0.1')
    assert.equal(config.port, 47921)
    assert.equal(config.gatewayOrigin, 'http://127.0.0.1:47920')
    assert.ok(config.dataRoot.startsWith(path.join(repositoryRoot, '.ai-editor-dev')))
    assert.throws(() => loadEdgeConfig({
      ...env,
      AI_EDITOR_EDGE_PORT: '47892'
    }, { repositoryRoot }), /47892|Invalid isolated/)
    assert.throws(() => loadEdgeConfig({
      ...env,
      AI_EDITOR_EDGE_PORT: '47922'
    }, { repositoryRoot }), /47921/)
    assert.throws(() => loadEdgeConfig({
      ...env,
      AI_EDITOR_EDGE_DATA_ROOT: path.resolve('F:/shared-runtime')
    }, { repositoryRoot }), /must be under/)
    assert.throws(() => loadEdgeConfig({}, { repositoryRoot }), /LOCAL_NONCE/)
  })

  it('fails closed when Edge inherits disabled TLS certificate verification', () => {
    const repositoryRoot = path.resolve('F:/isolated-repository')
    assert.throws(() => loadEdgeConfig({
      NODE_ENV: 'production',
      NODE_TLS_REJECT_UNAUTHORIZED: '0'
    }, { repositoryRoot }), /TLS certificate verification is disabled/)
    assert.throws(() => loadEdgeConfig({
      NODE_TLS_REJECT_UNAUTHORIZED: '0'
    }, { repositoryRoot }), /NODE_EXTRA_CA_CERTS/)
    assert.doesNotThrow(() => loadEdgeConfig({
      NODE_TLS_REJECT_UNAUTHORIZED: '1',
      NODE_EXTRA_CA_CERTS: path.join(repositoryRoot, 'development-ca.pem'),
      AI_EDITOR_EDGE_LOCAL_NONCE: 'test-local-nonce-at-least-32-bytes'
    }, { repositoryRoot }))
  })
})
