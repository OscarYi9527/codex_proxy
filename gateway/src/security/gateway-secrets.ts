import fs from 'node:fs'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import type { GatewayConfig } from '../config.js'

export interface GatewaySecrets {
  readonly accessTokenKey: Uint8Array
  readonly digestKey: Uint8Array
}

interface SecretEnvelope {
  readonly version: 1
  readonly accessTokenKey: string
  readonly digestKey: string
}

function decodeKey(value: string | undefined, name: string): Uint8Array {
  if (!value) throw new Error(`${name} is required`)
  const key = Buffer.from(value, 'base64')
  if (key.length < 32) throw new Error(`${name} must decode to at least 32 bytes`)
  return new Uint8Array(key)
}

function parseEnvelope(value: unknown): GatewaySecrets {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Gateway secret envelope is invalid')
  }
  const envelope = value as Partial<SecretEnvelope>
  if (envelope.version !== 1) throw new Error('Gateway secret envelope version is unsupported')
  return {
    accessTokenKey: decodeKey(envelope.accessTokenKey, 'accessTokenKey'),
    digestKey: decodeKey(envelope.digestKey, 'digestKey')
  }
}

export function loadGatewaySecrets(
  config: GatewayConfig,
  env: NodeJS.ProcessEnv = process.env
): GatewaySecrets {
  if (config.environment === 'production') {
    return {
      accessTokenKey: decodeKey(
        env.AI_EDITOR_GATEWAY_ACCESS_TOKEN_KEY,
        'AI_EDITOR_GATEWAY_ACCESS_TOKEN_KEY'
      ),
      digestKey: decodeKey(
        env.AI_EDITOR_GATEWAY_DIGEST_KEY,
        'AI_EDITOR_GATEWAY_DIGEST_KEY'
      )
    }
  }

  const secretFile = path.join(config.dataRoot, 'gateway-auth-keys.gateway-secret')
  fs.mkdirSync(config.dataRoot, { recursive: true, mode: 0o700 })
  if (fs.existsSync(secretFile)) {
    return parseEnvelope(JSON.parse(fs.readFileSync(secretFile, 'utf8')))
  }

  const envelope: SecretEnvelope = {
    version: 1,
    accessTokenKey: randomBytes(32).toString('base64'),
    digestKey: randomBytes(32).toString('base64')
  }
  const temporary = `${secretFile}.${process.pid}.${Date.now()}.tmp`
  fs.writeFileSync(temporary, `${JSON.stringify(envelope)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
    flag: 'wx'
  })
  try {
    fs.renameSync(temporary, secretFile)
  } catch (error) {
    fs.rmSync(temporary, { force: true })
    if (!fs.existsSync(secretFile)) throw error
  }
  try {
    fs.chmodSync(secretFile, 0o600)
  } catch {
    // Windows ACLs are inherited from the isolated user-owned data root.
  }
  return parseEnvelope(JSON.parse(fs.readFileSync(secretFile, 'utf8')))
}
