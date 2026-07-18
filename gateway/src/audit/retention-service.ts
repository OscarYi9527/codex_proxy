import type { Clock } from '../common/clock.js'
import { AuditRepository } from '../db/repositories/audit-repository.js'

export class RetentionService {
  constructor(
    private readonly repository: AuditRepository,
    private readonly clock: Clock
  ) {}

  cleanupExpiredBodies(): Promise<number> {
    return this.repository.deleteExpiredBodies(this.clock.now().toISOString())
  }
}
