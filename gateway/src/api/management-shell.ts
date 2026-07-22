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

const FULL_CONSOLE_CSP = MANAGEMENT_CSP.replace(
  "style-src 'self'",
  "style-src 'self' 'unsafe-inline'"
)

function secureManagementReply(reply: FastifyReply): FastifyReply {
  return reply
    .header('Content-Security-Policy', MANAGEMENT_CSP)
    .header('Referrer-Policy', 'no-referrer')
    .header('X-Content-Type-Options', 'nosniff')
    .header('X-Frame-Options', 'DENY')
    .header('Cross-Origin-Resource-Policy', 'same-origin')
}

function secureFullConsoleReply(reply: FastifyReply): FastifyReply {
  return secureManagementReply(reply)
    .header('Content-Security-Policy', FULL_CONSOLE_CSP)
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
  const moduleRoot = path.dirname(fileURLToPath(import.meta.url))
  const distRoot = path.resolve(
    moduleRoot,
    '..',
    '..',
    'admin-web',
    'dist'
  )
  const indexFile = path.join(distRoot, 'index.html')
  const sharedAdminRoot = path.resolve(moduleRoot, '..', '..', '..', 'src')
  const fullConsoleIndex = path.join(sharedAdminRoot, 'admin.html')
  const fullConsoleScripts = [
    path.join(sharedAdminRoot, 'admin_ui_behaviors.cjs'),
    path.join(sharedAdminRoot, 'admin_modules', 'accounts.js'),
    path.join(sharedAdminRoot, 'admin_modules', 'tutorial.js'),
    path.join(sharedAdminRoot, 'admin_modules', 'analytics.js'),
    path.join(sharedAdminRoot, 'admin_modules', 'settings.js'),
    path.join(sharedAdminRoot, 'admin_app.js')
  ]

  const index = async (_request: unknown, reply: FastifyReply) => {
    if (!fs.existsSync(indexFile)) throw unavailable()
    await secureManagementReply(reply)
      .header('Cache-Control', 'no-store')
      .type('text/html; charset=utf-8')
      .send(fs.createReadStream(indexFile))
  }
  app.get('/admin', index)
  app.get('/admin/', index)

  const fullConsole = async (_request: unknown, reply: FastifyReply) => {
    if (!fs.existsSync(fullConsoleIndex)) throw unavailable()
    // The shared standalone console uses one inline stylesheet and bounded
    // dynamic style attributes for quota/health visualization. Scripts remain
    // external-only; inline script execution is never enabled.
    await secureFullConsoleReply(reply)
      .header('Cache-Control', 'no-store')
      .type('text/html; charset=utf-8')
      .send(fs.createReadStream(fullConsoleIndex))
  }
  app.get('/admin/full', fullConsole)
  app.get('/admin/full/', fullConsole)

  app.get('/admin/runtime.js', async (_request, reply) => {
    await secureManagementReply(reply)
      .header('Cache-Control', 'no-store')
      .type('text/javascript; charset=utf-8')
      .send(
        'window.__TORVYE_MANAGEMENT__=Object.freeze({' +
        'mode:"gateway",surface:"browser",apiBase:"/admin/api"});'
      )
  })

  app.get('/admin/app.js', async (_request, reply) => {
    if (fullConsoleScripts.some(file => !fs.existsSync(file))) throw unavailable()
    await secureManagementReply(reply)
      .header('Cache-Control', 'no-store')
      .type('text/javascript; charset=utf-8')
      .send(fullConsoleScripts.map(file => fs.readFileSync(file, 'utf8')).join('\n;\n'))
  })

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
