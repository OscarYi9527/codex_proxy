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

  it('preserves both Responses and nested Chat Completions function tool shapes', () => {
    const request = responsesToChatCompletions({
      input: 'hello',
      tools: [
        {
          type: 'function',
          name: 'responses_tool',
          description: 'Responses shape',
          parameters: { type: 'object', properties: { value: { type: 'string' } } }
        },
        {
          type: 'function',
          function: {
            name: 'nested_tool',
            description: 'Chat Completions shape',
            parameters: { type: 'object', properties: { id: { type: 'number' } } }
          }
        }
      ],
      tool_choice: 'auto'
    }, 'gpt-5.4')

    assert.deepEqual(
      request.tools.map(tool => tool.function.name),
      ['responses_tool', 'nested_tool']
    )
    assert.equal(request.tools[1].function.description, 'Chat Completions shape')
    assert.equal(request.tool_choice, 'auto')
  })

  it('omits unnamed Responses built-ins rather than sending invalid function tools', () => {
    const request = responsesToChatCompletions({
      input: 'hello',
      tools: [
        { type: 'web_search_preview' },
        { type: 'function', function: { description: 'missing name' } }
      ],
      tool_choice: 'required'
    }, 'gpt-5.4')

    assert.equal(request.tools, undefined)
    assert.equal(request.tool_choice, undefined)
  })

  it('disables GPT-5.6 reasoning when converting function tools to Chat Completions', () => {
    const request = responsesToChatCompletions({
      input: 'hello',
      tools: [{
        type: 'function',
        name: 'read_file',
        parameters: { type: 'object', properties: {} }
      }]
    }, 'gpt-5.6-sol')

    assert.equal(request.reasoning_effort, 'none')
    assert.equal(request.tools[0].function.name, 'read_file')

    const earlierModelRequest = responsesToChatCompletions({
      input: 'hello',
      tools: [{
        type: 'function',
        name: 'read_file',
        parameters: { type: 'object', properties: {} }
      }]
    }, 'gpt-5.5')

    assert.equal(earlierModelRequest.reasoning_effort, undefined)
  })
})
