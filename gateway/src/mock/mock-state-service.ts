import type { Clock } from '../common/clock.js'
import type { IdSource } from '../common/ids.js'
import type { MockAccountState } from '../config.js'

export interface SafeMockStatus {
  readonly state: MockAccountState
  readonly checkedAt: string
  readonly account?: {
    readonly display: string
    readonly role: 'level1' | 'level2' | 'user'
  }
  readonly currentModel?: string
  readonly availableCredits?: string
  readonly usedCreditsPercent?: string
  readonly errorId?: string
  readonly actions: ReadonlyArray<'login' | 'openAccount' | 'retry' | 'openDiagnostics'>
}

export class MockStateService {
  #state: MockAccountState
  readonly #clock: Clock
  readonly #ids: IdSource

  constructor(options: { state: MockAccountState; clock: Clock; ids: IdSource }) {
    this.#state = options.state
    this.#clock = options.clock
    this.#ids = options.ids
  }

  setState(state: MockAccountState): void {
    this.#state = state
  }

  status(): SafeMockStatus {
    const checkedAt = this.#clock.now().toISOString()
    if (this.#state === 'ready') {
      return {
        state: 'ready',
        checkedAt,
        account: { display: 'mock-user@example.com', role: 'user' },
        currentModel: 'gpt-mock',
        availableCredits: '1000.000000',
        usedCreditsPercent: '0',
        actions: []
      }
    }
    const actions = this.#state === 'login_required'
      ? ['login'] as const
      : this.#state === 'service_unavailable'
        ? ['retry'] as const
        : ['openAccount'] as const
    return {
      state: this.#state,
      checkedAt,
      errorId: this.#ids.opaque('err'),
      actions
    }
  }

  models(): {
    object: 'list'
    data: Array<{ id: string; object: 'model'; owned_by: 'ai-editor' }>
  } {
    return {
      object: 'list',
      data: this.#state === 'ready'
        ? [{ id: 'gpt-mock', object: 'model', owned_by: 'ai-editor' }]
        : []
    }
  }
}
