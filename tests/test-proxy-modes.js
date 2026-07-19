import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { parseProxyMode, PROXY_MODES } from '../src/mode.js'
import { loadEdgeConfig } from '../src/edge/edge-config.js'

describe('Proxy standalone/edge/gateway/provider-worker modes', () => {
  it('keeps standalone as the compatibility default', () => {
    assert.equal(parseProxyMode({ argv: [], env: {} }), 'standalone')
    assert.deepEqual(PROXY_MODES, ['standalone', 'edge', 'gateway', 'provider-worker'])
  })

  it('accepts explicit CLI and environment selection', () => {
    assert.equal(parseProxyMode({ argv: ['--mode', 'edge'], env: {} }), 'edge')
    assert.equal(parseProxyMode({ argv: ['--mode=gateway'], env: {} }), 'gateway')
    assert.equal(
      parseProxyMode({ argv: ['--mode=provider-worker'], env: {} }),
      'provider-worker'
    )
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
    }, { repositoryRoot }), /47921/)
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

  it('uses the product loopback port and HTTPS Gateway in production', () => {
    const repositoryRoot = path.resolve('F:/isolated-repository')
    const config = loadEdgeConfig({
      NODE_ENV: 'production',
      AI_EDITOR_EDGE_LOCAL_NONCE: 'test-local-nonce-at-least-32-bytes',
      AI_EDITOR_EDGE_DATA_ROOT: path.resolve('F:/ai-editor-product-edge'),
      AI_EDITOR_GATEWAY_ORIGIN: 'https://gateway.ai-editor.example'
    }, { repositoryRoot })

    assert.equal(config.host, '127.0.0.1')
    assert.equal(config.port, 47892)
    assert.equal(config.gatewayOrigin, 'https://gateway.ai-editor.example')
    assert.equal(config.authMode, 'real')
    assert.equal(config.environment, 'production')
    assert.throws(() => loadEdgeConfig({
      NODE_ENV: 'production',
      AI_EDITOR_EDGE_AUTH_MODE: 'mock',
      AI_EDITOR_EDGE_LOCAL_NONCE: 'test-local-nonce-at-least-32-bytes',
      AI_EDITOR_EDGE_DATA_ROOT: path.resolve('F:/ai-editor-product-edge'),
      AI_EDITOR_GATEWAY_ORIGIN: 'https://gateway.ai-editor.example'
    }, { repositoryRoot }), /Mock authentication is forbidden/)
  })
})
