const MAX_IMPORT_BYTES = 2 * 1024 * 1024
const MAX_IMPORT_ACCOUNTS = 100
const MAX_TOKEN_LENGTH = 16 * 1024

function stringValue(value, maxLength = MAX_TOKEN_LENGTH) {
  if (typeof value !== 'string') return ''
  const result = value.trim()
  if (!result || result.length > maxLength || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(result)) {
    return ''
  }
  return result
}

function firstString(source, keys, maxLength) {
  for (const key of keys) {
    const value = stringValue(source?.[key], maxLength)
    if (value) return value
  }
  return ''
}

function credentialSources(record) {
  const values = [
    record?.tokens,
    record?.credentials,
    record?.credential,
    record?.auth?.tokens,
    record?.auth?.credentials,
    record?.auth,
    record
  ]
  return values.filter(value => value && typeof value === 'object' && !Array.isArray(value))
}

function normalizeRecord(record, sourceFormat) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) return null
  for (const credentials of credentialSources(record)) {
    const accessToken = firstString(credentials, ['access_token', 'accessToken'])
    const refreshToken = firstString(credentials, ['refresh_token', 'refreshToken'])
    const idToken = firstString(credentials, ['id_token', 'idToken'])
    const accountId = firstString(credentials, [
      'account_id',
      'accountId',
      'chatgpt_account_id',
      'chatgptAccountId',
      'workspace_id',
      'workspaceId'
    ], 240)
    if (!accessToken || !accountId) continue
    const extra = record.extra && typeof record.extra === 'object' ? record.extra : {}
    const label = firstString(record, ['label', 'name', 'email'], 80) ||
      firstString(credentials, ['email'], 80) ||
      firstString(extra, ['name', 'email'], 80) ||
      accountId
    const email = firstString(record, ['email'], 320) ||
      firstString(credentials, ['email'], 320) ||
      firstString(extra, ['email'], 320)
    const planType = firstString(record, ['plan_type', 'planType', 'chatgpt_plan_type'], 80) ||
      firstString(credentials, ['plan_type', 'planType', 'chatgpt_plan_type'], 80)
    const credentialMode = refreshToken ? 'refreshable' : 'temporary_access'
    return {
      accountId,
      label,
      sourceFormat,
      credentialMode,
      email,
      planType,
      authJson: JSON.stringify({
        OPENAI_API_KEY: null,
        tokens: {
          id_token: idToken || null,
          access_token: accessToken,
          refresh_token: refreshToken || null,
          account_id: accountId
        },
        last_refresh: new Date().toISOString()
      })
    }
  }
  return null
}

function collectJsonRecords(root, sourceFormat) {
  const results = []
  const visited = new Set()
  const walk = (value, depth) => {
    if (results.length > MAX_IMPORT_ACCOUNTS || depth > 5 || value == null) return
    if (Array.isArray(value)) {
      for (const item of value) walk(item, depth + 1)
      return
    }
    if (typeof value !== 'object' || visited.has(value)) return
    visited.add(value)
    const normalized = normalizeRecord(value, sourceFormat)
    if (normalized) {
      results.push(normalized)
      return
    }
    for (const child of Object.values(value)) {
      if (child && typeof child === 'object') walk(child, depth + 1)
    }
  }
  walk(root, 0)
  return results
}

function delimiterForHeader(line) {
  for (const delimiter of ['\t', '----', '|', ',']) {
    const fields = line.split(delimiter).map(value => value.trim().toLowerCase())
    const hasAccountId = fields.some(value => [
      'account_id',
      'accountid',
      'chatgpt_account_id',
      'workspace_id'
    ].includes(value))
    if (fields.includes('access_token') && hasAccountId) return delimiter
  }
  return null
}

function parseDelimitedText(lines) {
  if (lines.length < 2) return []
  const delimiter = delimiterForHeader(lines[0])
  if (!delimiter) return []
  const headers = lines[0].split(delimiter).map(value => value.trim())
  return lines.slice(1).map(line => {
    const values = line.split(delimiter)
    return Object.fromEntries(headers.map((header, index) => [header, values[index]?.trim() || '']))
  })
}

function parseKeyValueText(text) {
  return text
    .split(/\r?\n\s*\r?\n|^\s*-{3,}\s*$/m)
    .map(block => {
      const record = {}
      for (const line of block.split(/\r?\n/)) {
        const match = /^\s*([A-Za-z][A-Za-z0-9_]*)\s*[:=]\s*(.*?)\s*$/.exec(line)
        if (match) record[match[1]] = match[2]
      }
      return record
    })
    .filter(record => Object.keys(record).length > 0)
}

function parseTextRecords(text) {
  const lines = text.split(/\r?\n/).map(line => line.trim()).filter(Boolean)
  const jsonLines = []
  for (const line of lines) {
    try {
      jsonLines.push(JSON.parse(line))
    } catch {
      // Continue with key/value and header-based text formats.
    }
  }
  return [
    ...jsonLines,
    ...parseDelimitedText(lines),
    ...parseKeyValueText(text)
  ]
}

function detectJsonFormat(root) {
  if (root?.tokens) return 'auth.json'
  if (Array.isArray(root?.accounts) && root.accounts.some(account => account?.credentials)) {
    return 'sub2-json'
  }
  return 'cpa-json'
}

export function parseChatgptAccountImport(raw) {
  if (typeof raw !== 'string' || !raw.trim()) {
    throw new Error('导入内容不能为空')
  }
  if (Buffer.byteLength(raw, 'utf8') > MAX_IMPORT_BYTES) {
    throw new Error('导入文件不能超过 2 MiB')
  }
  const text = raw.replace(/^\uFEFF/, '').trim()
  let records
  try {
    const root = JSON.parse(text)
    records = collectJsonRecords(root, detectJsonFormat(root))
  } catch {
    records = collectJsonRecords(parseTextRecords(text), 'txt')
  }
  const unique = []
  const seen = new Set()
  for (const record of records) {
    if (seen.has(record.accountId)) continue
    seen.add(record.accountId)
    unique.push(record)
  }
  if (unique.length === 0) {
    throw new Error(
      '没有找到可导入账号；至少需要 access_token 和 account_id。' +
      '缺少 refresh_token 时会按临时账号导入；仅有邮箱、client_id 或邮箱 OAuth 信息仍不能调用 ChatGPT。'
    )
  }
  if (records.length > MAX_IMPORT_ACCOUNTS) {
    throw new Error(`单次最多导入 ${MAX_IMPORT_ACCOUNTS} 个账号`)
  }
  return unique
}
