import { describe, expect, test } from 'bun:test'
import { __testOnly } from '@services/ai/llm'

describe('llm retry helpers', () => {
  test('retries non-API errors with 503/unavailable semantics', () => {
    expect(
      __testOnly.shouldRetryNonApiError({
        status: 503,
        message: 'The model is overloaded. Please try again later.',
      }),
    ).toBe(true)

    expect(
      __testOnly.shouldRetryNonApiError({
        code: '503',
        message: 'UNAVAILABLE',
      }),
    ).toBe(true)
  })

  test('does not retry generic non-retryable errors', () => {
    expect(
      __testOnly.shouldRetryNonApiError({
        status: 400,
        message: 'invalid request payload',
      }),
    ).toBe(false)
  })

  test('extracts numeric status codes from diverse shapes', () => {
    expect(__testOnly.extractErrorStatusCode({ status: 503 })).toBe(503)
    expect(__testOnly.extractErrorStatusCode({ code: '429' })).toBe(429)
    expect(__testOnly.extractErrorStatusCode({ error: { code: 504 } })).toBe(
      504,
    )
  })
})

