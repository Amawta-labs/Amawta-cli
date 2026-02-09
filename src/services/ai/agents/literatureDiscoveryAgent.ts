import { FunctionTool, Gemini, LlmAgent } from '@google/adk'
import type { Event } from '@google/adk'
import { parse } from 'node-html-parser'
import { z } from 'zod'
import {
  LITERATURE_SUBAGENT_INSTRUCTION,
  LITERATURE_SUBAGENT_NAME,
} from '@services/ai/prompts/adkDialecticPrompts'
import type { LiteratureDiscoveryResult } from '@services/ai/types/adkDialectic'
import { searchProviders } from '@tools/network/WebSearchTool/searchProviders'
import {
  __agentRuntime,
  type AttemptMetadata,
  type RunLiteratureSubagentParams,
} from '@services/ai/adkOrchestrator'
import {
  computeRetryDelayWithOverload,
  maybeSwitchGeminiFailoverModel,
} from '@services/ai/agents/resilience'

type SingleLiteratureRunResult = {
  text: string
  literature: LiteratureDiscoveryResult
}

export type LiteratureDiscoveryAgentInput = RunLiteratureSubagentParams

type LiteratureToolBudget = {
  searchCalls: number
  fetchCalls: number
  maxSearchCalls: number
  maxFetchCalls: number
}

function clampInt(
  value: unknown,
  fallback: number,
  min: number,
  max: number,
): number {
  const parsed =
    typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10)
  if (!Number.isFinite(parsed)) return fallback
  return Math.min(max, Math.max(min, Math.floor(parsed)))
}

function normalizeInline(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

function createLiteratureToolBudget(attemptIndex: number): LiteratureToolBudget {
  const baseSearchCalls = clampInt(
    process.env.AMAWTA_LITERATURE_MAX_SEARCH_CALLS,
    5,
    1,
    15,
  )
  const baseFetchCalls = clampInt(
    process.env.AMAWTA_LITERATURE_MAX_FETCH_CALLS,
    10,
    2,
    30,
  )
  const retryPenalty = Math.min(2, Math.max(0, attemptIndex))
  return {
    searchCalls: 0,
    fetchCalls: 0,
    maxSearchCalls: Math.max(1, baseSearchCalls - retryPenalty),
    maxFetchCalls: Math.max(2, baseFetchCalls - retryPenalty * 2),
  }
}

function buildLiteratureInputFromContext(
  params: LiteratureDiscoveryAgentInput,
): string {
  return [
    `Main claim: ${params.hypothesisInput.trim()}`,
    `Baconian forma veritas: ${params.baconianFormaVeritas.trim()}`,
    `Dialectical synthesis: ${params.dialecticalSynthesis?.trim() || ''}`,
    `Domain hint: ${params.domainHint?.trim() || ''}`,
  ].join('\n')
}

function extractJsonCandidate(raw: string): string {
  const trimmed = raw.trim()
  if (!trimmed) return ''
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) return trimmed

  const firstBrace = trimmed.indexOf('{')
  const lastBrace = trimmed.lastIndexOf('}')
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    return trimmed.slice(firstBrace, lastBrace + 1).trim()
  }
  return trimmed
}

function normalizeConfidence(
  value: unknown,
): LiteratureDiscoveryResult['confidence'] {
  if (value === 'low' || value === 'medium' || value === 'high') {
    return value
  }
  return undefined
}

function normalizeNoveltyAssessment(
  value: unknown,
): LiteratureDiscoveryResult['novelty_assessment'] | null {
  if (
    value === 'likely_novel' ||
    value === 'partial_overlap' ||
    value === 'well_established' ||
    value === 'insufficient_evidence'
  ) {
    return value
  }
  return null
}

function normalizeStringList(value: unknown, maxItems = 20): string[] {
  if (!Array.isArray(value)) return []
  return value
    .map(item => (typeof item === 'string' ? normalizeInline(item) : ''))
    .filter(Boolean)
    .slice(0, maxItems)
}

function normalizeFindings(
  value: unknown,
): LiteratureDiscoveryResult['findings'] {
  if (!Array.isArray(value)) return []

  const findings: LiteratureDiscoveryResult['findings'] = []
  for (const item of value) {
    if (!item || typeof item !== 'object') continue
    const record = item as Record<string, unknown>
    const title =
      typeof record.title === 'string' ? normalizeInline(record.title) : ''
    const url = typeof record.url === 'string' ? record.url.trim() : ''
    const relation =
      typeof record.relation_to_claim === 'string'
        ? normalizeInline(record.relation_to_claim)
        : ''
    const evidenceTypeRaw =
      typeof record.evidence_type === 'string'
        ? record.evidence_type.trim()
        : 'other'
    const evidence_type: LiteratureDiscoveryResult['findings'][number]['evidence_type'] =
      evidenceTypeRaw === 'paper' ||
      evidenceTypeRaw === 'preprint' ||
      evidenceTypeRaw === 'survey' ||
      evidenceTypeRaw === 'technical_report' ||
      evidenceTypeRaw === 'repository'
        ? evidenceTypeRaw
        : 'other'

    if (!title || !url || !relation) continue
    findings.push({
      title,
      url,
      evidence_type,
      relation_to_claim: relation,
    })
    if (findings.length >= 15) break
  }
  return findings
}

function parseStrictLiteratureOutput(
  rawText: string,
): LiteratureDiscoveryResult | null {
  const candidate = extractJsonCandidate(rawText)
  if (!candidate.startsWith('{') || !candidate.endsWith('}')) return null

  try {
    const parsed = JSON.parse(candidate) as Record<string, unknown>
    const summary =
      typeof parsed.summary === 'string' ? normalizeInline(parsed.summary) : ''
    const noveltyAssessment = normalizeNoveltyAssessment(
      parsed.novelty_assessment,
    )

    if (!summary || !noveltyAssessment) return null

    const findings = normalizeFindings(parsed.findings)
    const searchQueries = normalizeStringList(parsed.search_queries)
    const overlapSignals = normalizeStringList(parsed.overlap_signals)
    const noveltySignals = normalizeStringList(parsed.novelty_signals)
    const gaps = normalizeStringList(parsed.gaps)
    const nextSteps = normalizeStringList(parsed.recommended_next_steps)

    return {
      summary,
      novelty_assessment: noveltyAssessment,
      confidence: normalizeConfidence(parsed.confidence),
      search_queries: searchQueries,
      findings,
      overlap_signals: overlapSignals,
      novelty_signals: noveltySignals,
      gaps,
      recommended_next_steps: nextSteps,
    }
  } catch {
    return null
  }
}

function formatLiteratureResult(result: LiteratureDiscoveryResult): string {
  const topFindings = result.findings
    .slice(0, 5)
    .map(item => `- ${item.title} (${item.url})`)
    .join('\n')

  return [
    'Literature discovery result:',
    `Summary: ${result.summary}`,
    `Novelty assessment: ${result.novelty_assessment}`,
    `Confidence: ${result.confidence ?? 'unknown'}`,
    `Queries used: ${result.search_queries.length}`,
    `Findings: ${result.findings.length}`,
    topFindings ? `Top findings:\n${topFindings}` : '',
  ]
    .filter(Boolean)
    .join('\n')
}

const webSearchParamsSchema = z.object({
  query: z.string().describe('Search query for literature discovery'),
  max_results: z
    .number()
    .int()
    .min(1)
    .max(10)
    .optional()
    .describe('Maximum number of results to return (1-10)'),
})

const webFetchParamsSchema = z.object({
  url: z.string().describe('HTTP/HTTPS URL to inspect'),
  max_chars: z
    .number()
    .int()
    .min(500)
    .max(20000)
    .optional()
    .describe('Maximum number of characters to return (500-20000)'),
})

function createWebSearchTool(params: {
  signal?: AbortSignal
  budget: LiteratureToolBudget
}): FunctionTool {
  return new FunctionTool({
    name: 'web_search',
    description:
      'Searches the public web for papers, preprints, surveys, and technical sources.',
    parameters: webSearchParamsSchema,
    execute: async args => {
      const query = typeof args?.query === 'string' ? args.query.trim() : ''
      const maxResults = clampInt(args?.max_results, 6, 1, 10)
      if (!query) {
        return {
          query,
          results: [],
          error: 'query_required',
        }
      }

      if (params.budget.searchCalls >= params.budget.maxSearchCalls) {
        return {
          query,
          results: [],
          error: 'tool_budget_exceeded',
          tool: 'web_search',
          budget: {
            used: params.budget.searchCalls,
            limit: params.budget.maxSearchCalls,
          },
          message:
            'TOOL_BUDGET_EXCEEDED. Do not call web_search again; synthesize final JSON from current evidence.',
        }
      }
      params.budget.searchCalls += 1

      try {
        const provider = searchProviders.google
        const results = await provider.search(query, undefined, {
          signal: params.signal,
        })
        return {
          query,
          call_index: params.budget.searchCalls,
          results: results.slice(0, maxResults).map(item => ({
            title: item.title,
            snippet: item.snippet,
            link: item.link,
          })),
        }
      } catch (error) {
        return {
          query,
          call_index: params.budget.searchCalls,
          results: [],
          error: error instanceof Error ? error.message : String(error),
        }
      }
    },
  })
}

function createWebFetchTool(params: {
  signal?: AbortSignal
  budget: LiteratureToolBudget
}): FunctionTool {
  return new FunctionTool({
    name: 'web_fetch',
    description:
      'Fetches a URL and returns a cleaned text excerpt for evidence extraction.',
    parameters: webFetchParamsSchema,
    execute: async args => {
      const urlRaw = typeof args?.url === 'string' ? args.url.trim() : ''
      const maxChars = clampInt(args?.max_chars, 6000, 500, 20000)

      if (params.budget.fetchCalls >= params.budget.maxFetchCalls) {
        return {
          url: urlRaw,
          error: 'tool_budget_exceeded',
          tool: 'web_fetch',
          budget: {
            used: params.budget.fetchCalls,
            limit: params.budget.maxFetchCalls,
          },
          message:
            'TOOL_BUDGET_EXCEEDED. Do not call web_fetch again; synthesize final JSON from current evidence.',
        }
      }
      params.budget.fetchCalls += 1

      let url: URL
      try {
        url = new URL(urlRaw)
      } catch {
        return {
          url: urlRaw,
          error: 'invalid_url',
        }
      }

      if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        return {
          url: url.toString(),
          error: 'unsupported_protocol',
        }
      }

      try {
        const response = await fetch(url.toString(), {
          method: 'GET',
          headers: {
            'User-Agent': 'Mozilla/5.0 (compatible; AmawtaLiteratureScout/1.0)',
            Accept: 'text/html,application/pdf,text/plain,*/*',
          },
          signal: params.signal,
        })

        const contentType = response.headers.get('content-type') || ''
        const rawText = await response.text()
        const text =
          contentType.includes('text/html') || contentType.includes('xml')
            ? normalizeInline(parse(rawText).structuredText || '')
            : normalizeInline(rawText)

        return {
          url: url.toString(),
          call_index: params.budget.fetchCalls,
          status: response.status,
          content_type: contentType,
          excerpt: text.slice(0, maxChars),
          chars: text.length,
        }
      } catch (error) {
        return {
          url: url.toString(),
          call_index: params.budget.fetchCalls,
          error: error instanceof Error ? error.message : String(error),
        }
      }
    },
  })
}

async function runSingleLiteraturePass(
  params: LiteratureDiscoveryAgentInput & AttemptMetadata,
): Promise<SingleLiteratureRunResult> {
  const toolBudget = createLiteratureToolBudget(params.attemptIndex ?? 0)
  const baseModel = new Gemini({
    model: params.modelName,
    apiKey: params.apiKey?.trim() || undefined,
  })

  const literatureAgent = new LlmAgent({
    name: LITERATURE_SUBAGENT_NAME,
    model: baseModel,
    description:
      'Searches literature on the web, evaluates novelty overlap, and returns structured evidence summary.',
    instruction: LITERATURE_SUBAGENT_INSTRUCTION,
    tools: [
      createWebSearchTool({ signal: params.signal, budget: toolBudget }),
      createWebFetchTool({ signal: params.signal, budget: toolBudget }),
    ],
  })

  const runtime = __agentRuntime.buildAdkSessionRuntime(
    'literature',
    params.conversationKey,
    { attemptIndex: params.attemptIndex },
  )

  const runner = __agentRuntime.createAdkRunner({
    appName: runtime.appName,
    agent: literatureAgent,
  })

  const session = await runner.sessionService.createSession({
    appName: runtime.appName,
    userId: runtime.userId,
    sessionId: runtime.sessionId,
    state: runtime.initialState,
  })

  const newMessage = {
    role: 'user',
    parts: [{ text: buildLiteratureInputFromContext(params) }],
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
      maxSearchCalls: toolBudget.maxSearchCalls,
      maxFetchCalls: toolBudget.maxFetchCalls,
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
      filename: 'literature-events.json',
      pointerKey: 'literature_events',
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
      text: 'Literature subagent returned empty output.',
      metadata: { reason: 'empty_output' },
    })
    await __agentRuntime.persistAdkArtifact({
      runner,
      runtime,
      session,
      filename: 'literature-events.json',
      pointerKey: 'literature_events',
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
      `Literature subagent returned empty output.${__agentRuntime.formatEventDiagnostics(lastRunnerEvent)}`,
    )
  }

  const parsed = parseStrictLiteratureOutput(trimmed)
  if (!parsed) {
    __agentRuntime.captureSyntheticTraceEventWithDrop({
      trace: eventTrace,
      droppedCounter: droppedEventTraceCount,
      scope: runtime.scope,
      kind: 'error',
      text: 'Literature subagent contract violation: expected strict literature JSON output.',
      metadata: { reason: 'contract_violation' },
    })
    await __agentRuntime.persistAdkArtifact({
      runner,
      runtime,
      session,
      filename: 'literature-invalid-output.json',
      pointerKey: 'literature_invalid_output',
      payload: {
        scope: runtime.scope,
        conversationKey: runtime.conversationKey,
        rawOutput: trimmed,
      },
    })
    throw new Error(
      'Literature subagent contract violation: expected strict literature JSON output.',
    )
  }

  await __agentRuntime.persistAdkArtifact({
    runner,
    runtime,
    session,
    filename: 'literature-result.json',
    pointerKey: 'literature_result',
    payload: {
      route: 'literature',
      conversationKey: runtime.conversationKey,
      input: {
        hypothesis: params.hypothesisInput,
        formaVeritas: params.baconianFormaVeritas,
        dialecticalSynthesis: params.dialecticalSynthesis,
        domainHint: params.domainHint,
      },
      output: parsed,
    },
  })

  return {
    text: __agentRuntime.withArtifactsLocationFooter(
      formatLiteratureResult(parsed),
      { runtime, session },
    ),
    literature: parsed,
  }
}

export async function runLiteratureDiscoveryAgent(
  params: LiteratureDiscoveryAgentInput,
): Promise<{
  text: string
  retriesUsed: number
  literature?: LiteratureDiscoveryResult
}> {
  const scope = 'literature' as const
  const maxRetries = Math.max(0, Math.min(4, params.maxRetries ?? 2))
  let retriesUsed = 0
  let modelName = params.modelName
  let failoverUsed = false
  const globalTimeoutMs = __agentRuntime.getScopeGlobalTimeoutMs(scope)
  const attemptTimeoutMs = __agentRuntime.getScopeAttemptTimeoutMs(scope)
  const globalControl = __agentRuntime.createScopedAbortControl({
    parentSignal: params.signal,
    timeoutMs: globalTimeoutMs,
    timeoutErrorMessage:
      'Literature discovery timed out before completion. Try narrowing domain scope or reducing claim breadth.',
  })

  try {
    const effectiveSignal = globalControl.signal
    while (true) {
      const attemptControl = __agentRuntime.createScopedAbortControl({
        parentSignal: effectiveSignal,
        timeoutMs: attemptTimeoutMs,
        timeoutErrorMessage:
          'Literature discovery attempt timed out. Retrying with a fresh attempt.',
      })
      try {
        const result = await runSingleLiteraturePass({
          ...params,
          modelName,
          signal: attemptControl.signal,
          attemptIndex: retriesUsed,
          maxRetries,
        })
        return {
          text: result.text,
          retriesUsed,
          literature: result.literature,
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
