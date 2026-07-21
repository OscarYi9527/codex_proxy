export interface SecretFinding {
  readonly version: number
  readonly kind: string
  readonly source: string
  readonly path: string
  readonly line?: number
  readonly column?: number
}

export interface SecretScanOptions {
  readonly source?: string
  readonly path?: string
  readonly maxFindings?: number
  readonly allowProtectedValues?: boolean
  readonly message?: string
}

export const SECRET_SCAN_VERSION: number
export function isProtectedSecretValue(value: unknown): boolean
export function isProviderCredentialEnvelope(value: unknown): boolean
export function scanTextSecrets(
  value: unknown,
  options?: SecretScanOptions
): SecretFinding[]
export function scanValueSecrets(
  value: unknown,
  options?: SecretScanOptions
): SecretFinding[]
export function redactSecretText(value: unknown): string
export class SecretScanError extends Error {
  readonly code: 'SECRET_SCAN_FAILED'
  readonly findings: readonly SecretFinding[]
  constructor(findings: readonly SecretFinding[], message?: string)
}
export function assertNoSecrets<T>(value: T, options?: SecretScanOptions): T
export function sensitiveArtifactKind(file: unknown): string | null
