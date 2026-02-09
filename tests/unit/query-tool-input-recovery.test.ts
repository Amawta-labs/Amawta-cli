import { describe, expect, test } from 'bun:test'
import { z } from 'zod'
import { __queryTestOnly } from '@query'

describe('query tool input recovery', () => {
  test('recovers strict schema input by stripping unknown keys', () => {
    const tool = {
      name: 'StrictTool',
      inputSchema: z.strictObject({
        hypothesis_query: z.string().min(1),
      }),
    } as any

    const parsed = __queryTestOnly.safeParseToolInput(tool, {
      hypothesis_query: 'ok',
      literature_summary: 'extra key from model',
    })

    expect(parsed.success).toBe(true)
    if (parsed.success) {
      expect(parsed.data).toEqual({ hypothesis_query: 'ok' })
    }
  })

  test('keeps failing when required fields are missing', () => {
    const tool = {
      name: 'StrictTool',
      inputSchema: z.strictObject({
        hypothesis_query: z.string().min(1),
      }),
    } as any

    const parsed = __queryTestOnly.safeParseToolInput(tool, {
      literature_summary: 'extra key only',
    })

    expect(parsed.success).toBe(false)
  })
})
