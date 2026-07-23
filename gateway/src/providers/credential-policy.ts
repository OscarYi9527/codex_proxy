import type { GatewayConfig } from '../config.js'
import { SafeError } from '../common/errors.js'

export const PLAINTEXT_STORAGE_WARNING =
  '调试模式正在使用 plaintext-v1 保存 Provider 凭据；禁止用于公网或生产部署。'

export function assertCredentialStorageAllowed(
  config: GatewayConfig,
  plaintextCredentialCount: number
): void {
  if (plaintextCredentialCount <= 0) return
  if (
    config.environment === 'preview' ||
    config.environment === 'preproduction' ||
    config.environment === 'production'
  ) {
    throw new Error(
      'Preview/preproduction/production Gateway refuses startup while plaintext-v1 Provider credentials exist'
    )
  }
  if (config.host !== '127.0.0.1') {
    throw new Error(
      'Non-loopback Gateway refuses startup while plaintext-v1 Provider credentials exist'
    )
  }
}

export function requireDevelopmentPlaintext(config: GatewayConfig): void {
  if (
    config.environment === 'preview' ||
    config.environment === 'preproduction' ||
    config.environment === 'production' ||
    config.host !== '127.0.0.1'
  ) {
    throw new SafeError({
      code: 'plaintext_credentials_forbidden',
      message: '当前部署不允许创建明文 Provider 凭据。',
      statusCode: 409
    })
  }
}
