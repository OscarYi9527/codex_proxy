const SCALE = 1_000_000n
const CREDIT_PATTERN = /^(-?)(\d+)(?:\.(\d{0,6}))?$/

export type CreditUnits = bigint

export function parseCredits(value: string | number, options: {
  allowNegative?: boolean
} = {}): CreditUnits {
  const text = typeof value === 'number'
    ? (Number.isFinite(value) ? String(value) : '')
    : value.trim()
  const match = CREDIT_PATTERN.exec(text)
  if (!match) throw new Error('Credit value must have at most six decimal places')
  const units = BigInt(match[2] || '0') * SCALE +
    BigInt((match[3] || '').padEnd(6, '0'))
  const signed = match[1] === '-' ? -units : units
  if (signed < 0n && options.allowNegative !== true) {
    throw new Error('Credit value must be non-negative')
  }
  return signed
}

export function formatCredits(units: CreditUnits): string {
  const sign = units < 0n ? '-' : ''
  const absolute = units < 0n ? -units : units
  return `${sign}${absolute / SCALE}.${String(absolute % SCALE).padStart(6, '0')}`
}

export function normalizeCredits(value: string | number, options: {
  allowNegative?: boolean
} = {}): string {
  return formatCredits(parseCredits(value, options))
}

export function addCredits(...values: Array<string | CreditUnits>): CreditUnits {
  return values.reduce<CreditUnits>(
    (sum, value) => sum + (typeof value === 'bigint'
      ? value
      : parseCredits(value, { allowNegative: true })),
    0n
  )
}

export function creditsForTokens(
  perToken: string,
  tokens: number,
  multiplier: string,
  rounding: 'ceil' | 'nearest' = 'nearest'
): CreditUnits {
  if (!Number.isSafeInteger(tokens) || tokens < 0) {
    throw new Error('Token count must be a non-negative safe integer')
  }
  const base = parseCredits(perToken) * BigInt(tokens)
  const multiplied = base * parseCredits(multiplier)
  const remainder = multiplied % SCALE
  const quotient = multiplied / SCALE
  if (remainder === 0n) return quotient
  if (rounding === 'ceil') return quotient + 1n
  return quotient + (remainder * 2n >= SCALE ? 1n : 0n)
}

export function percentage(used: string, allocated: string): string {
  const allocatedUnits = parseCredits(allocated, { allowNegative: true })
  if (allocatedUnits <= 0n) return '0'
  const usedUnits = parseCredits(used, { allowNegative: true })
  const tenths = usedUnits <= 0n
    ? 0n
    : (usedUnits * 1_000n) / allocatedUnits
  const whole = tenths / 10n
  const fraction = tenths % 10n
  return fraction === 0n ? String(whole) : `${whole}.${fraction}`
}
