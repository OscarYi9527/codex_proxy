#!/usr/bin/env node
import assert from 'assert/strict'
import fs from 'fs'
import os from 'os'
import path from 'path'

const threadRoutesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-thread-routes-'))
process.env.CODEX_PROXY_THREAD_ROUTES_DIR = threadRoutesDir

const {
  anthropicToResponse,
  createServer,
  buildModelsResponse,
  getThreadId,
  isChatGptModel,
  isGptApiModel,
  parseThreadMetadata,
  readThreadRoute,
  readThreadRouteState,
  resolveCodexModel,
  responsesToAnthropic,
  sanitizeAnthropicMessages,
  toOpenAIApiModel,
  writeThreadRoute
} = await import('./codex-proxy.js')

let passed = 0
function test(name, fn) {
  try {
    fn()
    passed++
    console.log(`ok ${passed} - ${name}`)
  } catch (error) {
    console.error(`not ok - ${name}\n  ${error.stack}`)
    process.exitCode = 1
  }
}

async function testAsync(name, fn) {
  try {
    await fn()
    passed++
    console.log(`ok ${passed} - ${name}`)
  } catch (error) {
    console.error(`not ok - ${name}\n  ${error.stack}`)
    process.exitCode = 1
  }
}

test('parses Codex turn metadata from string and object payloads', () => {
  const fromString = parseThreadMetadata({
    client_metadata: { 'x-codex-turn-metadata': '{"thread_id":"t1","window_id":"w1"}' }
  })
  const fromObject = parseThreadMetadata({
    client_metadata: { 'x-codex-turn-metadata': { thread_id: 't2', session_id: 's2' } }
  })
  assert.equal(fromString.thread_id, 't1')
  assert.equal(fromString.window_id, 'w1')
  assert.equal(fromObject.thread_id, 't2')
  assert.equal(fromObject.session_id, 's2')
})

test('extracts thread id from Codex metadata', () => {
  assert.equal(getThreadId({ client_metadata: { 'x-codex-turn-metadata': '{"thread_id":"thread-123"}' } }), 'thread-123')
  assert.equal(getThreadId({ metadata: { threadId: 'thread-456' } }), 'thread-456')
  assert.equal(getThreadId({}), null)
})

test('persists and reads per-thread route state', () => {
  const payload = writeThreadRoute('thread-a', 'deepseek-v4-pro', 'high')
  assert.equal(payload.thread_id, 'thread-a')
  assert.equal(readThreadRoute('thread-a'), 'deepseek-v4-pro')
  assert.equal(readThreadRouteState('thread-a').reasoning_effort, 'high')
})

test('native body.model overrides legacy thread route state', () => {
  writeThreadRoute('thread-b', 'deepseek-reasoner')
  const resolved = resolveCodexModel({
    client_metadata: { 'x-codex-turn-metadata': '{"thread_id":"thread-b"}' },
    model: 'deepseek-v4-pro'
  })
  assert.equal(resolved.threadId, 'thread-b')
  assert.equal(resolved.model, 'deepseek-v4-pro')
})

test('body.model is used when thread route is absent', () => {
  const resolved = resolveCodexModel({
    client_metadata: { 'x-codex-turn-metadata': '{"thread_id":"missing-thread"}' },
    model: 'deepseek-v4-pro'
  })
  assert.equal(resolved.model, 'deepseek-v4-pro')
})

test('converts Responses messages and function tools', () => {
  const { request } = responsesToAnthropic({
    model: 'deepseek-v4-pro',
    instructions: 'Be concise.',
    input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hello' }] }],
    tools: [{ type: 'function', name: 'lookup', description: 'Lookup', parameters: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] } }],
    stream: true
  }, 'gpt-5.5')
  assert.equal(request.system, 'Be concise.')
  assert.equal(request.messages[0].content[0].text, 'hello')
  assert.equal(request.tools[0].name, 'lookup')
  assert.equal(request.stream, true)
  assert.equal(request.model, 'gpt-5.5')
})

test('converts function call history and output', () => {
  const { request } = responsesToAnthropic({
    input: [
      { type: 'function_call', call_id: 'call_1', name: 'lookup', arguments: '{"q":"x"}' },
      { type: 'function_call_output', call_id: 'call_1', output: 'result' }
    ]
  })
  assert.equal(request.messages[0].content[0].type, 'tool_use')
  assert.deepEqual(request.messages[0].content[0].input, { q: 'x' })
  assert.equal(request.messages[1].content[0].type, 'tool_result')
})

test('sanitizes orphan tool calls left by trimmed Responses history', () => {
  const { request } = responsesToAnthropic({
    input: [
      { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'I will inspect it.' }] },
      { type: 'function_call', call_id: 'call_missing', name: 'lookup', arguments: '{"q":"x"}' },
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'new large prompt' }] }
    ]
  })
  assert.equal(request.messages[0].role, 'assistant')
  assert.equal(request.messages[0].content.some(block => block.type === 'tool_use'), false)
  assert.match(request.messages[0].content.at(-1).text, /Tool call omitted/)
  assert.equal(request.messages[1].content[0].text, 'new large prompt')
})

test('sanitizes orphan tool call at assistant message content index 1', () => {
  const { request } = responsesToAnthropic({
    input: [
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'first prompt' }] },
      { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'I will inspect it.' }] },
      { type: 'function_call', call_id: 'call_orphan', name: 'shell_command', arguments: '{"command":"pwd"}' },
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'continue without tool output' }] }
    ]
  })
  assert.equal(request.messages[1].role, 'assistant')
  assert.equal(request.messages[1].content[0].type, 'text')
  assert.equal(request.messages[1].content[1].type, 'text')
  assert.equal(request.messages[1].content.some(block => block.type === 'tool_use'), false)
  assert.match(request.messages[1].content[1].text, /Tool call omitted/)
  assert.equal(request.messages[2].role, 'user')
  assert.equal(request.messages[2].content[0].text, 'continue without tool output')
})

test('keeps valid tool results directly after matching tool calls', () => {
  const messages = sanitizeAnthropicMessages([
    { role: 'assistant', content: [{ type: 'tool_use', id: 'call_1', name: 'lookup', input: { q: 'x' } }] },
    { role: 'user', content: [
      { type: 'text', text: 'extra context' },
      { type: 'tool_result', tool_use_id: 'call_1', content: 'result' }
    ] }
  ])
  assert.equal(messages[0].content[0].type, 'tool_use')
  assert.equal(messages[1].content[0].type, 'tool_result')
  assert.equal(messages[1].content[1].text, 'extra context')
})

test('moves assistant text before tool calls when Codex records it after them', () => {
  const { request } = responsesToAnthropic({
    input: [
      { type: 'function_call', call_id: 'call_1', name: 'lookup', arguments: '{"q":"x"}' },
      { type: 'function_call', call_id: 'call_2', name: 'lookup', arguments: '{"q":"y"}' },
      { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Running both lookups.' }] },
      { type: 'function_call_output', call_id: 'call_1', output: 'first' },
      { type: 'function_call_output', call_id: 'call_2', output: 'second' }
    ]
  })
  assert.deepEqual(request.messages[0].content.map(block => block.type), ['text', 'tool_use', 'tool_use'])
  assert.deepEqual(request.messages[1].content.map(block => block.type), ['tool_result', 'tool_result'])
})

test('wraps custom tools for Anthropic and restores custom calls', () => {
  const converted = responsesToAnthropic({
    input: 'patch it',
    tools: [{ type: 'custom', name: 'apply_patch', description: 'Patch files' }]
  })
  assert.deepEqual(converted.request.tools[0].input_schema.required, ['input'])
  const response = anthropicToResponse({
    id: 'msg_1',
    content: [{ type: 'tool_use', id: 'call_2', name: 'apply_patch', input: { input: '*** Begin Patch' } }],
    usage: { input_tokens: 10, output_tokens: 3 }
  }, { model: 'deepseek-v4-pro' }, converted.customTools)
  assert.equal(response.output[0].type, 'custom_tool_call')
  assert.equal(response.output[0].input, '*** Begin Patch')
  assert.equal(response.usage.total_tokens, 13)
})

test('converts text responses', () => {
  const response = anthropicToResponse({
    id: 'msg_2', content: [{ type: 'text', text: 'done' }], usage: { input_tokens: 4, output_tokens: 2 }
  }, { model: 'deepseek-v4-pro' })
  assert.equal(response.status, 'completed')
  assert.equal(response.output[0].content[0].text, 'done')
})

test('maps required and disabled tool choice', () => {
  const required = responsesToAnthropic({
    input: 'use it', tool_choice: 'required',
    tools: [{ type: 'function', name: 'lookup', parameters: { type: 'object', properties: {} } }]
  }).request
  assert.deepEqual(required.tool_choice, { type: 'any' })

  const disabled = responsesToAnthropic({
    input: 'do not use it', tool_choice: 'none',
    tools: [{ type: 'function', name: 'lookup', parameters: { type: 'object', properties: {} } }]
  }).request
  assert.equal(disabled.tools, undefined)
})

test('serves both Codex and OpenAI model catalog shapes', () => {
  const response = buildModelsResponse(
    [{ slug: 'deepseek-v4-pro', display_name: 'DeepSeek V4 Pro' }],
    [{ slug: 'gpt-5.5', display_name: 'GPT-5.5' }, { slug: 'deepseek-v4-pro' }]
  )
  assert.deepEqual(response.models.map(model => model.slug), ['deepseek-v4-pro', 'gpt-5.5'])
  assert.deepEqual(response.data.map(model => model.id), ['deepseek-v4-pro', 'gpt-5.5'])
})

test('classifies GPT subscription and API model variants separately', () => {
  assert.equal(isChatGptModel('gpt-5.5'), true)
  assert.equal(isChatGptModel('gpt-5.5-api'), false)
  assert.equal(isGptApiModel('gpt-5.5-api'), true)
  assert.equal(isGptApiModel('gpt-5.4-api-mini'), true)
  assert.equal(toOpenAIApiModel('gpt-5.5-api'), 'gpt-5.5')
  assert.equal(toOpenAIApiModel('gpt-5.4-api'), 'gpt-5.4')
  assert.equal(toOpenAIApiModel('gpt-5.4-api-mini'), 'gpt-5.4-mini')
})

await testAsync('control route survives PUT, GET, DELETE, and a following request', async () => {
  const server = createServer()
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  const base = `http://127.0.0.1:${port}`
  try {
    const put = await fetch(`${base}/control/threads/control-test/route`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'deepseek-reasoner', reasoning_effort: 'high' })
    })
    assert.equal(put.status, 200)

    const get = await fetch(`${base}/control/threads/control-test/route`)
    assert.equal(get.status, 200)
    const route = await get.json()
    assert.equal(route.model, 'deepseek-reasoner')
    assert.equal(route.reasoning_effort, 'high')

    const del = await fetch(`${base}/control/threads/control-test/route`, { method: 'DELETE' })
    assert.equal(del.status, 200)
    assert.equal((await del.json()).cleared, true)

    const models = await fetch(`${base}/v1/models`)
    assert.equal(models.status, 200)
    assert.deepEqual((await models.json()).data.map(model => model.id), [
      'deepseek-v4-pro', 'gpt-5.5', 'gpt-5.4', 'gpt-5.4-mini',
      'gpt-5.5-api', 'gpt-5.4-api', 'gpt-5.4-api-mini'
    ])
  } finally {
    await new Promise(resolve => server.close(resolve))
  }
})

await testAsync('forwards native GPT model selections with Codex subscription headers', async () => {
  const seen = []
  const server = createServer({
    fetchImpl: async (url, options) => {
      seen.push({ url, options, body: JSON.parse(options.body) })
      return new Response(JSON.stringify({
        id: 'resp_gpt', object: 'response', status: 'completed', model: 'gpt-5.5', output: []
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  try {
    writeThreadRoute('gpt-thread', 'deepseek-v4-pro', 'low')
    const response = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer test-token',
        'chatgpt-account-id': 'test-account',
        'x-openai-internal-codex-responses-lite': 'true',
        'x-codex-turn-metadata': '{"thread_id":"gpt-thread"}'
      },
      body: JSON.stringify({
        model: 'gpt-5.5', reasoning: { effort: 'xhigh' }, input: 'hello', stream: false,
        client_metadata: { 'x-codex-turn-metadata': '{"thread_id":"gpt-thread"}' }
      })
    })
    assert.equal(response.status, 200)
    assert.equal((await response.json()).model, 'gpt-5.5')
    assert.equal(seen[0].url, 'https://chatgpt.com/backend-api/codex/responses')
    assert.equal(seen[0].body.model, 'gpt-5.5')
    assert.equal(seen[0].body.reasoning.effort, 'xhigh')
    assert.equal(seen[0].options.headers.authorization, 'Bearer test-token')
    assert.equal(seen[0].options.headers['chatgpt-account-id'], 'test-account')
    assert.equal(seen[0].options.headers['x-openai-internal-codex-responses-lite'], 'true')
  } finally {
    await new Promise(resolve => server.close(resolve))
  }
})

await testAsync('routes GPT API model variants to OpenAI API key upstream', async () => {
  const previousKey = process.env.OPENAI_API_KEY
  process.env.OPENAI_API_KEY = 'sk-test-openai'
  const seen = []
  const server = createServer({
    fetchImpl: async (url, options) => {
      seen.push({ url, options, body: JSON.parse(options.body) })
      return new Response(JSON.stringify({
        id: 'resp_api', object: 'response', status: 'completed', model: 'gpt-5.5', output: []
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  try {
    const response = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-openai-internal-codex-responses-lite': 'true'
      },
      body: JSON.stringify({
        model: 'gpt-5.5-api',
        reasoning: { effort: 'high' },
        input: 'hello',
        client_metadata: { 'x-codex-turn-metadata': '{"thread_id":"api-thread"}' }
      })
    })
    assert.equal(response.status, 200)
    assert.equal((await response.json()).model, 'gpt-5.5')
    assert.equal(seen[0].url, 'https://api.openai.com/v1/responses')
    assert.equal(seen[0].body.model, 'gpt-5.5')
    assert.equal(seen[0].body.reasoning.effort, 'high')
    assert.equal(seen[0].body.client_metadata, undefined)
    assert.equal(seen[0].options.headers.authorization, 'Bearer sk-test-openai')
    assert.equal(seen[0].options.headers['chatgpt-account-id'], undefined)
    assert.equal(seen[0].options.headers['x-openai-internal-codex-responses-lite'], undefined)
  } finally {
    await new Promise(resolve => server.close(resolve))
    if (previousKey == null) delete process.env.OPENAI_API_KEY
    else process.env.OPENAI_API_KEY = previousKey
  }
})

await testAsync('retries GPT without Responses Lite only when the upstream rejects it', async () => {
  const seen = []
  const server = createServer({
    fetchImpl: async (_url, options) => {
      seen.push(options.headers)
      if (seen.length === 1) {
        return new Response(JSON.stringify({
          type: 'error',
          error: {
            type: 'invalid_request_error',
            code: 'unsupported_value',
            message: 'This model is not supported when using X-OpenAI-Internal-Codex-Responses-Lite.',
            param: 'model'
          }
        }), { status: 400, headers: { 'content-type': 'application/json' } })
      }
      return new Response(JSON.stringify({
        id: 'resp_standard', object: 'response', status: 'completed', model: 'gpt-5.4', output: []
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  try {
    const response = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer test-token',
        'chatgpt-account-id': 'test-account',
        'x-openai-internal-codex-responses-lite': 'true'
      },
      body: JSON.stringify({ model: 'gpt-5.4', input: 'hello', stream: false })
    })
    assert.equal(response.status, 200)
    assert.equal((await response.json()).model, 'gpt-5.4')
    assert.equal(seen.length, 2)
    assert.equal(seen[0]['x-openai-internal-codex-responses-lite'], 'true')
    assert.equal(seen[1]['x-openai-internal-codex-responses-lite'], undefined)
  } finally {
    await new Promise(resolve => server.close(resolve))
  }
})

await testAsync('ignores legacy thread routes for normal proxy requests', async () => {
  const seen = []
  const server = createServer({
    fetchImpl: async (_url, options) => {
      seen.push(JSON.parse(options.body))
      return new Response(JSON.stringify({
        id: 'msg_thread',
        content: [{ type: 'text', text: 'ok' }],
        usage: { input_tokens: 1, output_tokens: 1 }
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      })
    }
  })

  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  try {
    writeThreadRoute('thread-x', 'deepseek-reasoner')
    await fetch(`http://127.0.0.1:${port}/v1/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'deepseek-v4-pro',
        input: 'hello',
        client_metadata: { 'x-codex-turn-metadata': '{"thread_id":"thread-x"}' }
      })
    })

    await fetch(`http://127.0.0.1:${port}/v1/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'deepseek-v4-pro',
        input: 'hello again',
        client_metadata: { 'x-codex-turn-metadata': '{"thread_id":"thread-y"}' }
      })
    })

    assert.equal(seen[0].model, 'deepseek-v4-pro')
    assert.equal(seen[1].model, 'deepseek-v4-pro')
  } finally {
    await new Promise(resolve => server.close(resolve))
  }
})

console.log(`1..${passed}`)
