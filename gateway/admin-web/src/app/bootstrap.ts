import type { ManagementBootstrapMessage, ManagementRoute } from './types'

const ROUTES = new Set<ManagementRoute>([
  'account',
  'security',
  'organization',
  'invitations',
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
