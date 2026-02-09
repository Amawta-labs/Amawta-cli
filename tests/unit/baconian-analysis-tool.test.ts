import { describe, expect, test } from 'bun:test'
import { __testOnly } from '@tools/ai/BaconianAnalysisTool/BaconianAnalysisTool'

describe('BaconianAnalysisTool helpers', () => {
  test('truncates long ui text safely', () => {
    const longText =
      'Esta es una salida baconiana extensa para verificar truncamiento visual sin desbordes en el panel de tool runs.'
    const short = __testOnly.truncateForUi(longText, 36)
    expect(short.length).toBeLessThanOrEqual(36)
    expect(short.endsWith('...')).toBe(true)
  })
})
