import { Gemini, LlmAgent, zodObjectToSchema } from '@google/adk'
import type { Event } from '@google/adk'
import { z } from 'zod'
import {
  FALSIFICATION_SUBAGENT_INSTRUCTION,
  FALSIFICATION_SUBAGENT_NAME,
} from '@services/ai/prompts/adkDialecticPrompts'
import type { FalsificationPlanResult } from '@services/ai/types/adkDialectic'
import {
  __agentRuntime,
  type AttemptMetadata,
  type RunFalsificationSubagentParams,
} from '@services/ai/adkOrchestrator'
import {
  computeRetryDelayWithOverload,
  maybeSwitchGeminiFailoverModel,
} from '@services/ai/agents/resilience'

type SingleFalsificationRunResult = {
  text: string
  falsification: FalsificationPlanResult
}

export type FalsificationAgentInput = RunFalsificationSubagentParams
const FALSIFICATION_OUTPUT_STATE_KEY = 'falsification_structured_output'

const FALSIFICATION_DYNAMIC_VALUE_SCHEMA = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.null(),
  z.array(z.string()),
])

const FALSIFICATION_OUTPUT_SCHEMA = z.object({
  falsification_plan: z.object({
    meta: z.object({
      plan_version: z.literal('falsification-plan-v1'),
      status: z.enum(['ready', 'skipped']),
      reason: z.string().optional(),
    }),
    normalized_claim: z.object({
      claim: z.string(),
      domain: z.string(),
      entities: z.union([z.string(), z.array(z.string())]),
      relation: z.string(),
      observables: z.union([z.string(), z.array(z.string())]),
      expected_direction: z.string(),
      conditions: z.union([z.string(), z.array(z.string())]),
      time_scope: z.string(),
    }),
    tests: z.array(
      z.object({
        id: z.string(),
        goal: z.string(),
        method: z.string(),
        minimal_data: z.string(),
        procedure: z.string(),
        what_would_falsify: z.string(),
        confounds: z.string(),
        falsifier_kind: z
          .enum([
            'mechanism',
            'confound',
            'boundary',
            'invariance',
            'intervention',
            'measurement',
            'alternative',
            'robustness',
            'counterexample',
          ])
          .optional(),
        phase: z.enum(['toy', 'field', 'both']).optional(),
        priority: z.number().optional(),
      }),
    ),
    test_matrix: z.object({
      axes: z.array(
        z.object({
          axis: z.string(),
          rationale: z.string(),
          parameters: z.union([
            z.string(),
            z.array(z.string()),
            z.array(
              z.object({
                key: z.string(),
                value: FALSIFICATION_DYNAMIC_VALUE_SCHEMA,
              }),
            ),
          ]),
        }),
      ),
      variants: z
        .array(
          z.object({
            id: z.string(),
            axis_values: z.array(
              z.object({
                axis: z.string(),
                value: FALSIFICATION_DYNAMIC_VALUE_SCHEMA,
              }),
            ),
            applies_to_tests: z.array(z.string()),
            rationale: z.string(),
          }),
        )
        .max(5),
    }),
    data_requests: z.array(z.string()),
  }),
  invariants_match: z.object({
    meta: z.object({
      match_version: z.literal('invariants-match-v1'),
      status: z.enum(['ready', 'skipped']),
      reason: z.string(),
      catalog_sha256: z.string().optional(),
    }),
    matches: z.array(
      z.object({
        invariant_name: z.string(),
        gate_id: z.string(),
        match_strength: z.enum(['strong', 'moderate', 'weak']),
        why: z.string(),
        evidence_profile: z.object({
          needs_gauge: z.boolean(),
          needs_nulls: z.boolean(),
          needs_bootstrap: z.boolean(),
          needs_intervention: z.boolean(),
        }),
        dataset_hints: z.array(z.string()),
        runner_implications: z.array(z.string()),
      }),
    ),
    overall: z.object({
      match_strength: z.enum(['none', 'weak', 'moderate', 'strong']),
      notes: z.string(),
      next_action: z.string(),
    }),
  }),
})

async function runSingleFalsificationPass(
  params: FalsificationAgentInput & AttemptMetadata,
): Promise<SingleFalsificationRunResult> {
  const baseModel = new Gemini({
    model: params.modelName,
    apiKey: params.apiKey?.trim() || undefined,
  })

  const falsificationAgent = new LlmAgent({
    name: FALSIFICATION_SUBAGENT_NAME,
    model: baseModel,
    description:
      'Builds a falsification plan and evidence-aligned invariant mapping from hypothesis + prior pipeline artifacts.',
    instruction: FALSIFICATION_SUBAGENT_INSTRUCTION,
    outputSchema: zodObjectToSchema(FALSIFICATION_OUTPUT_SCHEMA),
    outputKey: FALSIFICATION_OUTPUT_STATE_KEY,
    disallowTransferToParent: true,
    disallowTransferToPeers: true,
  })

  const runtime = __agentRuntime.buildAdkSessionRuntime(
    'falsification',
    params.conversationKey,
    { attemptIndex: params.attemptIndex },
  )

  const runner = __agentRuntime.createAdkRunner({
    appName: runtime.appName,
    agent: falsificationAgent,
  })

  const session = await runner.sessionService.createSession({
    appName: runtime.appName,
    userId: runtime.userId,
    sessionId: runtime.sessionId,
    state: runtime.initialState,
  })

  const newMessage = {
    role: 'user',
    parts: [{ text: __agentRuntime.buildFalsificationInputFromContext(params) }],
  } as any

  let finalText = ''
  let lastRunnerEvent: Event | undefined
  const eventTrace: Record<string, unknown>[] = []
  const droppedEventTraceCount: { value: number } = { value: 0 }
  const budget = __agentRuntime.createExecutionBudget(runtime.scope)
  const attemptIndex = Math.max(0, params.attemptIndex ?? 0)
  const totalAttempts = Math.max(1, (params.maxRetries ?? 0) + 1)
  let stageStatus: 'success' | 'error' = 'success'
  let stageErrorMessage: string | undefined
  let structuredOutputCandidate: unknown

  __agentRuntime.captureSyntheticTraceEventWithDrop({
    trace: eventTrace,
    droppedCounter: droppedEventTraceCount,
    scope: runtime.scope,
    kind: 'stage_start',
    text: `Starting ${runtime.scope} stage`,
    metadata: {
      model: params.modelName,
      attempt: attemptIndex + 1,
      totalAttempts,
      sessionId: session.id,
      deterministicMode: __agentRuntime.isAdkDeterministicModeEnabled(),
      longRunMode: __agentRuntime.isAdkLongRunModeEnabled(),
      isolatedRetrySession: runtime.isolatedRetrySession === true,
    },
  })
  if (attemptIndex > 0) {
    __agentRuntime.captureSyntheticTraceEventWithDrop({
      trace: eventTrace,
      droppedCounter: droppedEventTraceCount,
      scope: runtime.scope,
      kind: 'retry',
      text: `Retry attempt ${attemptIndex + 1}/${totalAttempts}`,
      metadata: {
        attempt: attemptIndex + 1,
        totalAttempts,
      },
    })
  }
  try {
    await __agentRuntime.consumeRunnerEvents({
      runner,
      session,
      newMessage,
      signal: params.signal,
      budget,
      onEvent: event => {
        lastRunnerEvent = event
        __agentRuntime.captureRunnerEventWithLifecycle({
          scope: runtime.scope,
          trace: eventTrace,
          droppedCounter: droppedEventTraceCount,
          event,
        })
        __agentRuntime.maybeThrowOnLlmResponseError(event)
        const text = __agentRuntime.extractBestEventText(event)
        if (text.length > 0) {
          finalText = text
        }
      },
    })
  } catch (error) {
    stageStatus = 'error'
    stageErrorMessage = error instanceof Error ? error.message : String(error)
    __agentRuntime.captureSyntheticTraceEventWithDrop({
      trace: eventTrace,
      droppedCounter: droppedEventTraceCount,
      scope: runtime.scope,
      kind: 'error',
      text: `Stage error: ${stageErrorMessage}`,
      metadata: {
        error: stageErrorMessage,
      },
    })
    throw error
  } finally {
    __agentRuntime.captureSyntheticTraceEventWithDrop({
      trace: eventTrace,
      droppedCounter: droppedEventTraceCount,
      scope: runtime.scope,
      kind: 'stage_end',
      text: `Finished ${runtime.scope} stage (${stageStatus})`,
      metadata: {
        status: stageStatus,
        error: stageErrorMessage,
        eventsSeen: budget.eventsSeen,
        toolCallsSeen: budget.toolCallsSeen,
      },
    })

    if (stageStatus === 'success') {
      await __agentRuntime.persistAdkSessionRuntimeState({
        runner,
        session,
        runtime,
      })
    }

    await __agentRuntime.persistAdkArtifact({
      runner,
      runtime,
      session,
      filename: 'falsification-events.json',
      pointerKey: 'falsification_events',
      payload: {
        scope: runtime.scope,
        conversationKey: runtime.conversationKey,
        capturedAt: Date.now(),
        capturedCount: eventTrace.length,
        droppedCount: droppedEventTraceCount.value,
        events: eventTrace,
      },
    })
  }

  try {
    const latestSession = await runner.sessionService.getSession({
      appName: runtime.appName,
      userId: runtime.userId,
      sessionId: runtime.sessionId,
    })
    structuredOutputCandidate =
      latestSession?.state?.[FALSIFICATION_OUTPUT_STATE_KEY] ??
      session.state?.[FALSIFICATION_OUTPUT_STATE_KEY]
  } catch {
    structuredOutputCandidate = undefined
  }

  if (
    finalText.trim().length === 0 &&
    structuredOutputCandidate !== undefined &&
    structuredOutputCandidate !== null
  ) {
    try {
      finalText = JSON.stringify(structuredOutputCandidate)
    } catch {
      finalText = ''
    }
  }

  const trimmed = finalText.trim()
  if (!trimmed) {
    __agentRuntime.captureSyntheticTraceEventWithDrop({
      trace: eventTrace,
      droppedCounter: droppedEventTraceCount,
      scope: runtime.scope,
      kind: 'error',
      text: 'Falsification subagent returned empty output.',
      metadata: { reason: 'empty_output' },
    })
    await __agentRuntime.persistAdkArtifact({
      runner,
      runtime,
      session,
      filename: 'falsification-events.json',
      pointerKey: 'falsification_events',
      payload: {
        scope: runtime.scope,
        conversationKey: runtime.conversationKey,
        capturedAt: Date.now(),
        capturedCount: eventTrace.length,
        droppedCount: droppedEventTraceCount.value,
        events: eventTrace,
      },
    })
    throw new Error(
      `Falsification subagent returned empty output.${__agentRuntime.formatEventDiagnostics(lastRunnerEvent)}`,
    )
  }

  const parsed =
    __agentRuntime.parseStrictFalsificationOutput(trimmed) ??
    (structuredOutputCandidate !== undefined && structuredOutputCandidate !== null
      ? __agentRuntime.parseStrictFalsificationOutput(
          JSON.stringify(structuredOutputCandidate),
        )
      : null)
  if (!parsed) {
    __agentRuntime.captureSyntheticTraceEventWithDrop({
      trace: eventTrace,
      droppedCounter: droppedEventTraceCount,
      scope: runtime.scope,
      kind: 'error',
      text: 'Falsification subagent contract violation: expected strict falsification JSON output.',
      metadata: { reason: 'contract_violation' },
    })
    await __agentRuntime.persistAdkArtifact({
      runner,
      runtime,
      session,
      filename: 'falsification-events.json',
      pointerKey: 'falsification_events',
      payload: {
        scope: runtime.scope,
        conversationKey: runtime.conversationKey,
        capturedAt: Date.now(),
        capturedCount: eventTrace.length,
        droppedCount: droppedEventTraceCount.value,
        events: eventTrace,
      },
    })
    await __agentRuntime.persistAdkArtifact({
      runner,
      runtime,
      session,
      filename: 'falsification-invalid-output.json',
      pointerKey: 'falsification_invalid_output',
      payload: {
        reason: 'contract_violation',
        outputPreview: trimmed.slice(0, 20_000),
      },
    })
    throw new Error(
      'Falsification subagent contract violation: expected strict falsification JSON output.',
    )
  }

  await __agentRuntime.persistAdkArtifact({
    runner,
    runtime,
    session,
    filename: 'falsification-result.json',
    pointerKey: 'falsification_result',
    payload: {
      input: {
        hypothesisInput: params.hypothesisInput,
        hypothesisCleaned: params.hypothesisCleaned,
        veritasFormRaw: params.veritasFormRaw,
        normalizationRaw: params.normalizationRaw,
        literatureSearchRaw: params.literatureSearchRaw,
        literatureExtractRaw: params.literatureExtractRaw,
        invariantsCatalogMd: params.invariantsCatalogMd,
        catalogSha256: params.catalogSha256,
        normalizationOk: params.normalizationOk,
        missingFields: params.missingFields ?? [],
      },
      output: parsed,
    },
  })

  return {
    text: __agentRuntime.withArtifactsLocationFooter(
      __agentRuntime.formatFalsificationResult(parsed),
      { runtime, session },
    ),
    falsification: parsed,
  }
}

export async function runFalsificationAgent(
  params: FalsificationAgentInput,
): Promise<{
  text: string
  retriesUsed: number
  falsification?: FalsificationPlanResult
}> {
  const scope = 'falsification'
  const maxRetries = Number.isFinite(params.maxRetries as number)
    ? Math.max(0, Math.floor(params.maxRetries as number))
    : 2
  const globalTimeoutMs = __agentRuntime.getScopeGlobalTimeoutMs(scope)
  const attemptTimeoutMs = __agentRuntime.getScopeAttemptTimeoutMs(scope)
  const globalControl = __agentRuntime.createScopedAbortControl({
    parentSignal: params.signal,
    timeoutMs: globalTimeoutMs,
    timeoutErrorMessage: `ADK ${scope} global timeout exceeded (${globalTimeoutMs}ms)`,
  })
  const effectiveSignal = globalControl.signal

  let retriesUsed = 0
  let modelName = params.modelName
  let failoverUsed = false
  try {
    while (true) {
      const attemptControl = __agentRuntime.createScopedAbortControl({
        parentSignal: effectiveSignal,
        timeoutMs: attemptTimeoutMs,
        timeoutErrorMessage: `ADK ${scope} attempt timeout exceeded (${attemptTimeoutMs}ms)`,
      })
      try {
        const result = await runSingleFalsificationPass({
          ...params,
          modelName,
          signal: attemptControl.signal,
          attemptIndex: retriesUsed,
          maxRetries,
        })
        return {
          text: result.text,
          falsification: result.falsification,
          retriesUsed,
        }
      } catch (error) {
        const normalizedError = attemptControl.didTimeout()
          ? new Error(attemptControl.timeoutErrorMessage)
          : error
        const shouldRetry =
          retriesUsed < maxRetries &&
          !effectiveSignal.aborted &&
          __agentRuntime.isRetryableAdkError(normalizedError)
        if (!shouldRetry) {
          if (globalControl.didTimeout()) {
            throw new Error(globalControl.timeoutErrorMessage)
          }
          throw normalizedError
        }

        const retryModel = maybeSwitchGeminiFailoverModel({
          currentModelName: modelName,
          error: normalizedError,
          failoverAlreadyUsed: failoverUsed,
        })
        if (retryModel.switched) {
          modelName = retryModel.modelName
          failoverUsed = true
        }
        const baseDelayMs = __agentRuntime.computeRetryDelayMs({
          attempt: retriesUsed,
        })
        const delayMs = computeRetryDelayWithOverload(
          baseDelayMs,
          normalizedError,
        )
        await __agentRuntime.abortableDelay(delayMs, effectiveSignal)
        retriesUsed += 1
      } finally {
        attemptControl.cleanup()
      }
    }
  } finally {
    globalControl.cleanup()
  }
}
