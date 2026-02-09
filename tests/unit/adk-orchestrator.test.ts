import { describe, expect, test } from 'bun:test'
import { __testOnly } from '@services/ai/adkOrchestrator'

describe('ADK dialectic orchestrator helpers', () => {
  const baconianFixture = {
    summary: 'Se despejan sesgos y se propone forma provisional.',
    idols: {
      tribe: 'Generalizacion excesiva.',
      cave: 'Preferencia por marcos conocidos.',
      market: 'Terminos ambiguos en el claim.',
      theater: 'Supuestos doctrinales no validados.',
    },
    clearing: {
      tribe: 'Separar regularidades de excepciones.',
      cave: 'Introducir contraste inter-dominio.',
      market: 'Definir variables operacionales.',
      theater: 'Someter teoria a evidencia contraria.',
    },
    truth_tables: {
      presence: 'Cuando X y Y coocurren, aparece Z.',
      absence: 'Sin X, Z cae aun con Y presente.',
      degrees: 'A mayor X, mayor probabilidad de Z.',
    },
    forma_veritas: 'X contribuye causalmente a Z bajo condicion C.',
    confidence: 'medium' as const,
  }

  const falsificationFixture = {
    falsification_plan: {
      meta: {
        plan_version: 'falsification-plan-v1' as const,
        status: 'ready' as const,
      },
      normalized_claim: {
        claim: 'X incrementa Y bajo condicion C',
        domain: 'sistemas dinamicos',
        entities: ['X', 'Y'],
        relation: 'incrementa',
        observables: ['Y'],
        expected_direction: 'positive',
        conditions: ['C'],
        time_scope: 't+1',
      },
      tests: [
        {
          id: 'T1',
          goal: 'Buscar contraejemplo controlado',
          method: 'ablation',
          minimal_data: 'serie temporal',
          procedure: 'Comparar con y sin X usando https://example.com/paper',
          what_would_falsify: 'No cambio en Y',
          confounds: 'ruido de medicion',
          falsifier_kind: 'counterexample' as const,
          phase: 'toy' as const,
          priority: 1,
        },
      ],
      test_matrix: {
        axes: [
          {
            axis: 'time',
            rationale: 'sensibilidad temporal',
            parameters: ['short', 'long'],
          },
        ],
        variants: [
          {
            id: 'V1',
            axis_values: { time: 'short' },
            applies_to_tests: ['T1'],
            rationale: 'control de horizonte corto',
          },
        ],
      },
      data_requests: ['dataset://sleep.csv'],
    },
    invariants_match: {
      meta: {
        match_version: 'invariants-match-v1' as const,
        status: 'ready' as const,
        reason: 'catalog_match',
        catalog_sha256: 'abc123',
      },
      matches: [
        {
          invariant_name: 'Invariante 1',
          gate_id: 'H_ONTOSIG_DOMAIN',
          match_strength: 'moderate' as const,
          why: 'Coincide parcialmente',
          evidence_profile: {
            needs_gauge: true,
            needs_nulls: true,
            needs_bootstrap: false,
            needs_intervention: false,
          },
          dataset_hints: ['dataset://sleep.csv'],
          runner_implications: ['run ablation first'],
        },
      ],
      overall: {
        match_strength: 'moderate' as const,
        notes: 'alineacion parcial',
        next_action: 'Ejecutar T1 con control de confounds.',
      },
    },
  }

  const normalizationFixture = {
    meta: {
      normalization_version: 'normalization-v1' as const,
      mode: 'strict' as const,
    },
    hypothesis_normalization: {
      claim: 'X incrementa Y bajo C',
      domain: 'control geometrico',
      entities: ['X', 'Y'],
      relation: 'incrementa',
      observables: ['Y'],
      expected_direction: 'positive',
      conditions: 'bajo C',
      time_scope: 'corto plazo',
      notes: 'sin supuestos',
      missing_fields: [],
      clarification_required: false,
      clarification_questions: [],
      clarification_plan: {
        required_fields: [],
      },
    },
  }

  const experimentRunnersFixture = {
    experiment_runners: {
      meta: {
        plan_version: 'experiment-runners-v1' as const,
        status: 'ready' as const,
      },
      hypothesis_snapshot: 'X incrementa Y bajo condicion C',
      assumptions: ['dataset parcial', 'ruido gaussiano leve'],
      runners: [
        {
          id: 'R1',
          goal: 'Testear sensibilidad a alpha/beta',
          test_ids: ['T1'],
          phase: 'toy' as const,
          language: 'python' as const,
          filename: 'experiments/r1_alpha_beta.py',
          run_command: 'python experiments/r1_alpha_beta.py --seed 42',
          required_inputs: ['alpha', 'beta', 'seed'],
          expected_signal: 'slope<0',
          failure_signal: 'slope>=0',
          code: 'print("runner")',
        },
      ],
      execution_order: ['R1'],
      next_action: 'Ejecutar R1 y revisar slope.',
    },
  }

  test('parses strict JSON dialectic payload', () => {
    const raw = JSON.stringify({
      summary: 'La hipotesis tiene soporte parcial.',
      hypothesis: 'X causa Y.',
      antithesis: 'Y puede explicarse por Z.',
      synthesis: 'X contribuye, pero Z es un factor critico.',
    })

    const parsed = __testOnly.parseStrictDialecticOutput(raw)
    expect(parsed).not.toBeNull()
    expect(parsed?.summary).toContain('soporte parcial')
    expect(parsed?.hypothesis).toContain('X causa Y')
  })

  test('rejects non-json structured text in strict mode', () => {
    const raw = ['Resumen', 'Texto breve.', '', 'Hipotesis', 'X.'].join('\n')
    expect(__testOnly.parseStrictDialecticOutput(raw)).toBeNull()
  })

  test('unwraps fenced json payload', () => {
    const raw = ['```json', '{"summary":"ok","hypothesis":"h","antithesis":"a","synthesis":"s"}', '```'].join('\n')
    const unwrapped = __testOnly.stripCodeFenceEnvelope(raw)
    expect(unwrapped.startsWith('{')).toBe(true)
    const parsed = __testOnly.parseStrictDialecticOutput(raw)
    expect(parsed?.synthesis).toBe('s')
  })

  test('classifies retryable ADK errors', () => {
    expect(__testOnly.isRetryableAdkError({ status: 503 })).toBe(true)
    expect(
      __testOnly.isRetryableAdkError(
        new Error('network timeout while calling'),
      ),
    ).toBe(true)
    expect(
      __testOnly.isRetryableAdkError(
        new Error(
          'Falsification subagent contract violation: expected strict falsification JSON output.',
        ),
      ),
    ).toBe(true)
    expect(
      __testOnly.isRetryableAdkError(
        new Error('Dialectical subagent returned empty output.'),
      ),
    ).toBe(true)
    expect(
      __testOnly.isRetryableAdkError(
        new Error(`Unexpected token 'e', "exception "... is not valid JSON`),
      ),
    ).toBe(true)
    expect(
      __testOnly.isRetryableAdkError(
        new Error('invalid api key or authentication failure'),
      ),
    ).toBe(false)
  })

  test('normalizes json parse errors to strict runners contract violation', () => {
    const normalized = __testOnly.normalizeStrictJsonContractError(
      'runners',
      new Error(`Unexpected token 'e', "exception "... is not valid JSON`),
    )
    expect(normalized.message).toBe(
      'Experiment runners subagent contract violation: expected strict experiment runners JSON output.',
    )
  })

  test('does not rewrite unrelated non-json errors during normalization', () => {
    const original = new Error('invalid api key')
    const normalized = __testOnly.normalizeStrictJsonContractError(
      'runners',
      original,
    )
    expect(normalized).toBe(original)
  })

  test('computes exponential retry delay with jitter bounds', () => {
    const low = __testOnly.computeRetryDelayMs({
      attempt: 1,
      baseDelayMs: 1000,
      maxDelayMs: 10_000,
      jitterRatio: 0.25,
      random: () => 0,
    })
    const high = __testOnly.computeRetryDelayMs({
      attempt: 1,
      baseDelayMs: 1000,
      maxDelayMs: 10_000,
      jitterRatio: 0.25,
      random: () => 1,
    })
    const mid = __testOnly.computeRetryDelayMs({
      attempt: 1,
      baseDelayMs: 1000,
      maxDelayMs: 10_000,
      jitterRatio: 0.25,
      random: () => 0.5,
    })

    expect(low).toBe(1500)
    expect(mid).toBe(2000)
    expect(high).toBe(2500)
  })

  test('disables jitter in deterministic mode when jitterRatio is omitted', () => {
    const previous = process.env.AMAWTA_ADK_DETERMINISTIC_MODE
    process.env.AMAWTA_ADK_DETERMINISTIC_MODE = '1'
    try {
      const delay = __testOnly.computeRetryDelayMs({
        attempt: 1,
        baseDelayMs: 1000,
        maxDelayMs: 10_000,
      })
      expect(delay).toBe(2000)
    } finally {
      if (previous === undefined) {
        delete process.env.AMAWTA_ADK_DETERMINISTIC_MODE
      } else {
        process.env.AMAWTA_ADK_DETERMINISTIC_MODE = previous
      }
    }
  })

  test('expands execution budgets in long-run mode', () => {
    const previous = process.env.AMAWTA_ADK_LONGRUN_MODE
    process.env.AMAWTA_ADK_LONGRUN_MODE = '1'
    try {
      const budget = __testOnly.createExecutionBudget('orchestrator')
      expect(budget.maxEvents).toBeGreaterThanOrEqual(20_000)
      expect(budget.maxToolCalls).toBeGreaterThanOrEqual(2_000)
      expect(budget.maxRuntimeMs).toBeGreaterThanOrEqual(1_200_000)
    } finally {
      if (previous === undefined) {
        delete process.env.AMAWTA_ADK_LONGRUN_MODE
      } else {
        process.env.AMAWTA_ADK_LONGRUN_MODE = previous
      }
    }
  })

  test('extracts dialectical payload from function response result string', () => {
    const response = {
      name: 'DialecticalAnalyzer',
      response: {
        result:
          '{"summary":"ok","hypothesis":"h","antithesis":"a","synthesis":"s"}',
      },
    }

    const extracted = __testOnly.extractFunctionResponseResultText(response)
    expect(extracted).toContain('"summary":"ok"')
    const parsed = __testOnly.parseStrictDialecticOutput(extracted)
    expect(parsed?.hypothesis).toBe('h')
  })

  test('extracts best event text from function response when text is empty', () => {
    const event = {
      id: 'event-empty-text-1',
      invocationId: 'inv-empty-text-1',
      author: 'DialecticalAnalyzer',
      timestamp: 1730000100,
      partial: false,
      actions: {},
      content: {
        parts: [
          {
            functionResponse: {
              name: 'DialecticalAnalyzer',
              response: {
                result:
                  '{"summary":"ok","hypothesis":"h","antithesis":"a","synthesis":"s"}',
              },
            },
          },
        ],
      },
    } as any

    const text = __testOnly.extractBestEventText(event)
    expect(text).toContain('"summary":"ok"')
    const parsed = __testOnly.parseStrictDialecticOutput(text)
    expect(parsed?.synthesis).toBe('s')
  })

  test('parses strict JSON baconian payload', () => {
    const parsed = __testOnly.parseStrictBaconianOutput(
      JSON.stringify(baconianFixture),
    )
    expect(parsed).not.toBeNull()
    expect(parsed?.idols.market).toContain('ambiguos')
    expect(parsed?.forma_veritas).toContain('causalmente')
  })

  test('parses strict JSON falsification payload', () => {
    const parsed = __testOnly.parseStrictFalsificationOutput(
      JSON.stringify(falsificationFixture),
    )
    expect(parsed).not.toBeNull()
    expect(parsed?.falsification_plan.meta.plan_version).toBe(
      'falsification-plan-v1',
    )
    expect(parsed?.falsification_plan.tests.length).toBe(1)
    expect(parsed?.invariants_match.meta.match_version).toBe(
      'invariants-match-v1',
    )
  })

  test('parses strict JSON normalization payload', () => {
    const parsed = __testOnly.parseStrictNormalizationOutput(
      JSON.stringify(normalizationFixture),
    )
    expect(parsed).not.toBeNull()
    expect(parsed?.meta.normalization_version).toBe('normalization-v1')
    expect(parsed?.meta.mode).toBe('strict')
    expect(parsed?.hypothesis_normalization.claim).toContain('incrementa')
  })

  test('parses strict JSON experiment runners payload', () => {
    const parsed = __testOnly.parseStrictExperimentRunnersOutput(
      JSON.stringify(experimentRunnersFixture),
    )
    expect(parsed).not.toBeNull()
    expect(parsed?.experiment_runners.meta.plan_version).toBe(
      'experiment-runners-v1',
    )
    expect(parsed?.experiment_runners.runners.length).toBe(1)
    expect(parsed?.experiment_runners.runners[0]?.language).toBe('python')
  })

  test('rejects falsification payload with too many variants', () => {
    const payload = JSON.parse(JSON.stringify(falsificationFixture))
    payload.falsification_plan.test_matrix.variants = Array.from(
      { length: 6 },
      (_, index) => ({
        id: `V${index + 1}`,
        axis_values: { time: 'short' },
        applies_to_tests: ['T1'],
        rationale: 'x',
      }),
    )

    expect(
      __testOnly.parseStrictFalsificationOutput(JSON.stringify(payload)),
    ).toBeNull()
  })

  test('parses strict composite orchestrator payload', () => {
    const raw = JSON.stringify({
      dialectic: {
        summary: 'ok',
        hypothesis: 'h',
        antithesis: 'a',
        synthesis: 's',
      },
      baconian: baconianFixture,
    })

    const parsed = __testOnly.parseStrictOrchestratorCompositeOutput(raw)
    expect(parsed).not.toBeNull()
    expect(parsed?.dialectic.synthesis).toBe('s')
    expect(parsed?.baconian.truth_tables.degrees).toContain('A mayor X')
  })

  test('builds baconian input from dialectical output', () => {
    const payload = __testOnly.buildBaconianInputFromDialectic({
      hypothesisPrompt: 'X causa Y',
      dialectic: {
        summary: 'resumen',
        hypothesis: 'X causa Y',
        antithesis: 'Y se explica por Z',
        synthesis: 'X contribuye pero depende de C',
      },
    })
    expect(payload).toContain('User hypothesis/request:')
    expect(payload).toContain('"hypothesis":"X causa Y"')
  })

  test('builds falsification input from context fields', () => {
    const payload = __testOnly.buildFalsificationInputFromContext({
      modelName: 'gemini-3-flash-preview',
      hypothesisInput: 'X causa Y',
      hypothesisCleaned: 'X incrementa Y',
      veritasFormRaw: '{"forma":"X->Y"}',
      normalizationRaw: '{"ok":true}',
      literatureSearchRaw: '{"hits":2}',
      literatureExtractRaw: '{"status":"ready"}',
      invariantsCatalogMd: '# catalog',
      catalogSha256: 'abc123',
      normalizationOk: true,
      missingFields: ['time_scope'],
    })
    expect(payload).toContain('Current hypothesis: X causa Y')
    expect(payload).toContain('Catalog sha256: abc123')
    expect(payload).toContain('Missing fields: ["time_scope"]')
  })

  test('builds normalization input from context fields', () => {
    const payload = __testOnly.buildNormalizationInputFromContext({
      modelName: 'gemini-3-flash-preview',
      hypothesisInput: 'X causa Y',
      dialecticalSynthesis: 'X contribuye bajo C',
      baconianFormaVeritas: 'forma provisional',
      literatureSummary: '2 papers relevantes',
      previousNormalizationRaw: '{"claim":"X->Y"}',
      mode: 'autocorrect',
    })
    expect(payload).toContain('Mode: autocorrect')
    expect(payload).toContain('Hypothesis input: X causa Y')
    expect(payload).toContain('Previous normalization draft JSON:')
  })

  test('builds experiment runners input from context fields', () => {
    const payload = __testOnly.buildExperimentRunnersInputFromContext({
      modelName: 'gemini-3-flash-preview',
      hypothesisInput: 'X causa Y',
      dialecticalSynthesis: 'X contribuye bajo C',
      baconianFormaVeritas: 'forma provisional',
      normalizationRaw: '{"claim":"X->Y"}',
      falsificationRaw: '{"falsification_plan":{"meta":{"status":"ready"}}}',
      literatureSummary: '2 papers relevantes',
    })
    expect(payload).toContain('Current hypothesis: X causa Y')
    expect(payload).toContain('Falsification plan JSON:')
  })

  test('builds ADK event snapshot with actions, calls and responses', () => {
    const event = {
      id: 'event-1',
      invocationId: 'inv-1',
      author: 'AmawtaOrchestrator',
      timestamp: 1730000000,
      partial: false,
      actions: {
        stateDelta: { 'temp:last_step': 'dialectic' },
        artifactDelta: { 'dialectical-result.json': 1 },
        requestedAuthConfigs: { call_1: {} },
        requestedToolConfirmations: { call_2: {} },
        transferToAgent: 'DialecticalAnalyzer',
        escalate: false,
        skipSummarization: true,
      },
      content: {
        parts: [
          {
            functionCall: {
              name: 'DialecticalAnalyzer',
              args: { hypothesis: 'X causa Y' },
            },
          },
          {
            functionResponse: {
              name: 'DialecticalAnalyzer',
              response: { result: '{"summary":"ok"}' },
            },
          },
          { text: 'Respuesta breve de prueba' },
        ],
      },
    } as any

    const snapshot = __testOnly.buildAdkEventSnapshot(event) as any
    expect(snapshot.author).toBe('AmawtaOrchestrator')
    expect(snapshot.hasText).toBe(true)
    expect(snapshot.functionCalls[0].name).toBe('DialecticalAnalyzer')
    expect(snapshot.functionResponses[0].name).toBe('DialecticalAnalyzer')
    expect(snapshot.actions.transferToAgent).toBe('DialecticalAnalyzer')
    expect(snapshot.actions.stateDeltaKeys).toContain('temp:last_step')
    expect(snapshot.actions.artifactDeltaKeys).toContain('dialectical-result.json')
  })

  test('caps event trace when limit is reached', () => {
    const fullTrace = Array.from({ length: 240 }, () => ({}))
    const accepted = __testOnly.captureAdkEventTrace(fullTrace as any, {
      id: 'event-2',
      invocationId: 'inv-2',
      author: 'AmawtaOrchestrator',
      timestamp: 1730000010,
      partial: false,
      actions: {
        stateDelta: {},
        artifactDelta: {},
        requestedAuthConfigs: {},
        requestedToolConfirmations: {},
      },
      content: { parts: [{ text: 'overflow' }] },
    } as any)

    expect(accepted).toBe(false)
    expect(fullTrace.length).toBe(240)
  })

  test('enforces execution budget for events and tool calls', () => {
    const eventWithToolCall = {
      id: 'event-budget-1',
      invocationId: 'inv-budget-1',
      author: 'AmawtaOrchestrator',
      timestamp: 1730000010,
      partial: false,
      actions: {},
      content: {
        parts: [
          {
            functionCall: {
              name: 'DialecticalAnalyzer',
              args: { hypothesis: 'X causa Y' },
            },
          },
        ],
      },
    } as any

    const eventNoToolCall = {
      id: 'event-budget-2',
      invocationId: 'inv-budget-1',
      author: 'AmawtaOrchestrator',
      timestamp: 1730000020,
      partial: false,
      actions: {},
      content: { parts: [{ text: 'ok' }] },
    } as any

    const eventsBudget = __testOnly.createExecutionBudget('dialectical')
    eventsBudget.maxEvents = 1
    eventsBudget.maxToolCalls = 5
    eventsBudget.deadlineAtMs = Date.now() + 60_000

    expect(() =>
      __testOnly.enforceExecutionBudgetOrThrow(eventsBudget, eventWithToolCall),
    ).not.toThrow()
    expect(() =>
      __testOnly.enforceExecutionBudgetOrThrow(eventsBudget, eventNoToolCall),
    ).toThrow(/events/)

    const toolsBudget = __testOnly.createExecutionBudget('dialectical')
    toolsBudget.maxEvents = 5
    toolsBudget.maxToolCalls = 0
    toolsBudget.deadlineAtMs = Date.now() + 60_000

    expect(() =>
      __testOnly.enforceExecutionBudgetOrThrow(toolsBudget, eventWithToolCall),
    ).toThrow(/tool_calls/)
  })

  test('builds artifacts footer line for a session path', () => {
    const line = __testOnly.formatArtifactsSavedAtLine({
      runtime: {
        scope: 'dialectical',
        namespace: 'adk-dialectical-v1',
        appName: 'AmawtaAdkOrchestratorV1_Dialectical',
        userId: 'amawta-main-user',
        conversationKey: 'chat-1',
        sessionId: 'session-1',
        initialState: {},
      },
      session: {
        id: 'session-1',
        userId: 'amawta-main-user',
      },
    })

    expect(line.startsWith('Artifacts saved at: ')).toBe(true)
  })

  test('appends artifacts footer to response text', () => {
    const output = __testOnly.withArtifactsLocationFooter('Resultado final', {
      runtime: {
        scope: 'orchestrator',
        namespace: 'adk-orchestrator-v1',
        appName: 'AmawtaAdkOrchestratorV1',
        userId: 'amawta-main-user',
        conversationKey: 'chat-2',
        sessionId: 'session-2',
        initialState: {},
      },
      session: {
        id: 'session-2',
        userId: 'amawta-main-user',
      },
    })

    expect(output).toContain('Resultado final')
    expect(output).toContain('Artifacts saved at:')
  })
})
