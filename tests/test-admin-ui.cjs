const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const {
  quotaResetState,
  applyQuotaResetButtonState,
  filterErrorGuides,
  loginPollDecision,
  quotaResetFinalMessage
} = require('../src/admin_ui_behaviors.cjs')

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
})
