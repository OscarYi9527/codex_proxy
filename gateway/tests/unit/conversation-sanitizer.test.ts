import {
  CONVERSATION_REDACTION_VERSION,
  extractAssistantText,
  extractUserText,
  sanitizeConversationText
} from '../../src/audit/conversation-sanitizer.js'

describe('conversation sanitizer (T100/T104)', () => {
  it('keeps only structured user and final assistant text', () => {
    const request = {
      instructions: 'SYSTEM-SECRET',
      input: [
        {
          type: 'message',
          role: 'developer',
          content: [{ type: 'input_text', text: 'DEVELOPER-SECRET' }]
        },
        {
          type: 'message',
          role: 'user',
          content: [
            { type: 'input_text', text: '请解释这个错误' },
            { type: 'input_file', filename: 'secret.ts', file_data: 'FILE-SECRET' },
            { type: 'input_image', image_url: 'data:image/png;base64,IMAGE-SECRET' }
          ]
        },
        {
          type: 'function_call_output',
          call_id: 'call_1',
          output: 'TOOL-SECRET'
        }
      ],
      messages: [
        { role: 'system', content: 'CHAT-SYSTEM-SECRET' },
        { role: 'user', content: [{ type: 'text', text: '补充普通问题' }] },
        { role: 'tool', content: 'CHAT-TOOL-SECRET' }
      ]
    }
    const response = {
      type: 'response.completed',
      response: {
        output: [{
          type: 'message',
          role: 'assistant',
          content: [
            { type: 'output_text', text: '这是最终回答。' },
            { type: 'reasoning', text: 'REASONING-SECRET' },
            { type: 'tool_call', arguments: 'TOOL-ARGUMENT-SECRET' }
          ]
        }]
      }
    }

    expect(extractUserText(request)).toBe('请解释这个错误\n\n补充普通问题')
    expect(extractAssistantText(response)).toBe('这是最终回答。')
    const combined = `${extractUserText(request)} ${extractAssistantText(response)}`
    expect(combined).not.toMatch(
      /SYSTEM-SECRET|DEVELOPER-SECRET|FILE-SECRET|IMAGE-SECRET|TOOL-SECRET|REASONING-SECRET|TOOL-ARGUMENT-SECRET/
    )
    expect(CONVERSATION_REDACTION_VERSION).toBeGreaterThan(0)
  })

  it('masks common credentials before truncating persisted text', () => {
    const openAiKey = ['sk', 'proj', 'abcdefghijklmnopqrstuvwxyz'].join('-')
    const githubKey = ['github', 'pat', 'abcdefghijklmnopqrstuvwxyz123456'].join('_')
    const awsKey = ['AKIA', '1234567890ABCDEF'].join('')
    const value = [
      `api_key=${openAiKey}`,
      'Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.payload.signature',
      'password: SuperSecretPassword',
      githubKey,
      awsKey,
      'ordinary text',
      'x'.repeat(20_000)
    ].join('\n')
    const sanitized = sanitizeConversationText(value)

    expect(sanitized).not.toContain(openAiKey)
    expect(sanitized).not.toContain('eyJhbGciOiJIUzI1NiJ9.payload.signature')
    expect(sanitized).not.toContain('SuperSecretPassword')
    expect(sanitized).not.toContain(githubKey)
    expect(sanitized).not.toContain(awsKey)
    expect(sanitized).toContain('[REDACTED]')
    expect(sanitized).toContain('ordinary text')
    expect(sanitized.length).toBeLessThanOrEqual(16_384)
  })

  it('supports Responses strings and Chat Completions without accepting non-user roles', () => {
    expect(extractUserText({ input: '直接提问' })).toBe('直接提问')
    expect(extractUserText({
      messages: [
        { role: 'developer', content: 'developer data' },
        { role: 'user', content: 'chat user data' },
        { role: 'assistant', content: 'old assistant data' }
      ]
    })).toBe('chat user data')
    expect(extractAssistantText({
      choices: [{ message: { role: 'assistant', content: 'chat final data' } }]
    })).toBe('chat final data')
  })
})
