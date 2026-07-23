import dns from 'node:dns/promises'
import fs from 'node:fs'
import https from 'node:https'
import path from 'node:path'
import tls from 'node:tls'
import { fileURLToPath } from 'node:url'

const DEFAULT_TIMEOUT_MS = 10_000
const MAX_RESPONSE_BYTES = 64 * 1024

export function validatePublicOrigin(value, expectedHostname) {
  if (typeof value !== 'string') {
    return { valid: false, detail: 'The public origin must be a string.' }
  }
  try {
    const url = new URL(value)
    const valid =
      url.protocol === 'https:' &&
      url.origin === value &&
      url.pathname === '/' &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      url.port === '' &&
      !isIpLiteral(url.hostname) &&
      url.hostname !== 'localhost' &&
      !url.hostname.endsWith('.localhost') &&
      !url.hostname.endsWith('.trycloudflare.com') &&
      (!expectedHostname || url.hostname === expectedHostname)
    return valid
      ? { valid: true, url }
      : {
          valid: false,
          detail: expectedHostname
            ? `The public origin must be exactly https://${expectedHostname}.`
            : 'The public origin must be a stable HTTPS origin without credentials, port, path, query or fragment.'
        }
  } catch {
    return { valid: false, detail: 'The public origin is not a valid URL.' }
  }
}

export async function inspectPublicOrigin(
  {
    origin,
    expectedHostname = '',
    timeoutMs = DEFAULT_TIMEOUT_MS,
    now = new Date()
  },
  probes = defaultProbes
) {
  const checks = []
  const add = (id, category, result, detail, evidence = undefined) => {
    checks.push({ id, category, result, detail, ...(evidence ? { evidence } : {}) })
  }

  const validated = validatePublicOrigin(origin, expectedHostname)
  if (!validated.valid) {
    add('origin.format', 'configuration', 'FAIL', validated.detail)
    return buildReport(origin, expectedHostname, checks)
  }

  const hostname = validated.url.hostname
  try {
    const records = await probes.dns(hostname)
    const publicAddresses = records.addresses.filter(isPublicAddress)
    if (publicAddresses.length === 0) {
      add(
        'origin.dns',
        'dns',
        'BLOCKED',
        'Public DNS has no routable A/AAAA answer yet.',
        { cnames: records.cnames }
      )
    } else {
      add(
        'origin.dns',
        'dns',
        'PASS',
        'Public DNS resolves to at least one routable address.',
        {
          addressFamilies: [...new Set(publicAddresses.map(address => address.includes(':') ? 'IPv6' : 'IPv4'))],
          cnames: records.cnames
        }
      )
    }
  } catch (error) {
    add('origin.dns', 'dns', 'BLOCKED', safeError('Public DNS is not ready.', error))
  }

  let tlsResult
  try {
    tlsResult = await probes.tls(hostname, timeoutMs)
    const expiresAt = new Date(tlsResult.validTo)
    const remainingDays = Math.floor((expiresAt.getTime() - now.getTime()) / 86_400_000)
    if (!tlsResult.authorized) {
      add('origin.tls', 'tls', 'FAIL', 'TLS did not pass certificate authorization.')
    } else if (!Number.isFinite(remainingDays) || remainingDays < 14) {
      add('origin.tls', 'tls', 'FAIL', 'TLS certificate has less than 14 days of validity remaining.')
    } else {
      add(
        'origin.tls',
        'tls',
        'PASS',
        'TLS certificate and hostname verification passed.',
        {
          protocol: tlsResult.protocol,
          validTo: expiresAt.toISOString(),
          remainingDays
        }
      )
    }
  } catch (error) {
    add('origin.tls', 'tls', 'BLOCKED', safeError('TLS endpoint is not ready.', error))
  }

  try {
    const live = await probes.live(new URL('/live', validated.url), timeoutMs)
    if (
      live.statusCode !== 200 ||
      !String(live.contentType).toLowerCase().includes('application/json') ||
      live.body?.status !== 'ok'
    ) {
      add(
        'origin.live',
        'gateway',
        tlsResult?.authorized ? 'FAIL' : 'BLOCKED',
        'The HTTPS /live endpoint did not return HTTP 200 JSON with status=ok.',
        {
          statusCode: live.statusCode,
          contentType: live.contentType
        }
      )
    } else {
      add(
        'origin.live',
        'gateway',
        'PASS',
        'The public Gateway /live endpoint is healthy.',
        {
          statusCode: live.statusCode,
          service: typeof live.body.service === 'string' ? live.body.service : undefined,
          mode: typeof live.body.mode === 'string' ? live.body.mode : undefined
        }
      )
    }
  } catch (error) {
    add('origin.live', 'gateway', 'BLOCKED', safeError('The public Gateway /live endpoint is not ready.', error))
  }

  return buildReport(origin, expectedHostname, checks)
}

const defaultProbes = {
  async dns(hostname) {
    const addresses = []
    const cnames = []
    for (const resolve of [
      () => dns.resolve4(hostname),
      () => dns.resolve6(hostname)
    ]) {
      try {
        addresses.push(...await resolve())
      } catch (error) {
        if (!isMissingDnsAnswer(error)) throw error
      }
    }
    try {
      cnames.push(...await dns.resolveCname(hostname))
    } catch (error) {
      if (!isMissingDnsAnswer(error)) throw error
    }
    return { addresses, cnames }
  },

  tls(hostname, timeoutMs) {
    return new Promise((resolve, reject) => {
      const socket = tls.connect({
        host: hostname,
        port: 443,
        servername: hostname,
        rejectUnauthorized: true
      })
      socket.setTimeout(timeoutMs)
      socket.once('secureConnect', () => {
        const certificate = socket.getPeerCertificate()
        const result = {
          authorized: socket.authorized,
          protocol: socket.getProtocol(),
          validTo: certificate.valid_to
        }
        socket.end()
        resolve(result)
      })
      socket.once('timeout', () => socket.destroy(new Error('TLS connection timed out.')))
      socket.once('error', reject)
    })
  },

  live(url, timeoutMs) {
    return new Promise((resolve, reject) => {
      const request = https.get(url, {
        timeout: timeoutMs,
        headers: {
          accept: 'application/json',
          'user-agent': 'torvye-production-origin-preflight/1'
        }
      }, response => {
        const chunks = []
        let length = 0
        response.on('data', chunk => {
          length += chunk.length
          if (length <= MAX_RESPONSE_BYTES) chunks.push(chunk)
        })
        response.on('end', () => {
          if (length > MAX_RESPONSE_BYTES) {
            reject(new Error('Gateway /live response exceeded 64 KiB.'))
            return
          }
          const text = Buffer.concat(chunks).toString('utf8')
          let body
          try {
            body = JSON.parse(text)
          } catch {
            body = undefined
          }
          resolve({
            statusCode: response.statusCode ?? 0,
            contentType: response.headers['content-type'] ?? '',
            body
          })
        })
      })
      request.once('timeout', () => request.destroy(new Error('Gateway /live request timed out.')))
      request.once('error', reject)
    })
  }
}

function buildReport(origin, expectedHostname, checks) {
  const fail = checks.filter(check => check.result === 'FAIL').length
  const blocked = checks.filter(check => check.result === 'BLOCKED').length
  const result = fail > 0 ? 'FAIL' : blocked > 0 ? 'BLOCKED' : 'PASS'
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    result,
    origin,
    expectedHostname: expectedHostname || undefined,
    summary: {
      pass: checks.filter(check => check.result === 'PASS').length,
      blocked,
      fail,
      total: checks.length
    },
    checks
  }
}

function isMissingDnsAnswer(error) {
  return ['ENODATA', 'ENOTFOUND', 'ESERVFAIL', 'ETIMEOUT', 'EREFUSED'].includes(error?.code)
}

function isIpLiteral(hostname) {
  return /^\d{1,3}(?:\.\d{1,3}){3}$/.test(hostname) || hostname.includes(':')
}

function isPublicAddress(address) {
  if (address.includes(':')) {
    const normalized = address.toLowerCase()
    return normalized !== '::1' &&
      normalized !== '::' &&
      !normalized.startsWith('fc') &&
      !normalized.startsWith('fd') &&
      !normalized.startsWith('fe8') &&
      !normalized.startsWith('fe9') &&
      !normalized.startsWith('fea') &&
      !normalized.startsWith('feb') &&
      !normalized.startsWith('2001:db8:')
  }
  const parts = address.split('.').map(Number)
  if (parts.length !== 4 || parts.some(part => !Number.isInteger(part) || part < 0 || part > 255)) {
    return false
  }
  const [a, b, c] = parts
  return !(
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113) ||
    a >= 224
  )
}

function safeError(prefix, error) {
  const code = typeof error?.code === 'string' ? ` (${error.code})` : ''
  return `${prefix}${code}`
}

function parseArguments(argv) {
  const options = {
    origin: '',
    expectedHostname: '',
    report: '',
    reportOnly: false,
    timeoutMs: DEFAULT_TIMEOUT_MS
  }
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index]
    if (argument === '--origin') {
      options.origin = argv[++index] || ''
    } else if (argument === '--expected-host') {
      options.expectedHostname = argv[++index] || ''
    } else if (argument === '--report') {
      options.report = argv[++index] || ''
    } else if (argument === '--timeout-ms') {
      options.timeoutMs = Number(argv[++index])
    } else if (argument === '--report-only') {
      options.reportOnly = true
    } else {
      throw new Error(`Unknown public-origin option: ${argument}`)
    }
  }
  if (!options.origin) {
    throw new Error('Usage: npm run production:origin-preflight -- --origin <https-origin> [--expected-host <hostname>] [--report <report.json>] [--report-only]')
  }
  if (!Number.isInteger(options.timeoutMs) || options.timeoutMs < 1000 || options.timeoutMs > 60_000) {
    throw new Error('--timeout-ms must be an integer between 1000 and 60000.')
  }
  return options
}

async function runCli() {
  const options = parseArguments(process.argv.slice(2))
  const report = await inspectPublicOrigin(options)
  if (options.report) {
    const reportPath = path.resolve(options.report)
    fs.mkdirSync(path.dirname(reportPath), { recursive: true })
    fs.writeFileSync(reportPath, `${JSON.stringify(report, undefined, 2)}\n`, 'utf8')
  }
  console.log(JSON.stringify(report, undefined, 2))
  if (report.result === 'FAIL') process.exitCode = 1
  if (report.result === 'BLOCKED' && !options.reportOnly) process.exitCode = 2
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  await runCli()
}
