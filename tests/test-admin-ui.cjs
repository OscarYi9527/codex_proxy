const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const {
  quotaResetState,
  applyQuotaResetButtonState,
  filterErrorGuides,
  loginPollDecision,
  extractOfficialLoginCandidates,
  accountCredentialDisplay,
  accountPoolTierDisplay,
  inspectDirectImportFiles,
  quotaResetFinalMessage
} = require('../src/admin_ui_behaviors.cjs')

describe('admin console product brand', () => {
  it('uses the TORVYE AI Gateway unified management brand', () => {
    const source = fs.readFileSync(require.resolve('../src/admin.html'), 'utf8')
    assert.match(source, /<title>TORVYE AI Gateway · 统一管理平台<\/title>/)
    assert.match(source, /<strong>TORVYE AI Gateway<\/strong><span>统一管理平台<\/span>/)
    assert.match(source, /<div class="brand-mark">T<\/div>/)
    assert.match(source, /<script src="\/admin\/runtime\.js"><\/script>/)
    assert.match(source, /<script src="\/admin\/app\.js"><\/script>/)
  })

  it('keeps one complete console source with isolated standalone and Gateway modes', () => {
    const app = fs.readFileSync(require.resolve('../src/admin_app.js'), 'utf8')
    const html = fs.readFileSync(require.resolve('../src/admin.html'), 'utf8')
    const accounts = fs.readFileSync(require.resolve('../src/admin_modules/accounts.js'), 'utf8')
    const tutorial = fs.readFileSync(require.resolve('../src/admin_modules/tutorial.js'), 'utf8')
    const settings = fs.readFileSync(require.resolve('../src/admin_modules/settings.js'), 'utf8')
    assert.match(app, /MANAGEMENT\.mode === 'gateway'/)
    assert.match(app, /bootstrapCentralManagement/)
    assert.match(app, /\/api\/v1\/webview\/session/)
    assert.match(app, /history\.replaceState/)
    assert.match(app, /filter\(\(\[,v\]\)=>\(Number\(v\.requests\)\|\|0\)>0\)/)
    assert.match(app, /const ADMIN_ACTIONS = new Set/)
    assert.match(app, /document\.addEventListener\(eventName,dispatchAdminAction\)/)
    for (const source of [html, app, accounts, tutorial]) {
      assert.doesNotMatch(source, /\s(?:onclick|onchange|oninput|onkeydown|ondragstart|ondragover|ondragleave|ondrop)=/)
    }
    assert.match(accounts, /CENTRAL_MANAGEMENT/)
    assert.match(settings, /renderGatewaySettings/)
  })
})

describe('admin quota reset DOM behavior', () => {
  it('keeps submission disabled until all confirmations match', () => {
    assert.equal(quotaResetState({ expectedAccount: 'Team A' }).ready, false)
    assert.equal(quotaResetState({
      expectedAccount: 'Team A',
      enteredAccount: 'Team B',
      targetConfirmed: true,
      creditConfirmed: true
    }).ready, false)
    assert.equal(quotaResetState({
      expectedAccount: 'Team A',
      enteredAccount: 'Team A',
      targetConfirmed: true,
      creditConfirmed: true
    }).ready, true)
  })

  it('mutates the submit button and protects duplicate submissions', () => {
    const attributes = {}
    const button = {
      disabled: false,
      textContent: '',
      dataset: {},
      setAttribute(name, value) { attributes[name] = value }
    }
    const state = quotaResetState({
      expectedAccount: 'Team A',
      enteredAccount: 'Team A',
      targetConfirmed: true,
      creditConfirmed: true,
      submitting: true
    })
    applyQuotaResetButtonState(button, state)
    assert.equal(button.disabled, true)
    assert.equal(button.textContent, '正在提交…')
    assert.equal(button.dataset.submitting, 'true')
    assert.equal(attributes['aria-disabled'], 'true')
  })

  it('builds an explicit irreversible final confirmation', () => {
    const message = quotaResetFinalMessage('Team A')
    assert.match(message, /Team A/)
    assert.match(message, /消耗 1 次/)
    assert.match(message, /无法撤销/)
  })
})

describe('admin error guide and login polling behavior', () => {
  it('asks for account classification in single and batch official login flows', () => {
    const source = fs.readFileSync(require.resolve('../src/admin_app.js'), 'utf8')
    assert.match(source, /id="login_pool_tier"/)
    assert.match(source, /id="batch_login_pool_tier"/)
    assert.match(source, /JSON\.stringify\(\{label,email:label,routingEnabled,poolTier\}\)/)
    assert.match(source, /email:current\.email,routingEnabled,poolTier/)
  })

  it('cancels stale login sessions when the modal closes or reopens', () => {
    const source = fs.readFileSync(require.resolve('../src/admin_app.js'), 'utf8')
    assert.match(source, /const shouldCancelLogin=Boolean\(activeLoginUi\)\|\|batchWaiting/)
    assert.match(source, /if\(shouldCancelLogin\)fetch\(API\+'\/chatgpt-login\/cancel'/)
    assert.match(source, /async function cancelStaleOfficialLogin\(\)/)
    assert.match(source, /if\(ignoreAccidentalModalTrigger\(event\)\)return/)
    assert.match(source, /openOfficialLogin\(event\)/)
  })

  it('offers synchronized quota refresh and a non-consuming all-account status check', () => {
    const appSource = fs.readFileSync(require.resolve('../src/admin_app.js'), 'utf8')
    const accountSource = fs.readFileSync(require.resolve('../src/admin_modules/accounts.js'), 'utf8')
    assert.match(appSource, /async function checkAllAccountStatus\(\)/)
    assert.match(appSource, /chatgpt-accounts\/check-all/)
    assert.match(appSource, /非消耗式状态检查/)
    assert.match(appSource, /正在同步账号用量和重置次数/)
    assert.match(accountSource, /检查所有账号/)
    assert.match(accountSource, /检查异常/)
    assert.match(accountSource, /同步全部额度\/次数/)
  })

  const guides = [
    { status: 402, title: 'Payment Required', meaning: '余额不足', causes: ['账单'], actions: ['充值'] },
    { status: 503, title: 'Unavailable', meaning: '账号池不可用', causes: ['排队超时'], actions: ['检查账号'] }
  ]

  it('searches status, meaning, causes, and actions', () => {
    assert.deepEqual(filterErrorGuides(guides, '503').map(item => item.status), [503])
    assert.deepEqual(filterErrorGuides(guides, '余额').map(item => item.status), [402])
    assert.deepEqual(filterErrorGuides(guides, '检查账号').map(item => item.status), [503])
    assert.equal(filterErrorGuides(guides, '').length, 2)
  })

  it('only stops polling for terminal login states', () => {
    assert.equal(loginPollDecision('waiting').keepPolling, true)
    assert.equal(loginPollDecision('success').outcome, 'success')
    assert.equal(loginPollDecision('error').terminal, true)
    assert.equal(loginPollDecision('cancelled').keepPolling, false)
    assert.equal(loginPollDecision('unexpected').keepPolling, true)
  })

  it('extracts and merges local CPA, sub2, and companion TXT login candidates', () => {
    const candidates = extractOfficialLoginCandidates([
      {
        name: 'account_cpa.json',
        content: JSON.stringify({
          email: 'user@example.test',
          password: 'openai-password',
          account_id: 'account-1',
          name: 'CPA account'
        })
      },
      {
        name: 'account_sub2.json',
        content: JSON.stringify({
          accounts: [{
            name: 'sub2 duplicate',
            credentials: {
              email: 'user@example.test',
              account_id: 'account-1'
            }
          }]
        })
      },
      {
        name: 'account.txt',
        content: 'user@example.test--------mail-password----mail-client----mail-refresh-token'
      }
    ])

    assert.equal(candidates.length, 1)
    assert.equal(candidates[0].email, 'user@example.test')
    assert.equal(candidates[0].password, 'openai-password')
    assert.equal(candidates[0].accountId, 'account-1')
    assert.deepEqual(candidates[0].sourceNames, [
      'account_cpa.json',
      'account_sub2.json',
      'account.txt'
    ])
  })

  it('does not mistake mailbox TXT credentials for an OpenAI password', () => {
    const [candidate] = extractOfficialLoginCandidates([{
      name: 'mail.txt',
      content: 'mail@example.test--------mail-password----client-id----refresh-token'
    }])
    assert.equal(candidate.email, 'mail@example.test')
    assert.equal(candidate.password, '')
  })

  it('classifies renewable and temporary credentials with an expiry countdown', () => {
    const now = Date.parse('2026-07-19T00:00:00Z')
    assert.equal(accountCredentialDisplay({ credential_mode: 'refreshable' }, now).countdown, '自动续约')
    const temporary = accountCredentialDisplay({
      credential_mode: 'temporary_access',
      expires_at: now + (2 * 24 + 3) * 60 * 60 * 1000
    }, now)
    assert.equal(temporary.category, 'temporary')
    assert.equal(temporary.countdown, '2天 3小时')
    assert.equal(accountCredentialDisplay({
      credential_mode: 'temporary_access',
      expires_at: now + 30 * 60 * 1000
    }, now).category, 'expiring')
    assert.equal(accountCredentialDisplay({
      credential_mode: 'temporary_access',
      expires_at: now - 1
    }, now).category, 'expired')
    assert.equal(accountCredentialDisplay({
      credential_mode: 'temporary_access',
      credential_compatibility: 'incompatible_oauth_client',
      expires_at: now + 60_000
    }, now).category, 'incompatible')
  })

  it('classifies stable insurance and disposable account lifecycle states', () => {
    const now = Date.parse('2026-07-20T00:00:00Z')
    assert.equal(accountPoolTierDisplay({
      credential_mode: 'refreshable'
    }, now).label, '稳定保险池')
    assert.equal(accountPoolTierDisplay({
      credential_mode: 'temporary_access'
    }, now).label, '日抛优先池')
    const waiting = accountPoolTierDisplay({
      pool_tier: 'disposable',
      disposable_exhausted_at: '2026-07-19T00:00:00Z'
    }, now)
    assert.equal(waiting.exhausted, true)
    assert.equal(waiting.discarded, false)
    assert.equal(waiting.countdown, '6天 0小时')
    assert.equal(accountPoolTierDisplay({
      pool_tier: 'disposable',
      disposable_exhausted_at: '2026-07-12T00:00:00Z',
      disposable_discarded_at: '2026-07-19T00:00:00Z'
    }, now).label, '日抛 · 已弃号')
  })

  it('previews each direct-import file without returning token contents', () => {
    const now = Date.parse('2026-07-19T00:00:00Z')
    const payload = Buffer.from(JSON.stringify({
      exp: Math.floor(now / 1000) + 7200,
      client_id: 'app_EMoamEEZ73f0CkXaXp7hrann'
    })).toString('base64url')
    const preview = inspectDirectImportFiles([
      {
        name: 'temporary_cpa.json',
        content: JSON.stringify({
          access_token: `header.${payload}.secret`,
          account_id: 'temporary-preview',
          refresh_token: ''
        })
      },
      {
        name: 'renewable.json',
        content: JSON.stringify({
          tokens: {
            access_token: `header.${payload}.secret`,
            refresh_token: 'refresh-secret',
            account_id: 'renewable-preview'
          }
        })
      },
      {
        name: 'mail.txt',
        content: 'mail@example.test--------mail-password----client-id----mail-refresh'
      }
    ], now)
    assert.deepEqual(preview.map(item => ({
      name: item.name,
      accounts: item.accounts,
      temporary: item.temporary,
      refreshable: item.refreshable,
      incompatible: item.incompatible,
      duplicate_accounts: item.duplicate_accounts,
      importable: item.importable
    })), [
      { name: 'temporary_cpa.json', accounts: 1, temporary: 1, refreshable: 0, incompatible: 0, duplicate_accounts: 0, importable: true },
      { name: 'renewable.json', accounts: 1, temporary: 0, refreshable: 1, incompatible: 0, duplicate_accounts: 0, importable: true },
      { name: 'mail.txt', accounts: 0, temporary: 0, refreshable: 0, incompatible: 0, duplicate_accounts: 0, importable: false }
    ])
    assert.equal(preview[0].countdown, '2小时 0分钟')
    assert.doesNotMatch(JSON.stringify(preview), /secret/)
  })
})
