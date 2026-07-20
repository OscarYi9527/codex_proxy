import type { Clock } from '../common/clock.js'
import type { IdSource } from '../common/ids.js'
import { AuthRepository } from '../db/repositories/auth-repository.js'
import { PasswordService } from './password-service.js'

export interface BootstrapResult {
  readonly created: boolean
  readonly loginName?: 'admin'
  readonly temporaryPassword?: string
}

export class BootstrapService {
  constructor(
    private readonly repository: AuthRepository,
    private readonly passwords: PasswordService,
    private readonly clock: Clock,
    private readonly ids: IdSource
  ) {}

  async initialize(): Promise<BootstrapResult> {
    if (await this.repository.countAccounts() > 0) return { created: false }
    const temporaryPassword = this.passwords.generateTemporaryPassword()
    const passwordHash = await this.passwords.hash(temporaryPassword)
    const now = this.clock.now().toISOString()
    try {
      return await this.repository.inTransaction(async repository => {
        if (await repository.countAccounts() > 0) return { created: false }
        if (!await repository.reservePublicMvpAccountSlot(now)) {
          throw new Error('Public MVP account capacity is exhausted before bootstrap')
        }
        await repository.insertAccountAndCredential({
          id: this.ids.opaque('acct'),
          loginName: 'admin',
          email: null,
          role: 'level1',
          organizationId: null,
          mustChangePassword: true,
          mustProvideEmail: true,
          passwordHash,
          credentialKind: 'bootstrap',
          accountExpiresAt: null,
          passwordExpiresAt: null,
          now
        })
        return {
          created: true,
          loginName: 'admin' as const,
          temporaryPassword
        }
      })
    } catch (error) {
      if (await this.repository.countAccounts() > 0) return { created: false }
      throw error
    }
  }
}
