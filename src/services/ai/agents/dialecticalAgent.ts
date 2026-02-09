import { Gemini, LlmAgent } from '@google/adk'
import type { Event } from '@google/adk'
import {
  DIALECTICAL_SUBAGENT_INSTRUCTION,
  DIALECTICAL_SUBAGENT_NAME,
} from '@services/ai/prompts/adkDialecticPrompts'
import type { DialecticResult } from '@services/ai/types/adkDialectic'
import {
  __agentRuntime,
  type AttemptMetadata,
  type RunDialecticalSubagentParams,
} from '@services/ai/adkOrchestrator'
import {
  computeRetryDelayWithOverload,
  maybeSwitchGeminiFailoverModel,
} from '@services/ai/agents/resilience'

type SingleDialecticalRunResult = {
  text: string
  dialectic: DialecticResult
}

export type DialecticalAgentInput = RunDialecticalSubagentParams

async function runSingleDialecticalPass(
  params: DialecticalAgentInput & AttemptMetadata,
): Promise<SingleDialecticalRunResult> {
  const baseModel = new Gemini({
    model: params.modelName,
    apiKey: params.apiKey?.trim() || undefined,
  })

  const dialecticalAgent = new LlmAgent({
    name: DIALECTICAL_SUBAGENT_NAME,
    model: baseModel,
    description:
      'Performs hypothesis-antithesis-synthesis reasoning for a hypothesis-oriented request.',
    instruction: DIALECTICAL_SUBAGENT_INSTRUCTION,
  })

  const runtime = __agentRuntime.buildAdkSessionRuntime(
    'dialectical',
    params.conversationKey,
    { attemptIndex: params.attemptIndex },
  )

  const runner = __agentRuntime.createAdkRunner({
    appName: runtime.appName,
    agent: dialecticalAgent,
  })

  const session = await runner.sessionService.createSession({
    appName: runtime.appName,
    userId: runtime.userId,
    sessionId: runtime.sessionId,
    state: runtime.initialState,
  })

  const newMessage = {
    role: 'user',
    parts: [{ text: params.prompt }],
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
      filename: 'dialectical-events.json',
      pointerKey: 'dialectical_events',
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

  const trimmed = finalText.trim()
  if (!trimmed) {
    __agentRuntime.captureSyntheticTraceEventWithDrop({
      trace: eventTrace,
      droppedCounter: droppedEventTraceCount,
      scope: runtime.scope,
      kind: 'error',
      text: 'Dialectical subagent returned empty output.',
      metadata: { reason: 'empty_output' },
    })
    await __agentRuntime.persistAdkArtifact({
      runner,
      runtime,
      session,
      filename: 'dialectical-events.json',
      pointerKey: 'dialectical_events',
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
      `Dialectical subagent returned empty output.${__agentRuntime.formatEventDiagnostics(lastRunnerEvent)}`,
    )
  }

  const parsed = __agentRuntime.parseStrictDialecticOutput(trimmed)
  if (!parsed) {
    __agentRuntime.captureSyntheticTraceEventWithDrop({
      trace: eventTrace,
      droppedCounter: droppedEventTraceCount,
      scope: runtime.scope,
      kind: 'error',
      text: 'Dialectical subagent contract violation: expected strict dialectical JSON output.',
      metadata: { reason: 'contract_violation' },
    })
    await __agentRuntime.persistAdkArtifact({
      runner,
      runtime,
      session,
      filename: 'dialectical-events.json',
      pointerKey: 'dialectical_events',
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
      'Dialectical subagent contract violation: expected strict dialectical JSON output.',
    )
  }

  await __agentRuntime.persistAdkArtifact({
    runner,
    runtime,
    session,
    filename: 'dialectical-result.json',
    pointerKey: 'dialectical_result',
    payload: {
      prompt: params.prompt,
      output: parsed,
    },
  })

  return {
    text: __agentRuntime.withArtifactsLocationFooter(
      __agentRuntime.formatDialecticResult(parsed),
      {
        runtime,
        session,
      },
    ),
    dialectic: parsed,
  }
}

export async function runDialecticalAgent(
  params: DialecticalAgentInput,
): Promise<{ text: string; retriesUsed: number; dialectic?: DialecticResult }> {
  const scope = 'dialectical'
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
        const result = await runSingleDialecticalPass({
          ...params,
          modelName,
          signal: attemptControl.signal,
          attemptIndex: retriesUsed,
          maxRetries,
        })
        return {
          text: result.text,
          dialectic: result.dialectic,
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
