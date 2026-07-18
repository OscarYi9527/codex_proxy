import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { parseChatgptAccountImport } from '../src/account-import.js'

const tokens = (suffix = 'one') => ({
  access_token: `header.${suffix}.signature`,
  refresh_token: `refresh.${suffix}.signature`,
  id_token: `identity.${suffix}.signature`,
  account_id: `account-${suffix}`
})

describe('ChatGPT 多格式快捷导入', () => {
  it('兼容标准 auth.json', () => {
    const result = parseChatgptAccountImport(JSON.stringify({ tokens: tokens() }))
    assert.equal(result.length, 1)
    assert.equal(result[0].sourceFormat, 'auth.json')
    assert.equal(JSON.parse(result[0].authJson).tokens.account_id, 'account-one')
  })

  it('兼容 sub2 JSON 并使用名称作为备注', () => {
    const result = parseChatgptAccountImport(JSON.stringify({
      exported_at: '2026-07-18T00:00:00Z',
      accounts: [{
        name: 'sub2 account',
        credentials: {
          ...tokens('sub2'),
          client_id: 'public-client-id',
          chatgpt_account_id: 'workspace-sub2'
        },
        extra: { email: 'sub2@example.test' }
      }]
    }))
    assert.equal(result.length, 1)
    assert.equal(result[0].sourceFormat, 'sub2-json')
    assert.equal(result[0].label, 'sub2 account')
    assert.equal(result[0].accountId, 'account-sub2')
  })

  it('兼容 CPA 数组、camelCase 字段并去重', () => {
    const record = {
      label: 'CPA account',
      auth: {
        credentials: {
          accessToken: 'header.cpa.signature',
          refreshToken: 'refresh.cpa.signature',
          idToken: 'identity.cpa.signature',
          accountId: 'account-cpa'
        }
      }
    }
    const result = parseChatgptAccountImport(JSON.stringify([record, record]))
    assert.equal(result.length, 1)
    assert.equal(result[0].sourceFormat, 'cpa-json')
    assert.equal(result[0].accountId, 'account-cpa')
  })

  it('兼容键值 TXT 和带表头的制表符 TXT', () => {
    const keyValue = parseChatgptAccountImport([
      'email=user@example.test',
      'access_token=header.txt.signature',
      'refresh_token=refresh.txt.signature',
      'account_id=account-txt'
    ].join('\n'))
    assert.equal(keyValue[0].label, 'user@example.test')

    const table = parseChatgptAccountImport([
      'name\taccess_token\trefresh_token\taccount_id',
      'table account\theader.table.signature\trefresh.table.signature\taccount-table'
    ].join('\n'))
    assert.equal(table[0].accountId, 'account-table')
  })

  it('拒绝只有 client_id 和 refresh_token 的不完整文件', () => {
    assert.throws(
      () => parseChatgptAccountImport('client_id=client\nrefresh_token=refresh-only'),
      /不能离线导入/
    )
  })
})
