import { Gemini, LlmAgent, zodObjectToSchema } from '@google/adk'
import type { Event } from '@google/adk'
import { z } from 'zod'
import {
  EXPERIMENT_RUNNERS_SUBAGENT_INSTRUCTION,
  EXPERIMENT_RUNNERS_SUBAGENT_NAME,
} from '@services/ai/prompts/adkDialecticPrompts'
import type { ExperimentRunnersResult } from '@services/ai/types/adkDialectic'
import {
  __agentRuntime,
  type AttemptMetadata,
  type RunExperimentRunnersSubagentParams,
} from '@services/ai/adkOrchestrator'
import {
  computeRetryDelayWithOverload,
  maybeSwitchGeminiFailoverModel,
} from '@services/ai/agents/resilience'

type SingleRunnerBuilderRunResult = {
  text: string
  runners: ExperimentRunnersResult
}

export type RunnerBuilderAgentInput = RunExperimentRunnersSubagentParams
const RUNNER_BUILDER_OUTPUT_STATE_KEY = 'runners_structured_output'

const RUNNER_BUILDER_OUTPUT_SCHEMA = z.object({
  experiment_runners: z.object({
    meta: z.object({
      plan_version: z.literal('experiment-runners-v1'),
      status: z.enum(['ready', 'skipped']),
      reason: z.string().optional(),
    }),
    hypothesis_snapshot: z.string(),
    assumptions: z.array(z.string()),
    runners: z.array(
      z.object({
        id: z.string(),
        goal: z.string(),
        test_ids: z.array(z.string()),
        phase: z.enum(['toy', 'field', 'both']),
        language: z.enum(['python', 'bash', 'pseudo']),
        filename: z.string(),
        run_command: z.string(),
        required_inputs: z.array(z.string()),
        expected_signal: z.string(),
        failure_signal: z.string(),
        code: z.string(),
      }),
    ),
    execution_order: z.array(z.string()),
    next_action: z.string(),
  }),
})

async function runSingleRunnerBuilderPass(
  params: RunnerBuilderAgentInput & AttemptMetadata,
): Promise<SingleRunnerBuilderRunResult> {
  const baseModel = new Gemini({
    model: params.modelName,
    apiKey: params.apiKey?.trim() || undefined,
  })

  const runnerBuilderAgent = new LlmAgent({
    name: EXPERIMENT_RUNNERS_SUBAGENT_NAME,
    model: baseModel,
    description:
      'Builds executable runner scripts from normalized hypothesis + falsification context for gate/threshold evaluation.',
    instruction: EXPERIMENT_RUNNERS_SUBAGENT_INSTRUCTION,
    outputSchema: zodObjectToSchema(RUNNER_BUILDER_OUTPUT_SCHEMA),
    outputKey: RUNNER_BUILDER_OUTPUT_STATE_KEY,
    disallowTransferToParent: true,
    disallowTransferToPeers: true,
  })

  const runtime = __agentRuntime.buildAdkSessionRuntime(
    'runners',
    params.conversationKey,
    { attemptIndex: params.attemptIndex },
  )

  const runner = __agentRuntime.createAdkRunner({
    appName: runtime.appName,
    agent: runnerBuilderAgent,
  })

  const session = await runner.sessionService.createSession({
    appName: runtime.appName,
    userId: runtime.userId,
    sessionId: runtime.sessionId,
    state: runtime.initialState,
  })

  const newMessage = {
    role: 'user',
    parts: [{ text: __agentRuntime.buildExperimentRunnersInputFromContext(params) }],
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
      filename: 'runners-events.json',
      pointerKey: 'runners_events',
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
      latestSession?.state?.[RUNNER_BUILDER_OUTPUT_STATE_KEY] ??
      session.state?.[RUNNER_BUILDER_OUTPUT_STATE_KEY]
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
      text: 'Experiment runners subagent returned empty output.',
      metadata: { reason: 'empty_output' },
    })
    await __agentRuntime.persistAdkArtifact({
      runner,
      runtime,
      session,
      filename: 'runners-events.json',
      pointerKey: 'runners_events',
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
      `Experiment runners subagent returned empty output.${__agentRuntime.formatEventDiagnostics(lastRunnerEvent)}`,
    )
  }

  let parsed = __agentRuntime.parseStrictExperimentRunnersOutput(trimmed)
  if (!parsed && structuredOutputCandidate !== undefined && structuredOutputCandidate !== null) {
    try {
      parsed = __agentRuntime.parseStrictExperimentRunnersOutput(
        JSON.stringify(structuredOutputCandidate),
      )
    } catch {
      parsed = null
    }
  }
  if (!parsed) {
    __agentRuntime.captureSyntheticTraceEventWithDrop({
      trace: eventTrace,
      droppedCounter: droppedEventTraceCount,
      scope: runtime.scope,
      kind: 'error',
      text: 'Experiment runners subagent contract violation: expected strict experiment runners JSON output.',
      metadata: { reason: 'contract_violation' },
    })
    await __agentRuntime.persistAdkArtifact({
      runner,
      runtime,
      session,
      filename: 'runners-events.json',
      pointerKey: 'runners_events',
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
      filename: 'runners-invalid-output.json',
      pointerKey: 'runners_invalid_output',
      payload: {
        reason: 'contract_violation',
        outputPreview: trimmed.slice(0, 20_000),
      },
    })
    throw new Error(
      'Experiment runners subagent contract violation: expected strict experiment runners JSON output.',
    )
  }

  await __agentRuntime.persistAdkArtifact({
    runner,
    runtime,
    session,
    filename: 'runners-result.json',
    pointerKey: 'runners_result',
    payload: {
      input: {
        hypothesisInput: params.hypothesisInput,
        dialecticalSynthesis: params.dialecticalSynthesis,
        baconianFormaVeritas: params.baconianFormaVeritas,
        normalizationRaw: params.normalizationRaw,
        falsificationRaw: params.falsificationRaw,
        literatureSummary: params.literatureSummary,
      },
      output: parsed,
    },
  })

  return {
    text: __agentRuntime.withArtifactsLocationFooter(
      __agentRuntime.formatExperimentRunnersResult(parsed),
      {
        runtime,
        session,
      },
    ),
    runners: parsed,
  }
}

export async function runRunnerBuilderAgent(
  params: RunnerBuilderAgentInput,
): Promise<{
  text: string
  retriesUsed: number
  runners?: ExperimentRunnersResult
}> {
  const scope = 'runners'
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
        const result = await runSingleRunnerBuilderPass({
          ...params,
          modelName,
          signal: attemptControl.signal,
          attemptIndex: retriesUsed,
          maxRetries,
        })
        return {
          text: result.text,
          runners: result.runners,
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
