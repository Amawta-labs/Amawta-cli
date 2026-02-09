import { getGeminiCycleTwinModelName } from '@utils/model/geminiAliases'

const MODEL_OVERLOAD_TOKENS = [
  '503',
  'high demand',
  'overloaded',
  'service unavailable',
  'temporarily unavailable',
  'resource exhausted',
  'rate limit',
  'quota exceeded',
  'deadline exceeded',
]

const MIN_OVERLOAD_RETRY_DELAY_MS = 3_500

export function isModelOverloadError(error: unknown): boolean {
  const message = String((error as any)?.message || error || '').toLowerCase()
  if (!message) return false
  return MODEL_OVERLOAD_TOKENS.some(token => message.includes(token))
}

export function computeRetryDelayWithOverload(
  baseDelayMs: number,
  error: unknown,
): number {
  if (!isModelOverloadError(error)) {
    return baseDelayMs
  }
  return Math.max(baseDelayMs, MIN_OVERLOAD_RETRY_DELAY_MS)
}

export function maybeSwitchGeminiFailoverModel(params: {
  currentModelName: string
  error: unknown
  failoverAlreadyUsed: boolean
}): { modelName: string; switched: boolean } {
  if (params.failoverAlreadyUsed || !isModelOverloadError(params.error)) {
    return { modelName: params.currentModelName, switched: false }
  }

  const twin = getGeminiCycleTwinModelName(params.currentModelName)
  if (!twin || twin === params.currentModelName) {
    return { modelName: params.currentModelName, switched: false }
  }

  return { modelName: twin, switched: true }
}
