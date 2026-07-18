import type {
  CurrentCodexAuthMessage,
  ManagementBootstrapMessage,
  ManagementRoute
} from './types'

const ROUTES = new Set<ManagementRoute>([
  'account',
  'security',
  'organization',
  'invitations',
  'credits',
  'usage',
  'providers',
  'diagnostics'
])

export function managementBootstrapFromEvent(
  event: MessageEvent,
  expectedOrigin: string
): ManagementBootstrapMessage | null {
  if (event.source !== window || event.origin !== expectedOrigin) return null
  const value = event.data as Partial<ManagementBootstrapMessage> | null
  if (
    !value ||
    value.type !== 'ai-editor-management-bootstrap' ||
    value.version !== 1 ||
    typeof value.route !== 'string' ||
    !ROUTES.has(value.route as ManagementRoute) ||
    typeof value.ticket !== 'string' ||
    value.ticket.length < 16 ||
    !Number.isFinite(value.expiresIn) ||
    Number(value.expiresIn) <= 0
  ) {
    return null
  }
  return value as ManagementBootstrapMessage
}

export function currentCodexAuthFromEvent(
  event: MessageEvent,
  expectedOrigin: string
): CurrentCodexAuthMessage | null {
  if (event.source !== window || event.origin !== expectedOrigin) return null
  const value = event.data as Partial<CurrentCodexAuthMessage> | null
  if (
    !value ||
    value.type !== 'ai-editor-current-codex-auth' ||
    value.version !== 1
  ) {
    return null
  }
  const hasAuthJson = typeof value.authJson === 'string' &&
    value.authJson.length > 0 &&
    value.authJson.length <= 256 * 1024
  const hasSafeError = typeof value.errorId === 'string' &&
    /^[a-z0-9_]{1,80}$/.test(value.errorId)
  if (hasAuthJson === hasSafeError) return null
  return hasAuthJson
    ? { type: value.type, version: 1, authJson: value.authJson }
    : { type: value.type, version: 1, errorId: value.errorId }
}
