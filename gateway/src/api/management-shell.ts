import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { FastifyInstance, FastifyReply } from 'fastify'
import { SafeError } from '../common/errors.js'

const MANAGEMENT_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "connect-src 'self'",
  "img-src 'self' data:",
  "font-src 'self'",
  "frame-src 'none'",
  "form-action 'self'",
  "base-uri 'none'",
  "object-src 'none'"
].join('; ')

function secureManagementReply(reply: FastifyReply): FastifyReply {
  return reply
    .header('Content-Security-Policy', MANAGEMENT_CSP)
    .header('Referrer-Policy', 'no-referrer')
    .header('X-Content-Type-Options', 'nosniff')
    .header('X-Frame-Options', 'DENY')
    .header('Cross-Origin-Resource-Policy', 'same-origin')
}

function unavailable(): SafeError {
  return new SafeError({
    code: 'management_shell_unavailable',
    message: 'AI Editor 管理页面尚未构建。',
    statusCode: 503,
    retryable: true
  })
}

export function registerManagementShell(app: FastifyInstance): void {
  const distRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '..',
    '..',
    'admin-web',
    'dist'
  )
  const indexFile = path.join(distRoot, 'index.html')

  const index = async (_request: unknown, reply: FastifyReply) => {
    if (!fs.existsSync(indexFile)) throw unavailable()
    await secureManagementReply(reply)
      .header('Cache-Control', 'no-store')
      .type('text/html; charset=utf-8')
      .send(fs.createReadStream(indexFile))
  }
  app.get('/admin', index)
  app.get('/admin/', index)

  app.get('/admin/assets/:asset', async (request, reply) => {
    const asset = (request.params as { asset?: string }).asset || ''
    if (!/^[A-Za-z0-9._-]+\.(?:js|css)$/.test(asset)) {
      throw new SafeError({
        code: 'not_found',
        message: '未找到管理页面资源。',
        statusCode: 404
      })
    }
    const file = path.join(distRoot, 'assets', asset)
    if (!fs.existsSync(file)) throw unavailable()
    const type = asset.endsWith('.js')
      ? 'text/javascript; charset=utf-8'
      : 'text/css; charset=utf-8'
    await secureManagementReply(reply)
      .header('Cache-Control', 'public, max-age=31536000, immutable')
      .type(type)
      .send(fs.createReadStream(file))
  })
}
