import { describe, expect, test } from 'bun:test'
import { __testOnly } from '@tools/ai/DialecticalAnalysisTool/DialecticalAnalysisTool'

describe('DialecticalAnalysisTool helpers', () => {
  test('truncates long ui text safely', () => {
    const longText =
      'Esta es una frase muy larga para validar que el recorte visual del tool en UI no se desborde innecesariamente.'
    const short = __testOnly.truncateForUi(longText, 32)
    expect(short.length).toBeLessThanOrEqual(32)
    expect(short.endsWith('...')).toBe(true)
  })

  test('builds stable cache key from last user prompt for same turn', () => {
    const context = {
      options: {
        messageLogName: 'default',
        forkNumber: 0,
        lastUserPrompt: 'Probemos esta hipotesis compleja sobre esfuerzo y gauge.',
      },
      agentId: 'main',
    } as any

    const keyA = __testOnly.buildDialecticalCacheKey(
      { hypothesis_query: 'version A', context: 'ctx A' },
      context,
    )
    const keyB = __testOnly.buildDialecticalCacheKey(
      { hypothesis_query: 'version B', context: 'ctx B' },
      context,
    )

    expect(keyA).toBe(keyB)
  })
})
