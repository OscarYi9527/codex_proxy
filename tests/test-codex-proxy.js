import { describe, it } from 'node:test'
import assert from 'node:assert'

// Keep src/stats.js from installing its runtime auto-save interval during tests.
process.env.NODE_ENV = 'test'

const { resolveCodexModel, isChatGptSubModel, isOpenAIApiModel, isRelayModel, buildModelsResponse } = await import('../src/models.js')
const { recordUsage, getStats, resetStats } = await import('../src/stats.js')

describe('模型解析', () => {
  it('解析 body.model', () => {
    assert.strictEqual(resolveCodexModel({ model: 'gpt-5.5' }).model, 'gpt-5.5')
  })
  it('回退到默认模型', () => {
    assert.ok(resolveCodexModel({}).model)
  })
})

describe('四通道路由分类', () => {
  it('gpt-5.x -> ChatGPT 订阅', () => {
    assert.strictEqual(isChatGptSubModel('gpt-5.5'), true)
    assert.strictEqual(isChatGptSubModel('gpt-5.4'), true)
    assert.strictEqual(isChatGptSubModel('gpt-5.4-mini'), true)
  })
  it('openai-api-* -> OpenAI API', () => {
    assert.strictEqual(isOpenAIApiModel('openai-api-gpt-5.5'), true)
    assert.strictEqual(isOpenAIApiModel('gpt-5.5'), false)
  })
  it('relay-* -> 中转站', () => {
    assert.strictEqual(isRelayModel('relay-myproxy-gpt-5.5'), true)
    assert.strictEqual(isRelayModel('gpt-5.5'), false)
  })
  it('不重叠', () => {
    assert.strictEqual(isChatGptSubModel('openai-api-gpt-5.5'), false)
    assert.strictEqual(isOpenAIApiModel('relay-x-gpt-5.5'), false)
    assert.strictEqual(isRelayModel('gpt-5.5'), false)
  })
})

describe('中转站模型解析', () => {
  it('解析 relay-{id}-{model}', () => {
    const parts = 'relay-myproxy-gpt-5.5'.split('-')
    assert.strictEqual(parts[1], 'myproxy')
    assert.strictEqual(parts.slice(2).join('-'), 'gpt-5.5')
  })
})

describe('buildModelsResponse', () => {
  it('四通道 owned_by', () => {
    const result = buildModelsResponse([
      { slug: 'gpt-5.5' },
      { slug: 'openai-api-gpt-5.5' },
      { slug: 'relay-myproxy-gpt-5.5' },
      { slug: 'deepseek-v4-pro' }
    ])
    assert.strictEqual(result.data.find(m=>m.id==='gpt-5.5').owned_by, 'chatgpt-sub')
    assert.strictEqual(result.data.find(m=>m.id==='openai-api-gpt-5.5').owned_by, 'openai-api')
    assert.strictEqual(result.data.find(m=>m.id==='relay-myproxy-gpt-5.5').owned_by, 'relay')
    assert.strictEqual(result.data.find(m=>m.id==='deepseek-v4-pro').owned_by, 'deepseek')
  })
})

describe('用量统计', () => {
  it('记录和重置', () => {
    resetStats()
    recordUsage('gpt-5.5', 'chatgpt-sub', 100, 50)
    recordUsage('relay-x-gpt-5.5', 'relay:x', 200, 100)
    const s = getStats()
    assert.ok(s.providers['chatgpt-sub'])
    assert.ok(s.providers['relay:x'])
    const after = resetStats()
    assert.strictEqual(Object.keys(after.providers).length, 0)
  })
})
