import { describe, expect, test } from 'bun:test'
import { __testOnly } from '@tools/ai/HypothesisNormalizationTool/HypothesisNormalizationTool'
import { HypothesisNormalizationTool } from '@tools/ai/HypothesisNormalizationTool/HypothesisNormalizationTool'

describe('HypothesisNormalizationTool helpers', () => {
  test('normalizes missing-field tokens with accents and spacing', () => {
    expect(__testOnly.normalizeFieldToken('Relación')).toBe('relacion')
    expect(__testOnly.normalizeFieldToken(' expected direction ')).toBe(
      'expected_direction',
    )
  })

  test('collects critical missing fields from explicit and inferred gaps', () => {
    const missing = __testOnly.collectCriticalMissingFields({
      claim: '',
      domain: 'control',
      entities: [],
      relation: '',
      observables: ['y'],
      expected_direction: '',
      conditions: '',
      time_scope: '',
      notes: '',
      missing_fields: ['Dominio', 'Relación'],
      clarification_required: true,
      clarification_questions: [],
    } as any)

    expect(missing).toContain('claim')
    expect(missing).toContain('entities')
    expect(missing).toContain('relation')
    expect(missing).not.toContain('domain')
  })

  test('does not treat non-core fields as critical gate blockers', () => {
    const missing = __testOnly.collectCriticalMissingFields({
      claim: 'x affects y',
      domain: 'control',
      entities: ['x', 'y'],
      relation: 'affects',
      observables: ['y'],
      expected_direction: '',
      conditions: '',
      time_scope: '',
      notes: '',
      missing_fields: ['expected_direction', 'conditions'],
      clarification_required: true,
      clarification_questions: [],
    } as any)

    expect(missing).toEqual([])
  })

  test('builds clarification template with AskUserQuestion-compatible schema', () => {
    const template = __testOnly.buildClarificationTemplate([
      'claim',
      'domain',
      'entities',
      'relation',
      'observables',
    ])
    const parsed = JSON.parse(template)
    expect(Array.isArray(parsed.questions)).toBe(true)
    expect(parsed.questions.length).toBe(4)
    expect(parsed.questions[0].options.length).toBe(3)
    expect(parsed.questions[0].multiSelect).toBe(false)
  })

  test('builds stable cache key', () => {
    const context = {
      options: {
        messageLogName: 'default',
        forkNumber: 0,
      },
      agentId: 'main',
    } as any

    const keyA = __testOnly.buildNormalizationCacheKey(
      {
        hypothesis_query: 'X causa Y',
        dialectical_synthesis: 'S',
        baconian_forma_veritas: 'V',
      },
      context,
    )
    const keyB = __testOnly.buildNormalizationCacheKey(
      {
        hypothesis_query: 'X   causa  Y',
        dialectical_synthesis: 'S',
        baconian_forma_veritas: 'V',
      },
      context,
    )

    expect(keyA).toBe(keyB)
  })

  test('assistant guidance requires AskUserQuestion when core fields are missing', () => {
    const guidance = (HypothesisNormalizationTool as any).renderResultForAssistant({
      analysis: '',
      model: 'gemini-3-flash-preview',
      retriesUsed: 0,
      strictRetriesUsed: 0,
      autoRetriesUsed: 0,
      modeUsed: 'strict',
      autoCorrectionAttempted: false,
      autoCorrectionImproved: false,
      normalizationOk: false,
      criticalMissingFields: ['claim', 'relation'],
      normalization: {
        claim: '',
        domain: 'control',
        entities: ['x', 'u'],
        relation: '',
        observables: ['curvature'],
        expected_direction: '',
        conditions: '',
        time_scope: '',
        notes: '',
        missing_fields: ['claim', 'relation'],
        clarification_required: true,
        clarification_questions: [],
      },
    })

    expect(guidance).toContain('AskUserQuestion')
    expect(guidance).toContain('Amawta Selector')
    expect(guidance).toContain('Do not run FalsificationPlan')
  })

  test('assistant guidance advances to FalsificationPlan when normalization is complete', () => {
    const guidance = (HypothesisNormalizationTool as any).renderResultForAssistant({
      analysis: '',
      model: 'gemini-3-flash-preview',
      retriesUsed: 0,
      strictRetriesUsed: 0,
      autoRetriesUsed: 0,
      modeUsed: 'autocorrect',
      autoCorrectionAttempted: true,
      autoCorrectionImproved: true,
      normalizationOk: true,
      criticalMissingFields: [],
      normalization: {
        claim: 'x influences y',
        domain: 'control',
        entities: ['x', 'y'],
        relation: 'influences',
        observables: ['y'],
        expected_direction: 'positive',
        conditions: 'bounded noise',
        time_scope: 'short-term',
        notes: '',
        missing_fields: [],
        clarification_required: false,
        clarification_questions: [],
      },
    })

    expect(guidance).toContain('invoke FalsificationPlan')
    expect(guidance).not.toContain('Do not run FalsificationPlan')
  })
})
