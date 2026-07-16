import { Algorithm, hash, verify } from '@node-rs/argon2'
import { randomBytes } from 'node:crypto'
import { SafeError } from '../common/errors.js'

const MINIMUM_PASSWORD_LENGTH = 12
const MAXIMUM_PASSWORD_LENGTH = 128

export class PasswordService {
  validate(password: string): void {
    if (
      typeof password !== 'string' ||
      password.length < MINIMUM_PASSWORD_LENGTH ||
      password.length > MAXIMUM_PASSWORD_LENGTH ||
      !/[a-z]/.test(password) ||
      !/[A-Z]/.test(password) ||
      !/[0-9]/.test(password)
    ) {
      throw new SafeError({
        code: 'password_policy_failed',
        message: '密码需为 12–128 位，并同时包含大小写字母和数字。',
        statusCode: 400
      })
    }
  }

  async hash(password: string): Promise<string> {
    this.validate(password)
    return hash(password, {
      algorithm: Algorithm.Argon2id,
      memoryCost: 19_456,
      timeCost: 2,
      parallelism: 1,
      outputLen: 32
    })
  }

  async verify(encodedHash: string, candidate: string): Promise<boolean> {
    if (typeof candidate !== 'string' || candidate.length > MAXIMUM_PASSWORD_LENGTH) return false
    try {
      return await verify(encodedHash, candidate)
    } catch {
      return false
    }
  }

  generateTemporaryPassword(): string {
    // Prefix guarantees policy character classes without reducing random entropy.
    return `Aa9-${randomBytes(24).toString('base64url')}`
  }
}
