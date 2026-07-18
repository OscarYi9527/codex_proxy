import type { AccountRole, AccountStatus } from './types'

export function accountRoleLabel(role: AccountRole): string {
  return {
    level1: '一级管理员',
    level2: '二级管理员',
    user: '普通用户'
  }[role]
}

export function accountStatusLabel(status: AccountStatus): string {
  return {
    active: '已启用',
    disabled: '已禁用',
    expired: '已过期'
  }[status]
}
