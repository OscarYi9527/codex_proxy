import type { GatewayConfig } from '../config.js'

export const PLAINTEXT_STORAGE_WARNING =
  '调试模式正在使用 plaintext-v1 保存 Provider 凭据；禁止用于公网或生产部署。'

export function assertCredentialStorageAllowed(
  config: GatewayConfig,
  plaintextCredentialCount: number
): void {
  if (plaintextCredentialCount <= 0) return
  if (config.environment === 'production') {
    throw new Error(
      'Production Gateway refuses startup while plaintext-v1 Provider credentials exist'
    )
  }
  if (config.host !== '127.0.0.1') {
    throw new Error(
      'Non-loopback Gateway refuses startup while plaintext-v1 Provider credentials exist'
    )
  }
}
