import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { responsesToChatCompletions } from '../src/convert/chat-completions.js'

describe('Responses to Chat Completions conversion', () => {
  it('uses max_completion_tokens for GPT-5 family models', () => {
    const request = responsesToChatCompletions({
      input: 'hello',
      max_output_tokens: 512,
      stream: true
    }, 'gpt-5.1-codex')

    assert.equal(request.max_completion_tokens, 512)
    assert.equal(request.max_tokens, undefined)
    assert.equal(request.stream, true)
  })

  it('uses max_completion_tokens for o-series reasoning models', () => {
    const request = responsesToChatCompletions({ input: 'hello' }, 'o3-mini')

    assert.equal(request.max_completion_tokens, 4096)
    assert.equal(request.max_tokens, undefined)
  })

  it('keeps max_tokens for legacy chat-completions models', () => {
    const request = responsesToChatCompletions({ input: 'hello' }, 'gpt-4o-mini')

    assert.equal(request.max_tokens, 4096)
    assert.equal(request.max_completion_tokens, undefined)
  })
})
