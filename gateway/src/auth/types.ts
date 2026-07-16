export type AccountRole = 'level1' | 'level2' | 'user'
export type AccountStatus = 'active' | 'disabled' | 'expired'
export type DevicePlatform = 'windows' | 'macos' | 'other'

export interface ProductAccount {
  readonly id: string
  readonly loginName: string | null
  readonly email: string | null
  readonly role: AccountRole
  readonly organizationId: string | null
  readonly organizationName: string | null
  readonly organizationStatus: 'active' | 'disabled' | null
  readonly status: AccountStatus
  readonly expiresAt: string | null
  readonly mustChangePassword: boolean
  readonly mustProvideEmail: boolean
  readonly version: number
}

export interface AccessIdentity {
  readonly accountId: string
  readonly deviceSessionId: string
  readonly role: AccountRole
  readonly organizationId: string | null
  readonly accountVersion: number
  readonly passwordVersion: number
}

export interface IssuedTokenSet {
  readonly accessToken: string
  readonly accessTokenExpiresIn: number
  readonly refreshToken: string
  readonly refreshTokenExpiresIn: number
  readonly deviceSessionId: string
  readonly account: {
    readonly id: string
    readonly display: string
    readonly role: AccountRole
    readonly organizationId: string | null
    readonly mustChangePassword: boolean
    readonly mustProvideEmail: boolean
  }
}

export interface DeviceDescriptor {
  readonly name: string
  readonly platform: DevicePlatform
}
