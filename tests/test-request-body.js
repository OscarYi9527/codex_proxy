import './helpers/test-storage-root.js'
import { describe, it } from 'node:test'
import assert from 'node:assert'
import {
  createServer as createHttpServer,
  request as createHttpRequest
} from 'node:http'
import { PassThrough } from 'node:stream'
import { readJson as readStandaloneJson } from '../src/server-utils.js'
import { readJson as readEdgeJson } from '../src/edge/edge-server.js'
import { readBody as readWorkerBody } from '../src/provider-worker/server.js'
import { createServer as createProxyServer } from '../src/server.js'

function streamRequest(headers = {}) {
  const request = new PassThrough()
  request.headers = headers
  return request
}

describe('request body upload safety', () => {
  it('accepts a Codex history above the old 16 MiB ceiling', async () => {
    const body = JSON.stringify({ input: 'x'.repeat(17 * 1024 * 1024) })
    const request = streamRequest({
      'content-length': String(Buffer.byteLength(body))
    })
    const parsed = readStandaloneJson(request)
    request.end(body)
    assert.strictEqual((await parsed).input.length, 17 * 1024 * 1024)
  })

  it('drains chunked standalone and Edge uploads after returning 413', async () => {
    for (const reader of [readStandaloneJson, readEdgeJson]) {
      const request = streamRequest()
      const parsed = reader(request, {
        maxBodyBytes: 1024,
        bodyTimeoutMs: 5_000
      })
      request.write(Buffer.alloc(2 * 1024))
      request.end()
      await assert.rejects(parsed, error =>
        error.statusCode === 413 &&
        (error.type === 'request_too_large' || error.code === 'request_too_large')
      )
      assert.strictEqual(request.readableFlowing, true)
    }
  })

  it('drains Provider Worker uploads after returning a typed 413', async () => {
    const request = streamRequest()
    const body = readWorkerBody(request, {
      maxBodyBytes: 1024,
      bodyTimeoutMs: 5_000
    })
    request.write(Buffer.alloc(2 * 1024))
    request.end()
    await assert.rejects(body, error =>
      error.statusCode === 413 &&
      error.code === 'worker_request_too_large'
    )
    assert.strictEqual(request.readableFlowing, true)
  })

  it('returns explicit upload timeouts instead of waiting for Node defaults', async () => {
    const standalone = streamRequest()
    await assert.rejects(
      readStandaloneJson(standalone, {
        maxBodyBytes: 1024,
        bodyTimeoutMs: 20
      }),
      error => error.statusCode === 408 && error.type === 'request_timeout'
    )
    standalone.destroy()

    const edge = streamRequest()
    await assert.rejects(
      readEdgeJson(edge, {
        maxBodyBytes: 1024,
        bodyTimeoutMs: 20
      }),
      error => error.statusCode === 408 && error.code === 'request_timeout'
    )
    edge.destroy()

    const worker = streamRequest()
    await assert.rejects(
      readWorkerBody(worker, {
        maxBodyBytes: 1024,
        bodyTimeoutMs: 20
      }),
      error => error.statusCode === 408 && error.code === 'worker_request_timeout'
    )
    worker.destroy()
  })

  it('returns an oversized declared body immediately instead of deadlocking', async () => {
    const server = createHttpServer(async (request, response) => {
      try {
        await readStandaloneJson(request, {
          maxBodyBytes: 1024,
          bodyTimeoutMs: 5_000
        })
        response.writeHead(200).end()
      } catch (error) {
        response.writeHead(error.statusCode || 500, {
          'content-type': 'application/json',
          connection: 'close'
        })
        response.end(JSON.stringify({
          type: error.type,
          message: error.message
        }))
      }
    })
    await new Promise((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', resolve)
    })
    try {
      const startedAt = Date.now()
      const response = await fetch(`http://127.0.0.1:${server.address().port}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ input: 'x'.repeat(2 * 1024 * 1024) })
      })
      assert.strictEqual(response.status, 413)
      assert.ok(Date.now() - startedAt < 2_000)
      assert.strictEqual((await response.json()).type, 'request_too_large')
    } finally {
      await new Promise(resolve => server.close(resolve))
    }
  })

  it('maps the standalone Responses boundary to a typed 413 response', async () => {
    const server = createProxyServer()
    await new Promise((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', resolve)
    })
    try {
      const startedAt = Date.now()
      const result = await new Promise((resolve, reject) => {
        const request = createHttpRequest({
          host: '127.0.0.1',
          port: server.address().port,
          path: '/v1/responses',
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'content-length': String(65 * 1024 * 1024)
          }
        }, response => {
          const chunks = []
          response.on('data', chunk => chunks.push(chunk))
          response.once('end', () => resolve({
            statusCode: response.statusCode,
            headers: response.headers,
            body: JSON.parse(Buffer.concat(chunks).toString('utf8'))
          }))
        })
        request.once('error', reject)
        request.flushHeaders()
      })
      assert.strictEqual(result.statusCode, 413)
      assert.strictEqual(result.headers.connection, 'close')
      assert.strictEqual(result.body.error.type, 'request_too_large')
      assert.ok(Date.now() - startedAt < 2_000)
    } finally {
      await new Promise(resolve => server.close(resolve))
    }
  })
})
