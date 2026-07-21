import path from 'node:path'

export const SECRET_SCAN_VERSION = 1

const REDACTED_VALUES = new Set([
  '',
  '[REDACTED]',
  '[redacted]',
  '***',
  'null',
  'undefined'
])

const SENSITIVE_KEYS = new Map([
  ['authorization', 'authorization'],
  ['apikey', 'api-key'],
  ['accesstoken', 'access-token'],
  ['refreshtoken', 'refresh-token'],
  ['idtoken', 'id-token'],
  ['clientsecret', 'oauth-client-secret'],
  ['password', 'password'],
  ['secret', 'secret-field'],
  ['ticket', 'ticket'],
  ['webviewticket', 'webview-ticket'],
  ['nonce', 'nonce'],
  ['edgenonce', 'edge-nonce'],
  ['codeverifier', 'oauth-code-verifier'],
  ['usercode', 'oauth-user-code'],
  ['devicecode', 'oauth-device-code'],
  ['invitationcode', 'invitation-code'],
  ['redeemrequestid', 'redeem-request-id'],
  ['authorizationcode', 'oauth-authorization-code'],
  ['oauthcode', 'oauth-authorization-code'],
  ['secretpayload', 'provider-secret-payload']
])

const SENSITIVE_FIELD_PATTERN =
  '(?:[A-Za-z0-9_-]*(?:authorization|api[_-]?key|access[_-]?token|refresh[_-]?token|' +
  'id[_-]?token|client[_-]?secret|password|secret|webview[_-]?ticket|' +
  'edge[_-]?nonce|ticket|nonce|code[_-]?verifier|invitation[_-]?code|' +
  'user[_-]?code|device[_-]?code|' +
  'redeem[_-]?request[_-]?id|authorization[_-]?code|oauth[_-]?code|' +
  'secret[_-]?payload))'

const TEXT_RULES = [
  {
    kind: 'private-key',
    pattern: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g
  },
  {
    kind: 'private-key',
    pattern: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g
  },
  {
    kind: 'authorization',
    pattern: /\b(?:Bearer|Basic)\s+([A-Za-z0-9._~+/-]{12,}={0,2})/gi,
    capture: 1
  },
  {
    kind: 'jwt',
    pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{12,}\b/g
  },
  {
    kind: 'openai-api-key',
    pattern: /\bsk-(?!ant-)(?:(?:proj|svcacct)-)?[A-Za-z0-9_-]{20,}\b/g
  },
  {
    kind: 'anthropic-api-key',
    pattern: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g
  },
  {
    kind: 'refresh-token',
    pattern: /\brt\.[A-Za-z0-9._~-]{16,}\b/g
  },
  {
    kind: 'github-token',
    pattern: /\b(?:ghp|gho|ghu|ghs|github_pat)_[A-Za-z0-9_]{20,}\b/g
  },
  {
    kind: 'google-api-key',
    pattern: /\bAIza[A-Za-z0-9_-]{30,}\b/g
  }
]

const JSON_ASSIGNMENT = new RegExp(
  `(["'])(${SENSITIVE_FIELD_PATTERN})\\1\\s*:\\s*(["'])([^"'\\r\\n]{1,8192})\\3`,
  'gi'
)
const ENV_ASSIGNMENT = new RegExp(
  `(^|\\n)(\\s*(?:${SENSITIVE_FIELD_PATTERN})\\s*=\\s*)([^\\s#\\r\\n]{1,8192})`,
  'gi'
)
const QUERY_ASSIGNMENT = new RegExp(
  `([?&](?:${SENSITIVE_FIELD_PATTERN})=)([^&\\s#]{1,8192})`,
  'gi'
)

function normalizedKey(key) {
  return String(key || '').replace(/[^a-z0-9]/gi, '').toLowerCase()
}

function sensitiveKeyKind(key) {
  const normalized = normalizedKey(key)
  const exact = SENSITIVE_KEYS.get(normalized)
  if (exact) return exact
  for (const [suffix, kind] of SENSITIVE_KEYS) {
    if (normalized.endsWith(suffix)) return kind
  }
  return null
}

function isDerivedOrProtectedKey(key) {
  return /(?:digest|hash|ciphertext|authtag|protectedpayload|protectedkey|signature)$/i
    .test(normalizedKey(key))
}

function isRedactedValue(value) {
  const text = String(value ?? '').trim()
  return REDACTED_VALUES.has(text) ||
    /^<[^>\r\n]{1,160}>$/.test(text) ||
    /^\[REDACTED(?: [A-Z ]+)?\]$/i.test(text) ||
    /^[^\s*•]{0,16}(?:\*{3,}|•{3,})[^\s*•]{0,12}$/.test(text)
}

export function isProtectedSecretValue(value) {
  if (typeof value !== 'string') return false
  if (value.startsWith('dpapi-aesgcm:v1:')) return true
  try {
    const envelope = JSON.parse(value)
    return isProviderCredentialEnvelope(envelope)
  } catch {
    return false
  }
}

export function isProviderCredentialEnvelope(value) {
  return Boolean(
    value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    value.version === 1 &&
    value.algorithm === 'AES-256-GCM' &&
    typeof value.key_id === 'string' &&
    typeof value.nonce === 'string' &&
    typeof value.ciphertext === 'string' &&
    typeof value.tag === 'string'
  )
}

function lineAndColumn(text, index) {
  const prefix = text.slice(0, index)
  const lines = prefix.split('\n')
  return {
    line: lines.length,
    column: (lines.at(-1)?.length || 0) + 1
  }
}

function finding(kind, options, location = {}) {
  return {
    version: SECRET_SCAN_VERSION,
    kind,
    source: options.source || 'unknown',
    path: options.path || '$',
    ...location
  }
}

function addFinding(findings, next, maxFindings) {
  if (findings.length >= maxFindings) return
  const identity = [
    next.kind,
    next.source,
    next.path,
    next.line || '',
    next.column || ''
  ].join('|')
  if (!findings.some(item => [
    item.kind,
    item.source,
    item.path,
    item.line || '',
    item.column || ''
  ].join('|') === identity)) {
    findings.push(next)
  }
}

function scanPattern(findings, text, rule, options, maxFindings) {
  rule.pattern.lastIndex = 0
  for (const match of text.matchAll(rule.pattern)) {
    const candidate = match[rule.capture || 0] || ''
    if (isRedactedValue(candidate)) continue
    const offset = match.index + Math.max(0, match[0].indexOf(candidate))
    addFinding(
      findings,
      finding(rule.kind, options, lineAndColumn(text, offset)),
      maxFindings
    )
  }
}

export function scanTextSecrets(value, options = {}) {
  const text = String(value ?? '')
  const maxFindings = Math.max(1, Number(options.maxFindings) || 100)
  const findings = []
  for (const rule of TEXT_RULES) {
    scanPattern(findings, text, rule, options, maxFindings)
  }

  JSON_ASSIGNMENT.lastIndex = 0
  for (const match of text.matchAll(JSON_ASSIGNMENT)) {
    const candidate = match[4] || ''
    if (isRedactedValue(candidate)) continue
    const offset = match.index + match[0].indexOf(candidate)
    addFinding(
      findings,
      finding(
        sensitiveKeyKind(match[2]) || 'sensitive-field',
        options,
        lineAndColumn(text, offset)
      ),
      maxFindings
    )
  }

  ENV_ASSIGNMENT.lastIndex = 0
  for (const match of text.matchAll(ENV_ASSIGNMENT)) {
    const candidate = String(match[3] || '').replace(/^(["'])(.*)\1$/, '$2')
    if (isRedactedValue(candidate)) continue
    const offset = match.index + match[0].lastIndexOf(match[3])
    const key = /^[\s]*([A-Za-z0-9_-]+)/.exec(match[2] || '')?.[1]
    addFinding(
      findings,
      finding(
        sensitiveKeyKind(key) || 'sensitive-field',
        options,
        lineAndColumn(text, offset)
      ),
      maxFindings
    )
  }

  QUERY_ASSIGNMENT.lastIndex = 0
  for (const match of text.matchAll(QUERY_ASSIGNMENT)) {
    const candidate = match[2] || ''
    if (isRedactedValue(candidate)) continue
    const key = /[?&]([^=]+)/.exec(match[1] || '')?.[1]
    const offset = match.index + match[0].indexOf(candidate)
    addFinding(
      findings,
      finding(
        sensitiveKeyKind(key) || 'sensitive-query-value',
        options,
        lineAndColumn(text, offset)
      ),
      maxFindings
    )
  }
  return findings
}

function childPath(parent, key) {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(String(key))
    ? `${parent}.${key}`
    : `${parent}[${JSON.stringify(String(key))}]`
}

export function scanValueSecrets(value, options = {}) {
  const maxFindings = Math.max(1, Number(options.maxFindings) || 100)
  const findings = []
  const seen = new WeakSet()
  const rootPath = options.path || '$'

  const walk = (current, currentPath, parentKey = '') => {
    if (findings.length >= maxFindings || current == null) return
    const keyKind = isDerivedOrProtectedKey(parentKey)
      ? null
      : sensitiveKeyKind(parentKey)
    const protectedValue = isProtectedSecretValue(current) ||
      isProviderCredentialEnvelope(current)
    const redactedValue = typeof current === 'string' && isRedactedValue(current)
    if (
      keyKind &&
      typeof current !== 'boolean' &&
      !redactedValue &&
      !(options.allowProtectedValues === true && protectedValue)
    ) {
      addFinding(
        findings,
        finding(keyKind, { ...options, path: currentPath }),
        maxFindings
      )
    }
    if (options.allowProtectedValues === true && protectedValue) return

    if (typeof current === 'string') {
      for (const item of scanTextSecrets(current, {
        ...options,
        path: currentPath,
        maxFindings: maxFindings - findings.length
      })) {
        addFinding(findings, item, maxFindings)
      }
      return
    }
    if (typeof current !== 'object') return
    if (seen.has(current)) return
    seen.add(current)
    if (current instanceof Error) {
      walk(current.message, childPath(currentPath, 'message'), 'message')
      if (current.cause !== undefined) {
        walk(current.cause, childPath(currentPath, 'cause'), 'cause')
      }
      return
    }
    if (Array.isArray(current)) {
      current.forEach((item, index) => walk(item, `${currentPath}[${index}]`, parentKey))
      return
    }
    for (const [key, item] of Object.entries(current)) {
      const safeKeyPath = `${currentPath}.[key]`
      const keyFindings = scanTextSecrets(key, {
        ...options,
        path: safeKeyPath,
        maxFindings: maxFindings - findings.length
      })
      for (const keyFinding of keyFindings) {
        addFinding(findings, keyFinding, maxFindings)
      }
      const nextPath = keyFindings.length
        ? `${currentPath}.[REDACTED_KEY]`
        : childPath(currentPath, key)
      walk(item, nextPath, key)
    }
  }

  walk(value, rootPath)
  return findings
}

export function redactSecretText(value) {
  return String(value ?? '')
    .replace(
      /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g,
      '[REDACTED PRIVATE KEY]'
    )
    .replace(
      /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]*/g,
      '[REDACTED PRIVATE KEY]'
    )
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/-]{1,}={0,2}/gi, '$1 [REDACTED]')
    .replace(/\bsk-(?:(?:proj|svcacct)-)?[A-Za-z0-9_-]{8,}\b/g, '[REDACTED]')
    .replace(/\bsk-ant-[A-Za-z0-9_-]{8,}\b/g, '[REDACTED]')
    .replace(/\brt\.[A-Za-z0-9._~-]{8,}\b/g, '[REDACTED]')
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, '[REDACTED]')
    .replace(
      new RegExp(
        `(["']${SENSITIVE_FIELD_PATTERN}["']\\s*:\\s*["'])[^"'\\r\\n]*(["'])`,
        'gi'
      ),
      '$1[REDACTED]$2'
    )
    .replace(
      new RegExp(`([?&](?:${SENSITIVE_FIELD_PATTERN})=)[^&\\s#]+`, 'gi'),
      '$1[REDACTED]'
    )
    .replace(
      new RegExp(`(^|\\n)(\\s*(?:${SENSITIVE_FIELD_PATTERN})\\s*=\\s*)[^\\s#\\r\\n]+`, 'gi'),
      '$1$2[REDACTED]'
    )
}

export class SecretScanError extends Error {
  constructor(findings, message = 'Secret scan rejected unsafe data') {
    const kinds = [...new Set(findings.map(item => item.kind))].sort()
    super(`${message}: ${findings.length} finding(s) [${kinds.join(', ')}]`)
    this.name = 'SecretScanError'
    this.code = 'SECRET_SCAN_FAILED'
    this.findings = findings
  }
}

export function assertNoSecrets(value, options = {}) {
  const findings = typeof value === 'string'
    ? scanTextSecrets(value, options)
    : scanValueSecrets(value, options)
  if (findings.length) throw new SecretScanError(findings, options.message)
  return value
}

export function sensitiveArtifactKind(file) {
  const normalized = String(file || '').replaceAll('\\', '/')
  const base = path.posix.basename(normalized).toLowerCase()
  if (!base) return null
  if (base === '.env.example' || base === '.env.template') return null
  if (
    base === '.env' ||
    base.startsWith('.env.') ||
    base === 'auth.json' ||
    base === 'codex-proxy-config.json'
  ) {
    return 'sensitive-config-artifact'
  }
  if (/\.(?:pem|key|p12|pfx|sqlite|sqlite3|db|log|bak)$/i.test(base)) {
    return 'sensitive-binary-or-log-artifact'
  }
  if (
    base.endsWith('.gateway-secret') ||
    base.includes('.dpapi.') ||
    normalized.includes('/.ai-editor-dev/') ||
    normalized.includes('/.account-backups/') ||
    normalized.includes('/.migration-backups/')
  ) {
    return 'protected-runtime-artifact'
  }
  return null
}
