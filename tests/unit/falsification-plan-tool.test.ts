import { describe, expect, test } from 'bun:test'
import {
  __testOnly,
  FalsificationPlanTool,
  getReadyFalsificationResultForTurn,
} from '@tools/ai/FalsificationPlanTool/FalsificationPlanTool'

describe('FalsificationPlanTool helpers', () => {
  test('truncates long ui text safely', () => {
    const longText =
      'Este es un texto largo para validar el truncamiento del output de falsificacion sin romper el layout visual del timeline.'
    const short = __testOnly.truncateForUi(longText, 40)
    expect(short.length).toBeLessThanOrEqual(40)
    expect(short.endsWith('...')).toBe(true)
  })

  test('builds stable cache key for same normalized payload', () => {
    const context = {
      options: {
        messageLogName: 'default',
        forkNumber: 0,
      },
      agentId: 'main',
    } as any

    const keyA = __testOnly.buildFalsificationCacheKey(
      {
        hypothesis_query: 'X causa Y',
        hypothesis_cleaned: 'X incrementa Y',
        normalization_ok: true,
        missing_fields: ['time_scope'],
      },
      context,
    )

    const keyB = __testOnly.buildFalsificationCacheKey(
      {
        hypothesis_query: 'X   causa   Y',
        hypothesis_cleaned: 'X incrementa Y',
        normalization_ok: true,
        missing_fields: ['time_scope'],
      },
      context,
    )

    expect(keyA).toBe(keyB)
  })

  test('accepts dialectical_synthesis alias in input schema', () => {
    const parsed = FalsificationPlanTool.inputSchema.safeParse({
      hypothesis_query: 'X causa Y bajo condiciones Z',
      dialectical_synthesis: 'Síntesis dialéctica de ejemplo',
    })
    expect(parsed.success).toBe(true)
  })

  test('accepts baconian_forma_veritas alias in input schema', () => {
    const parsed = FalsificationPlanTool.inputSchema.safeParse({
      hypothesis_query: 'X causa Y bajo condiciones Z',
      baconian_forma_veritas: 'Forma veritas de ejemplo',
    })
    expect(parsed.success).toBe(true)
  })

  test('exposes ready falsification result for same turn (autocorrection path)', () => {
    __testOnly.clearCachesForTest()
    const context = {
      options: {
        messageLogName: 'default',
        forkNumber: 0,
      },
      agentId: 'main',
      messageId: 'turn-123',
    } as any

    const input = {
      hypothesis_query: 'H: alpha beta convexo',
    } as any

    const readyOutput = {
      planStatus: 'ready',
      plan: {
        falsification_plan: { meta: { status: 'ready' } },
      },
    } as any

    __testOnly.setTurnScopedResultForTest(input, context, readyOutput)

    const recovered = getReadyFalsificationResultForTurn({
      context,
      hypothesisQuery: input.hypothesis_query,
    })
    expect(recovered?.planStatus).toBe('ready')
    __testOnly.clearCachesForTest()
  })

  test('uses requestId as turn fallback when messageId is missing', () => {
    __testOnly.clearCachesForTest()
    const context = {
      options: {
        messageLogName: 'default',
        forkNumber: 0,
      },
      agentId: 'main',
      requestId: 'req-42',
      messageId: undefined,
    } as any

    const input = {
      hypothesis_query: 'H: alpha beta convexo',
    } as any

    const readyOutput = {
      planStatus: 'ready',
      plan: {
        falsification_plan: { meta: { status: 'ready' } },
      },
    } as any

    __testOnly.setTurnScopedResultForTest(input, context, readyOutput)

    const recovered = getReadyFalsificationResultForTurn({
      context,
      hypothesisQuery: input.hypothesis_query,
    })
    expect(recovered?.planStatus).toBe('ready')
    __testOnly.clearCachesForTest()
  })

  test('does not reuse non-ready cache when normalization is already ready', () => {
    const shouldReuse = __testOnly.shouldReuseFalsificationCachedOutput(
      { planStatus: 'skipped' } as any,
      {
        hypothesis_query: 'H: alpha beta convexo',
        normalization_ok: true,
        missing_fields: [],
      } as any,
    )
    expect(shouldReuse).toBe(false)
  })

  test('can reuse non-ready cache when normalization is incomplete', () => {
    const shouldReuse = __testOnly.shouldReuseFalsificationCachedOutput(
      { planStatus: 'skipped' } as any,
      {
        hypothesis_query: 'H: alpha beta convexo',
        normalization_ok: false,
        missing_fields: ['relation'],
      } as any,
    )
    expect(shouldReuse).toBe(true)
  })

  test('keeps scoped cache decision and does not promote unrelated ready output', () => {
    const preferred = __testOnly.choosePreferredFalsificationCachedOutput({
      cachedOutput: { planStatus: 'skipped' } as any,
      input: {
        hypothesis_query: 'H: alpha beta convexo',
        normalization_ok: false,
        missing_fields: ['relation'],
      } as any,
    })
    expect(preferred?.planStatus).toBe('skipped')
  })

  test('keeps cached output when no ready alternative exists', () => {
    const preferred = __testOnly.choosePreferredFalsificationCachedOutput({
      cachedOutput: { planStatus: 'skipped' } as any,
      input: {
        hypothesis_query: 'H: alpha beta convexo',
        normalization_ok: false,
        missing_fields: ['relation'],
      } as any,
    })
    expect(preferred?.planStatus).toBe('skipped')
  })
})
