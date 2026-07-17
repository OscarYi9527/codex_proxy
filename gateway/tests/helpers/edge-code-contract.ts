import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export interface EdgeCodeContractFixture {
  readonly schemaVersion: number
  readonly localAuthorization: {
    readonly headerName: string
    readonly missingStatus: number
    readonly missingErrorCode: string
  }
  readonly statuses: ReadonlyArray<{
    readonly state: string
    readonly actions: readonly string[]
    readonly requiredFields: readonly string[]
    readonly forbiddenFields: readonly string[]
  }>
  readonly statusRetry: {
    readonly method: string
    readonly path: string
    readonly successStatuses: readonly number[]
  }
  readonly handoff: {
    readonly start: {
      readonly method: string
      readonly path: string
      readonly successStatuses: readonly number[]
      readonly request: { readonly state: string }
      readonly responseRequiredFields: readonly string[]
    }
    readonly complete: {
      readonly method: string
      readonly path: string
      readonly successStatuses: readonly number[]
      readonly request: Record<string, unknown>
      readonly response: {
        readonly status: string
        readonly minimumBindingVersion: number
      }
      readonly replayStatuses: readonly number[]
      readonly replayErrorCode: string
    }
  }
  readonly webviewTicket: {
    readonly method: string
    readonly path: string
    readonly successStatuses: readonly number[]
    readonly responseRequiredFields: readonly string[]
  }
  readonly logout: {
    readonly method: string
    readonly path: string
    readonly successStatuses: readonly number[]
    readonly resultingState: string
  }
  readonly models: {
    readonly method: string
    readonly path: string
    readonly successStatuses: readonly number[]
    readonly loggedOutStatuses: readonly number[]
    readonly loggedOutErrorCode: string
  }
  readonly safeStatusForbiddenFields: readonly string[]
  readonly safeError: {
    readonly requiredFields: readonly string[]
    readonly forbiddenFields: readonly string[]
  }
  readonly reportSecretValues: readonly string[]
}

const fixtureFile = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'fixtures',
  'edge-code-contract.json'
)

export const edgeCodeContract = JSON.parse(
  fs.readFileSync(fixtureFile, 'utf8')
) as EdgeCodeContractFixture
