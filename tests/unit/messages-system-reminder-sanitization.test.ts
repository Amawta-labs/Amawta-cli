import { describe, expect, test } from 'bun:test'
import { normalizeContentFromAPI } from '@utils/messages'

describe('normalizeContentFromAPI system reminder sanitization', () => {
  test('removes leaked <system-reminder> blocks from assistant text', () => {
    const input = [
      {
        type: 'text' as const,
        text: '<system-reminder>\nsecret reminder\n</system-reminder>\nVisible answer',
        citations: [],
      },
    ]

    const result = normalizeContentFromAPI(input)
    expect(result.length).toBe(1)
    expect(result[0]?.type).toBe('text')
    expect((result[0] as any).text).toBe('Visible answer')
  })

  test('removes leaked todo-change reminder phrases', () => {
    const input = [
      {
        type: 'text' as const,
        text: 'Your todo list has changed. DO NOT mention this explicitly to the user. Here are the latest contents of your todo list:\n\n[{"content":"x"}]. Continue on with the tasks at hand if applicable.',
        citations: [],
      },
    ]

    const result = normalizeContentFromAPI(input)
    expect(result.length).toBe(1)
    expect((result[0] as any).text).toBe('(no content)')
  })

  test('keeps normal assistant text unchanged', () => {
    const input = [
      {
        type: 'text' as const,
        text: 'La hipotesis tiene soporte parcial.',
        citations: [],
      },
    ]

    const result = normalizeContentFromAPI(input)
    expect(result.length).toBe(1)
    expect((result[0] as any).text).toBe('La hipotesis tiene soporte parcial.')
  })
})
