import { describe, expect, test } from 'bun:test'

import { __testOnly } from '../../src/ui/components/model-selector/modelFetchers'

describe('model fetchers (google)', () => {
  test('exposes curated Gemini 3 models for gemini provider', () => {
    const curated = __testOnly.getCuratedGoogleModels('gemini')
    const names = curated.map(model => model.model)

    expect(names).toContain('gemini-3-pro')
    expect(names).toContain('gemini-3-flash')
  })

  test('maps curated Gemini 3 models for adk provider', () => {
    const curated = __testOnly.getCuratedGoogleModels('adk')
    const providers = new Set(curated.map(model => model.provider))

    expect(providers.has('adk')).toBe(true)
    expect(curated.length).toBeGreaterThanOrEqual(2)
  })

  test('merges dynamic and curated models without duplicates', () => {
    const merged = __testOnly.mergeGoogleModelLists(
      [
        { model: 'gemini-3-pro-preview', provider: 'gemini' },
        { model: 'gemini-2.0-flash', provider: 'gemini' },
      ],
      [
        { model: 'gemini-3-pro', provider: 'gemini' },
        { model: 'gemini-3-flash', provider: 'gemini' },
      ],
    )

    const names = merged.map(model => model.model)
    expect(names.filter(name => name === 'gemini-3-pro-preview').length).toBe(1)
    expect(names.filter(name => name === 'gemini-3-pro').length).toBe(0)
    expect(names).toContain('gemini-3-flash')
    expect(names).not.toContain('gemini-2.0-flash')
  })
})
