import { RateService } from './rate-service.js'

const DEFAULT_MAX_OUTPUT_TOKENS = 4_096
const MAX_OUTPUT_TOKENS_LIMIT = 131_072

function textLength(value: unknown): number {
  if (typeof value === 'string') return value.length
  if (Array.isArray(value)) {
    return value.reduce<number>((sum, item) => sum + textLength(item), 0)
  }
  if (value && typeof value === 'object') {
    return Object.values(value as Record<string, unknown>)
      .reduce<number>((sum, item) => sum + textLength(item), 0)
  }
  return 0
}

function integer(value: unknown): number | null {
  const number = typeof value === 'number' ? value : Number(value)
  return Number.isSafeInteger(number) && number >= 0 ? number : null
}

export class RiskEstimator {
  constructor(private readonly rates: RateService) {}

  async estimate(modelId: string, body: Record<string, unknown>): Promise<{
    estimatedInputTokens: number
    maxOutputTokens: number
    reservedRiskCredits: string
  }> {
    const input = body['input'] ?? body['messages'] ?? body
    const estimatedInputTokens = Math.max(1, Math.ceil(textLength(input) / 4))
    const requestedOutput = integer(
      body['max_output_tokens'] ?? body['max_completion_tokens']
    )
    const maxOutputTokens = Math.min(
      requestedOutput ?? DEFAULT_MAX_OUTPUT_TOKENS,
      MAX_OUTPUT_TOKENS_LIMIT
    )
    const quote = await this.rates.quote(
      modelId,
      estimatedInputTokens,
      maxOutputTokens,
      'ceil'
    )
    return {
      estimatedInputTokens,
      maxOutputTokens,
      reservedRiskCredits: quote.totalCredits
    }
  }
}
