import { describe, expect, test } from 'bun:test'

import {
  getGeminiCycleTwinModelName,
  isGoogleModelProvider,
  normalizeGeminiModelName,
  toGeminiDisplayModelName,
} from '../../src/utils/model/geminiAliases'

describe('gemini model aliases', () => {
  test('normalizes Gemini 3 aliases to canonical preview IDs', () => {
    expect(normalizeGeminiModelName('gemini-3-pro')).toBe(
      'gemini-3-pro-preview',
    )
    expect(normalizeGeminiModelName('gemini3-flash')).toBe(
      'gemini-3-flash-preview',
    )
    expect(normalizeGeminiModelName('gemini-3-pro-preview')).toBe(
      'gemini-3-pro-preview',
    )
  })

  test('maps canonical preview IDs to display aliases', () => {
    expect(toGeminiDisplayModelName('gemini-3-pro-preview')).toBe(
      'gemini-3-pro',
    )
    expect(toGeminiDisplayModelName('gemini-3-flash-preview')).toBe(
      'gemini-3-flash',
    )
    expect(toGeminiDisplayModelName('gemini-2.0-flash')).toBe(
      'gemini-2.0-flash',
    )
  })

  test('identifies Gemini and ADK providers', () => {
    expect(isGoogleModelProvider('gemini')).toBe(true)
    expect(isGoogleModelProvider('adk')).toBe(true)
    expect(isGoogleModelProvider('openai')).toBe(false)
  })

  test('returns twin model for Gemini 3 flash/pro cycle', () => {
    expect(getGeminiCycleTwinModelName('gemini-3-flash')).toBe(
      'gemini-3-pro-preview',
    )
    expect(getGeminiCycleTwinModelName('gemini-3-pro')).toBe(
      'gemini-3-flash-preview',
    )
    expect(getGeminiCycleTwinModelName('gpt-5')).toBe(null)
  })
})
