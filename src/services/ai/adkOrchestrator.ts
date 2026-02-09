import {
  AgentTool,
  Gemini,
  InMemoryMemoryService,
  InMemorySessionService,
  LlmAgent,
  Runner,
  SequentialAgent,
  getFunctionCalls,
  getFunctionResponses,
  isFinalResponse,
  stringifyContent,
} from '@google/adk'
import type { BaseAgent } from '@google/adk'
import type { Event } from '@google/adk'
import type { Part } from '@google/genai'
import { homedir } from 'os'
import { debug as debugLogger } from '@utils/log/debugLogger'
import {
  buildDeterministicAdkSessionId,
  loadAdkPersistedState,
  saveAdkPersistedState,
} from './adkStateStore'
import { LocalFsArtifactService } from './localFsArtifactService'
import {
  ADK_ORCHESTRATOR_NO_DIALECTIC_TOKEN,
  BACONIAN_SUBAGENT_INSTRUCTION,
  BACONIAN_SUBAGENT_NAME,
  DIALECTICAL_SUBAGENT_INSTRUCTION,
  DIALECTICAL_SUBAGENT_NAME,
  EXPERIMENT_RUNNERS_SUBAGENT_INSTRUCTION,
  EXPERIMENT_RUNNERS_SUBAGENT_NAME,
  FALSIFICATION_SUBAGENT_INSTRUCTION,
  FALSIFICATION_SUBAGENT_NAME,
  NORMALIZATION_SUBAGENT_INSTRUCTION,
  NORMALIZATION_SUBAGENT_NAME,
  buildAdkOrchestratorInstruction,
} from './prompts/adkDialecticPrompts'
import type {
  AdkOrchestratorResult,
  BaconianResult,
  DialecticResult,
  ExperimentRunnersResult,
  FalsificationPlanResult,
  HypothesisNormalizationResult,
  OrchestratorRoute,
} from './types/adkDialectic'

const ORCHESTRATOR_APP_NAME = 'AmawtaAdkOrchestratorV1'
const ORCHESTRATOR_USER_ID = 'amawta-main-user'
const ARTIFACT_STATE_KEY = 'amawta:artifacts'
const ADK_SHARED_STATE_NAMESPACE = 'adk-shared-v1'
const ADK_LOCAL_ARTIFACT_SERVICE = new LocalFsArtifactService()
const EVENT_TRACE_MAX_ENTRIES = 240
const RETRY_BASE_DELAY_MS = 700
const RETRY_MAX_DELAY_MS = 12_000
const RETRY_JITTER_RATIO = 0.3

export type QueryAdkOrchestratorParams = {
  modelName: string
  apiKey?: string
  userPrompt: string
  conversationContext?: string
  conversationKey?: string
  signal?: AbortSignal
  maxRetries?: number
}

export type RunDialecticalSubagentParams = {
  modelName: string
  apiKey?: string
  prompt: string
  conversationKey?: string
  signal?: AbortSignal
  maxRetries?: number
}

export type RunBaconianSubagentParams = {
  modelName: string
  apiKey?: string
  hypothesisPrompt: string
  dialectic: DialecticResult
  conversationKey?: string
  signal?: AbortSignal
  maxRetries?: number
}

export type RunLiteratureSubagentParams = {
  modelName: string
  apiKey?: string
  hypothesisInput: string
  baconianFormaVeritas: string
  dialecticalSynthesis?: string
  domainHint?: string
  conversationKey?: string
  signal?: AbortSignal
  maxRetries?: number
}

export type RunFalsificationSubagentParams = {
  modelName: string
  apiKey?: string
  hypothesisInput: string
  hypothesisCleaned?: string
  veritasFormRaw?: string
  normalizationRaw?: string
  literatureSearchRaw?: string
  literatureExtractRaw?: string
  invariantsCatalogMd?: string
  catalogSha256?: string
  normalizationOk?: boolean
  missingFields?: string[]
  conversationKey?: string
  signal?: AbortSignal
  maxRetries?: number
}

export type RunExperimentRunnersSubagentParams = {
  modelName: string
  apiKey?: string
  hypothesisInput: string
  dialecticalSynthesis?: string
  baconianFormaVeritas?: string
  normalizationRaw?: string
  falsificationRaw?: string
  literatureSummary?: string
  conversationKey?: string
  signal?: AbortSignal
  maxRetries?: number
}

export type RunNormalizationSubagentParams = {
  modelName: string
  apiKey?: string
  hypothesisInput: string
  dialecticalSynthesis?: string
  baconianFormaVeritas?: string
  literatureSummary?: string
  previousNormalizationRaw?: string
  mode?: 'strict' | 'autocorrect'
  conversationKey?: string
  signal?: AbortSignal
  maxRetries?: number
}

type SingleRunResult = {
  route: OrchestratorRoute
  text: string
  dialectic?: DialecticResult
  baconian?: BaconianResult
}

type SingleFalsificationRunResult = {
  text: string
  falsification: FalsificationPlanResult
}

type SingleExperimentRunnersRunResult = {
  text: string
  runners: ExperimentRunnersResult
}

type SingleNormalizationRunResult = {
  text: string
  normalization: HypothesisNormalizationResult
}

type AdkSessionScope =
  | 'orchestrator'
  | 'dialectical'
  | 'baconian'
  | 'literature'
  | 'normalization'
  | 'falsification'
  | 'runners'

type AdkSessionRuntime = {
  scope: AdkSessionScope
  namespace: string
  appName: string
  userId: string
  conversationKey: string
  sessionId: string
  initialState: Record<string, unknown>
  attemptIndex?: number
  isolatedRetrySession?: boolean
}

export type AttemptMetadata = {
  attemptIndex?: number
  maxRetries?: number
}

type ExecutionBudget = {
  scope: AdkSessionScope
  startedAtMs: number
  deadlineAtMs: number
  maxRuntimeMs: number
  maxEvents: number
  maxToolCalls: number
  eventsSeen: number
  toolCallsSeen: number
}

function readPositiveIntEnv(name: string): number | undefined {
  const raw = process.env[name]
  if (!raw) return undefined
  const parsed = Number.parseInt(raw, 10)
  if (!Number.isFinite(parsed) || parsed <= 0) return undefined
  return parsed
}

function readBooleanEnv(name: string, defaultValue: boolean): boolean {
  const raw = process.env[name]?.trim().toLowerCase()
  if (!raw) return defaultValue
  return !(raw === '0' || raw === 'false' || raw === 'off' || raw === 'no')
}

function isAdkDeterministicModeEnabled(): boolean {
  return readBooleanEnv('AMAWTA_ADK_DETERMINISTIC_MODE', false)
}

function isAdkLongRunModeEnabled(): boolean {
  return readBooleanEnv('AMAWTA_ADK_LONGRUN_MODE', false)
}

function shouldIsolateRetrySessions(): boolean {
  return readBooleanEnv('AMAWTA_ADK_ISOLATE_RETRY_SESSIONS', true)
}

function shouldUseSequentialOrchestratorWorkflow(): boolean {
  return readBooleanEnv('AMAWTA_ADK_USE_SEQUENTIAL_ORCHESTRATOR', true)
}

function getScopeAttemptTimeoutMs(scope: AdkSessionScope): number {
  const byScope =
    readPositiveIntEnv(`AMAWTA_ADK_${scope.toUpperCase()}_ATTEMPT_TIMEOUT_MS`) ??
    undefined
  if (byScope) return byScope

  const globalOverride = readPositiveIntEnv('AMAWTA_ADK_ATTEMPT_TIMEOUT_MS')
  if (globalOverride) return globalOverride

  if (isAdkLongRunModeEnabled()) {
    switch (scope) {
      case 'orchestrator':
        return 1_200_000
      case 'falsification':
      case 'runners':
        return 1_800_000
      default:
        return 1_200_000
    }
  }

  switch (scope) {
    case 'orchestrator':
      return 180_000
    case 'falsification':
      return 210_000
    case 'runners':
      return 210_000
    default:
      return 150_000
  }
}

function getScopeGlobalTimeoutMs(scope: AdkSessionScope): number {
  const byScope =
    readPositiveIntEnv(`AMAWTA_ADK_${scope.toUpperCase()}_GLOBAL_TIMEOUT_MS`) ??
    undefined
  if (byScope) return byScope

  const globalOverride = readPositiveIntEnv('AMAWTA_ADK_GLOBAL_TIMEOUT_MS')
  if (globalOverride) return globalOverride

  if (isAdkLongRunModeEnabled()) {
    switch (scope) {
      case 'orchestrator':
        return 28_800_000
      case 'falsification':
      case 'runners':
        return 21_600_000
      default:
        return 21_600_000
    }
  }

  switch (scope) {
    case 'orchestrator':
      return 480_000
    case 'falsification':
      return 360_000
    case 'runners':
      return 360_000
    default:
      return 300_000
  }
}

function getScopeMaxEvents(scope: AdkSessionScope): number {
  const byScope =
    readPositiveIntEnv(`AMAWTA_ADK_${scope.toUpperCase()}_MAX_EVENTS`) ??
    undefined
  if (byScope) return byScope

  const globalOverride = readPositiveIntEnv('AMAWTA_ADK_MAX_EVENTS')
  if (globalOverride) return globalOverride

  if (isAdkLongRunModeEnabled()) {
    return scope === 'orchestrator' ? 20_000 : 8_000
  }

  return scope === 'orchestrator' ? 420 : 280
}

function getScopeMaxToolCalls(scope: AdkSessionScope): number {
  const byScope =
    readPositiveIntEnv(`AMAWTA_ADK_${scope.toUpperCase()}_MAX_TOOL_CALLS`) ??
    undefined
  if (byScope) return byScope

  const globalOverride = readPositiveIntEnv('AMAWTA_ADK_MAX_TOOL_CALLS')
  if (globalOverride) return globalOverride

  if (isAdkLongRunModeEnabled()) {
    if (scope === 'orchestrator') return 2_000
    if (scope === 'literature') return 1_600
    return 1_200
  }

  if (scope === 'orchestrator') return 80
  if (scope === 'literature') return 80
  return 40
}

function createExecutionBudget(scope: AdkSessionScope): ExecutionBudget {
  const startedAtMs = Date.now()
  const maxRuntimeMs = getScopeAttemptTimeoutMs(scope)
  return {
    scope,
    startedAtMs,
    deadlineAtMs: startedAtMs + maxRuntimeMs,
    maxRuntimeMs,
    maxEvents: getScopeMaxEvents(scope),
    maxToolCalls: getScopeMaxToolCalls(scope),
    eventsSeen: 0,
    toolCallsSeen: 0,
  }
}

function enforceExecutionBudgetOrThrow(
  budget: ExecutionBudget,
  event: Event,
): void {
  const now = Date.now()
  if (now > budget.deadlineAtMs) {
    const elapsed = now - budget.startedAtMs
    throw new Error(
      `ADK ${budget.scope} execution budget exceeded: runtime ${elapsed}ms > ${budget.maxRuntimeMs}ms`,
    )
  }

  budget.eventsSeen += 1
  if (budget.eventsSeen > budget.maxEvents) {
    throw new Error(
      `ADK ${budget.scope} execution budget exceeded: events ${budget.eventsSeen} > ${budget.maxEvents}`,
    )
  }

  budget.toolCallsSeen += getFunctionCalls(event).length
  if (budget.toolCallsSeen > budget.maxToolCalls) {
    throw new Error(
      `ADK ${budget.scope} execution budget exceeded: tool_calls ${budget.toolCallsSeen} > ${budget.maxToolCalls}`,
    )
  }
}

function computeRetryDelayMs(params: {
  attempt: number
  baseDelayMs?: number
  maxDelayMs?: number
  jitterRatio?: number
  random?: () => number
}): number {
  const attempt = Math.max(0, Math.floor(params.attempt))
  const baseDelayMs = params.baseDelayMs ?? RETRY_BASE_DELAY_MS
  const maxDelayMs = params.maxDelayMs ?? RETRY_MAX_DELAY_MS
  const jitterRatio =
    params.jitterRatio ??
    (isAdkDeterministicModeEnabled() ? 0 : RETRY_JITTER_RATIO)
  const randomFn =
    params.random ??
    (isAdkDeterministicModeEnabled() ? () => 0.5 : Math.random)
  const randomValue = Math.min(
    1,
    Math.max(0, randomFn()),
  )

  const exponentialDelay = Math.min(
    maxDelayMs,
    baseDelayMs * 2 ** Math.min(attempt, 10),
  )
  const jitterWindow = Math.max(
    0,
    Math.floor(exponentialDelay * Math.max(0, jitterRatio)),
  )
  const jitter = Math.floor((randomValue * 2 - 1) * jitterWindow)
  return Math.max(0, exponentialDelay + jitter)
}

function createScopedAbortControl(params: {
  parentSignal?: AbortSignal
  timeoutMs: number
  timeoutErrorMessage: string
}): {
  signal: AbortSignal
  cleanup: () => void
  didTimeout: () => boolean
  timeoutErrorMessage: string
} {
  const controller = new AbortController()
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, Math.max(1, params.timeoutMs))

  const onParentAbort = () => controller.abort()
  if (params.parentSignal) {
    params.parentSignal.addEventListener('abort', onParentAbort, { once: true })
    if (params.parentSignal.aborted) {
      controller.abort()
    }
  }

  return {
    signal: controller.signal,
    cleanup: () => {
      clearTimeout(timer)
      params.parentSignal?.removeEventListener('abort', onParentAbort)
    },
    didTimeout: () => timedOut,
    timeoutErrorMessage: params.timeoutErrorMessage,
  }
}

async function getNextRunnerEvent(params: {
  iterator: AsyncIterator<Event>
  signal?: AbortSignal
  budget: ExecutionBudget
}): Promise<IteratorResult<Event>> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined
  let onAbort: (() => void) | undefined

  const abortPromise = new Promise<IteratorResult<Event>>((_, reject) => {
    if (!params.signal) return
    if (params.signal.aborted) {
      reject(new Error('Request cancelled by user'))
      return
    }
    onAbort = () => reject(new Error('Request cancelled by user'))
    params.signal.addEventListener('abort', onAbort, { once: true })
  })

  const timeoutPromise = new Promise<IteratorResult<Event>>((_, reject) => {
    const remainingMs = Math.max(0, params.budget.deadlineAtMs - Date.now())
    if (remainingMs <= 0) {
      reject(
        new Error(
          `ADK ${params.budget.scope} execution budget exceeded: runtime ${Date.now() - params.budget.startedAtMs}ms > ${params.budget.maxRuntimeMs}ms`,
        ),
      )
      return
    }

    timeoutId = setTimeout(() => {
      reject(
        new Error(
          `ADK ${params.budget.scope} execution budget exceeded: runtime ${Date.now() - params.budget.startedAtMs}ms > ${params.budget.maxRuntimeMs}ms`,
        ),
      )
    }, remainingMs)
  })

  try {
    return await Promise.race([
      params.iterator.next(),
      abortPromise,
      timeoutPromise,
    ])
  } finally {
    if (timeoutId) clearTimeout(timeoutId)
    if (onAbort && params.signal) {
      params.signal.removeEventListener('abort', onAbort)
    }
  }
}

async function consumeRunnerEvents(params: {
  runner: Runner
  session: { id: string; userId: string }
  newMessage: unknown
  signal?: AbortSignal
  budget: ExecutionBudget
  onEvent: (event: Event) => void
}): Promise<void> {
  const stream = params.runner.runAsync({
    userId: params.session.userId,
    sessionId: params.session.id,
    newMessage: params.newMessage as any,
  }) as AsyncIterable<Event>
  const iterator = stream[Symbol.asyncIterator]()

  try {
    while (true) {
      const nextResult = await getNextRunnerEvent({
        iterator,
        signal: params.signal,
        budget: params.budget,
      })
      if (nextResult.done) break

      const event = nextResult.value
      enforceExecutionBudgetOrThrow(params.budget, event)
      params.onEvent(event)
    }
  } finally {
    try {
      await iterator.return?.()
    } catch {
      // no-op: best effort to close event stream when timing out/cancelling
    }
  }
}

function extractStatusCode(error: unknown): number | undefined {
  if (!error || typeof error !== 'object') return undefined
  const status = (error as any).status
  if (typeof status === 'number') return status
  const code = (error as any).code
  if (typeof code === 'number') return code
  return undefined
}

function isRetryableAdkError(error: unknown): boolean {
  const status = extractStatusCode(error)
  if (typeof status === 'number') {
    if (status === 408 || status === 409 || status === 429) return true
    if (status >= 500) return true
  }

  const message = String((error as any)?.message || error || '').toLowerCase()
  if (!message) return false

  return [
    'timeout',
    'timed out',
    'temporary',
    'temporarily unavailable',
    'network',
    'connection reset',
    'econn',
    '429',
    'overloaded',
    'service unavailable',
    '502',
    '503',
    '504',
    'contract violation',
    'structured output',
    'returned empty output',
    'empty output',
    'expected strict',
    'unexpected token',
    'not valid json',
    'invalid json',
    'json parse',
  ].some(token => message.includes(token))
}

function normalizeStrictJsonContractError(
  scope: AdkSessionScope,
  error: unknown,
): Error {
  const original =
    error instanceof Error ? error : new Error(String(error || 'Unknown error'))
  const message = String(original.message || '').toLowerCase()
  if (!message) return original

  const isJsonParseLikeError =
    message.includes('unexpected token') ||
    message.includes('not valid json') ||
    message.includes('invalid json') ||
    message.includes('json parse') ||
    (message.includes('exception') && message.includes('json'))

  if (!isJsonParseLikeError || message.includes('contract violation')) {
    return original
  }

  const contractViolationByScope: Record<AdkSessionScope, string> = {
    orchestrator:
      'ADK orchestrator contract violation: expected dialectical + baconian strict JSON output.',
    dialectical:
      'Dialectical subagent contract violation: expected strict dialectical JSON output.',
    baconian:
      'Baconian subagent contract violation: expected strict baconian JSON output.',
    literature:
      'Literature subagent contract violation: expected strict literature JSON output.',
    normalization:
      'Normalization subagent contract violation: expected strict normalization JSON output.',
    falsification:
      'Falsification subagent contract violation: expected strict falsification JSON output.',
    runners:
      'Experiment runners subagent contract violation: expected strict experiment runners JSON output.',
  }

  return new Error(contractViolationByScope[scope])
}

async function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  if (!ms || ms <= 0) return
  await new Promise<void>((resolve, reject) => {
    let settled = false
    if (signal?.aborted) {
      reject(new Error('Request cancelled by user'))
      return
    }

    const timeout = setTimeout(() => {
      settled = true
      if (signal) {
        signal.removeEventListener('abort', onAbort)
      }
      resolve()
    }, ms)

    const onAbort = () => {
      if (settled) return
      clearTimeout(timeout)
      if (signal) {
        signal.removeEventListener('abort', onAbort)
      }
      reject(new Error('Request cancelled by user'))
    }

    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

function buildOrchestratorInput(
  userPrompt: string,
  conversationContext?: string,
): string {
  const trimmedContext = conversationContext?.trim()
  if (!trimmedContext) return userPrompt

  return [
    'Conversation context (recent):',
    trimmedContext,
    '',
    'Latest user request:',
    userPrompt,
  ].join('\n')
}

function normalizeAdkConversationKey(conversationKey?: string): string {
  const trimmed = conversationKey?.trim()
  if (!trimmed) return 'default'
  return trimmed
}

function getAdkNamespace(scope: AdkSessionScope): string {
  return `adk-${scope}-v1`
}

function getAdkSharedStateNamespace(): string {
  return ADK_SHARED_STATE_NAMESPACE
}

function getAdkAppName(scope: AdkSessionScope): string {
  if (scope === 'orchestrator') {
    return ORCHESTRATOR_APP_NAME
  }

  if (scope === 'dialectical') {
    return `${ORCHESTRATOR_APP_NAME}_Dialectical`
  }

  if (scope === 'baconian') {
    return `${ORCHESTRATOR_APP_NAME}_Baconian`
  }

  if (scope === 'literature') {
    return `${ORCHESTRATOR_APP_NAME}_Literature`
  }

  if (scope === 'normalization') {
    return `${ORCHESTRATOR_APP_NAME}_Normalization`
  }

  if (scope === 'runners') {
    return `${ORCHESTRATOR_APP_NAME}_Runners`
  }

  return `${ORCHESTRATOR_APP_NAME}_Falsification`
}

function buildAdkSessionRuntime(
  scope: AdkSessionScope,
  conversationKey?: string,
  options?: { attemptIndex?: number },
): AdkSessionRuntime {
  const attemptIndex = Math.max(0, options?.attemptIndex ?? 0)
  const normalizedConversationKey = normalizeAdkConversationKey(conversationKey)
  const namespace = getAdkNamespace(scope)
  const appName = getAdkAppName(scope)
  const isolateRetrySession = shouldIsolateRetrySessions() && attemptIndex > 0
  const sessionNamespace = isolateRetrySession
    ? `${namespace}-attempt-${attemptIndex + 1}`
    : namespace
  const sessionId = buildDeterministicAdkSessionId(
    sessionNamespace,
    normalizedConversationKey,
  )
  const initialState = loadAdkPersistedState({
    namespace: getAdkSharedStateNamespace(),
    conversationKey: normalizedConversationKey,
  })

  return {
    scope,
    namespace,
    appName,
    userId: ORCHESTRATOR_USER_ID,
    conversationKey: normalizedConversationKey,
    sessionId,
    initialState,
    attemptIndex,
    isolatedRetrySession: isolateRetrySession,
  }
}

async function persistAdkSessionRuntimeState(params: {
  runner: Runner
  session: { id: string; userId: string }
  runtime: AdkSessionRuntime
}): Promise<void> {
  try {
    const persistedSession = await params.runner.sessionService.getSession({
      appName: params.runtime.appName,
      userId: params.session.userId,
      sessionId: params.session.id,
    })

    const state =
      persistedSession?.state &&
      typeof persistedSession.state === 'object' &&
      !Array.isArray(persistedSession.state)
        ? (persistedSession.state as Record<string, unknown>)
        : {}

    const stateKey = {
      namespace: getAdkSharedStateNamespace(),
      conversationKey: params.runtime.conversationKey,
    }
    const existingState = loadAdkPersistedState(stateKey)
    const existingArtifacts =
      existingState[ARTIFACT_STATE_KEY] &&
      typeof existingState[ARTIFACT_STATE_KEY] === 'object' &&
      !Array.isArray(existingState[ARTIFACT_STATE_KEY])
        ? (existingState[ARTIFACT_STATE_KEY] as Record<string, unknown>)
        : {}
    const newArtifacts =
      state[ARTIFACT_STATE_KEY] &&
      typeof state[ARTIFACT_STATE_KEY] === 'object' &&
      !Array.isArray(state[ARTIFACT_STATE_KEY])
        ? (state[ARTIFACT_STATE_KEY] as Record<string, unknown>)
        : {}

    saveAdkPersistedState(stateKey, {
      ...existingState,
      ...state,
      [ARTIFACT_STATE_KEY]: {
        ...existingArtifacts,
        ...newArtifacts,
      },
    })
  } catch (error) {
    debugLogger.warn('ADK_STATE_PERSIST_SNAPSHOT_FAILED', {
      scope: params.runtime.scope,
      conversationKey: params.runtime.conversationKey,
      error: error instanceof Error ? error.message : String(error),
    })
  }
}

function createAdkRunner(params: {
  appName: string
  agent: BaseAgent
}): Runner {
  return new Runner({
    appName: params.appName,
    agent: params.agent,
    sessionService: new InMemorySessionService(),
    memoryService: new InMemoryMemoryService(),
    artifactService: ADK_LOCAL_ARTIFACT_SERVICE,
  })
}

function buildJsonArtifactPart(payload: unknown): Part {
  return {
    inlineData: {
      mimeType: 'application/json',
      data: Buffer.from(JSON.stringify(payload, null, 2), 'utf8').toString(
        'base64',
      ),
    },
  }
}

function safePreview(text: string, maxLen = 180): string {
  const trimmed = text.trim()
  if (trimmed.length <= maxLen) return trimmed
  return `${trimmed.slice(0, maxLen)}...`
}

function buildAdkEventSnapshot(event: Event): Record<string, unknown> {
  const text = extractBestEventText(event)
  const actions = event.actions ?? ({} as any)

  const stateDelta =
    actions.stateDelta && typeof actions.stateDelta === 'object'
      ? actions.stateDelta
      : {}
  const artifactDelta =
    actions.artifactDelta && typeof actions.artifactDelta === 'object'
      ? actions.artifactDelta
      : {}
  const requestedAuthConfigs =
    actions.requestedAuthConfigs &&
    typeof actions.requestedAuthConfigs === 'object'
      ? actions.requestedAuthConfigs
      : {}
  const requestedToolConfirmations =
    actions.requestedToolConfirmations &&
    typeof actions.requestedToolConfirmations === 'object'
      ? actions.requestedToolConfirmations
      : {}

  const functionCalls = getFunctionCalls(event).map(call => ({
    name: call.name,
    args:
      call.args && typeof call.args === 'object'
        ? Object.keys(call.args).sort()
        : [],
  }))

  const functionResponses = getFunctionResponses(event).map(response => ({
    name: response.name,
    preview: safePreview(extractFunctionResponseResultText(response), 120),
  }))

  return {
    id: event.id,
    invocationId: event.invocationId,
    author: event.author || 'unknown',
    timestamp: event.timestamp,
    branch: event.branch,
    partial: event.partial === true,
    finalResponse: isFinalResponse(event),
    hasText: text.length > 0,
    textPreview: text.length > 0 ? safePreview(text) : undefined,
    longRunningToolIds:
      Array.isArray(event.longRunningToolIds) && event.longRunningToolIds.length
        ? [...event.longRunningToolIds]
        : [],
    functionCalls,
    functionResponses,
    actions: {
      transferToAgent:
        typeof actions.transferToAgent === 'string'
          ? actions.transferToAgent
          : undefined,
      escalate: actions.escalate === true,
      skipSummarization: actions.skipSummarization === true,
      stateDeltaKeys: Object.keys(stateDelta).sort(),
      artifactDeltaKeys: Object.keys(artifactDelta).sort(),
      requestedAuthConfigIds: Object.keys(requestedAuthConfigs).sort(),
      requestedToolConfirmationIds: Object.keys(
        requestedToolConfirmations,
      ).sort(),
    },
  }
}

function captureAdkEventTrace(
  trace: Record<string, unknown>[],
  event: Event,
): boolean {
  if (trace.length >= EVENT_TRACE_MAX_ENTRIES) {
    return false
  }

  trace.push(buildAdkEventSnapshot(event))
  return true
}

type DroppedCounter = { value: number }
let syntheticTraceSequence = 0

function captureAdkEventTraceWithDrop(params: {
  trace: Record<string, unknown>[]
  droppedCounter: DroppedCounter
  event: Event
}): void {
  if (!captureAdkEventTrace(params.trace, params.event)) {
    params.droppedCounter.value += 1
  }
}

function buildSyntheticTraceEvent(params: {
  scope: AdkSessionScope
  kind:
    | 'stage_start'
    | 'stage_end'
    | 'tool_start'
    | 'tool_end'
    | 'error'
    | 'retry'
  text: string
  metadata?: Record<string, unknown>
}): Record<string, unknown> {
  const now = Date.now()
  syntheticTraceSequence += 1
  return {
    id: `synthetic-${params.scope}-${params.kind}-${now}-${syntheticTraceSequence}`,
    invocationId: `synthetic-${params.scope}`,
    author: 'AmawtaRuntime',
    timestamp: now,
    branch: params.scope,
    partial: false,
    finalResponse: false,
    hasText: true,
    textPreview: safePreview(params.text),
    longRunningToolIds: [],
    functionCalls: [],
    functionResponses: [],
    actions: {
      transferToAgent: undefined,
      escalate: false,
      skipSummarization: false,
      stateDeltaKeys: [],
      artifactDeltaKeys: [],
      requestedAuthConfigIds: [],
      requestedToolConfirmationIds: [],
    },
    synthetic: true,
    kind: params.kind,
    scope: params.scope,
    metadata: params.metadata ?? {},
  }
}

function captureSyntheticTraceEvent(
  trace: Record<string, unknown>[],
  params: {
    scope: AdkSessionScope
    kind:
      | 'stage_start'
      | 'stage_end'
      | 'tool_start'
      | 'tool_end'
      | 'error'
      | 'retry'
    text: string
    metadata?: Record<string, unknown>
  },
): boolean {
  if (trace.length >= EVENT_TRACE_MAX_ENTRIES) return false
  trace.push(buildSyntheticTraceEvent(params))
  return true
}

function captureSyntheticTraceEventWithDrop(params: {
  trace: Record<string, unknown>[]
  droppedCounter: DroppedCounter
  scope: AdkSessionScope
  kind:
    | 'stage_start'
    | 'stage_end'
    | 'tool_start'
    | 'tool_end'
    | 'error'
    | 'retry'
  text: string
  metadata?: Record<string, unknown>
}): void {
  if (
    !captureSyntheticTraceEvent(params.trace, {
      scope: params.scope,
      kind: params.kind,
      text: params.text,
      metadata: params.metadata,
    })
  ) {
    params.droppedCounter.value += 1
  }
}

function captureRunnerEventWithLifecycle(params: {
  scope: AdkSessionScope
  trace: Record<string, unknown>[]
  droppedCounter: DroppedCounter
  event: Event
}): void {
  captureAdkEventTraceWithDrop({
    trace: params.trace,
    droppedCounter: params.droppedCounter,
    event: params.event,
  })

  const functionCalls = getFunctionCalls(params.event)
  for (const call of functionCalls) {
    const argsObject =
      call.args && typeof call.args === 'object'
        ? (call.args as Record<string, unknown>)
        : {}
    captureSyntheticTraceEventWithDrop({
      trace: params.trace,
      droppedCounter: params.droppedCounter,
      scope: params.scope,
      kind: 'tool_start',
      text: `Tool start: ${call.name}`,
      metadata: {
        toolName: call.name,
        argsKeys: Object.keys(argsObject).sort(),
      },
    })
  }

  const functionResponses = getFunctionResponses(params.event)
  for (const response of functionResponses) {
    const resultText = extractFunctionResponseResultText(response)
    captureSyntheticTraceEventWithDrop({
      trace: params.trace,
      droppedCounter: params.droppedCounter,
      scope: params.scope,
      kind: 'tool_end',
      text: `Tool end: ${response.name}`,
      metadata: {
        toolName: response.name,
        resultPreview: safePreview(resultText, 160),
      },
    })
  }
}

function persistArtifactPointerState(params: {
  runtime: AdkSessionRuntime
  pointerKey: string
  filename: string
  version: number
}): void {
  const stateKey = {
    namespace: getAdkSharedStateNamespace(),
    conversationKey: params.runtime.conversationKey,
  }
  const currentState = loadAdkPersistedState(stateKey)
  const existingPointers =
    currentState[ARTIFACT_STATE_KEY] &&
    typeof currentState[ARTIFACT_STATE_KEY] === 'object' &&
    !Array.isArray(currentState[ARTIFACT_STATE_KEY])
      ? (currentState[ARTIFACT_STATE_KEY] as Record<string, unknown>)
      : {}

  const updatedPointers = {
    ...existingPointers,
    [params.pointerKey]: {
      filename: params.filename,
      version: params.version,
      appName: params.runtime.appName,
      sessionId: params.runtime.sessionId,
      savedAt: Date.now(),
    },
  }

  saveAdkPersistedState(stateKey, {
    ...currentState,
    [ARTIFACT_STATE_KEY]: updatedPointers,
  })
}

async function persistAdkArtifact(params: {
  runner: Runner
  runtime: AdkSessionRuntime
  session: { id: string; userId: string }
  filename: string
  pointerKey: string
  payload: unknown
}): Promise<void> {
  try {
    const artifactService = params.runner.artifactService
    if (!artifactService) return

    const version = await artifactService.saveArtifact({
      appName: params.runtime.appName,
      userId: params.session.userId,
      sessionId: params.session.id,
      filename: params.filename,
      artifact: buildJsonArtifactPart(params.payload),
    })

    persistArtifactPointerState({
      runtime: params.runtime,
      pointerKey: params.pointerKey,
      filename: params.filename,
      version,
    })
  } catch (error) {
    debugLogger.warn('ADK_ARTIFACT_PERSIST_FAILED', {
      scope: params.runtime.scope,
      filename: params.filename,
      conversationKey: params.runtime.conversationKey,
      error: error instanceof Error ? error.message : String(error),
    })
  }
}

function maybeParseDialecticJson(text: string): DialecticResult | null {
  const trimmed = text.trim()
  if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) return null

  try {
    const parsed = JSON.parse(trimmed) as Partial<DialecticResult>
    if (!parsed || typeof parsed !== 'object') return null
    if (
      typeof parsed.summary !== 'string' ||
      typeof parsed.hypothesis !== 'string' ||
      typeof parsed.antithesis !== 'string' ||
      typeof parsed.synthesis !== 'string'
    ) {
      return null
    }

    return {
      summary: parsed.summary.trim(),
      hypothesis: parsed.hypothesis.trim(),
      antithesis: parsed.antithesis.trim(),
      synthesis: parsed.synthesis.trim(),
      confidence:
        parsed.confidence === 'low' ||
        parsed.confidence === 'medium' ||
        parsed.confidence === 'high'
          ? parsed.confidence
          : undefined,
    }
  } catch {
    return null
  }
}

function maybeParseBaconianJson(text: string): BaconianResult | null {
  const trimmed = text.trim()
  if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) return null

  try {
    const parsed = JSON.parse(trimmed) as Partial<BaconianResult>
    if (!parsed || typeof parsed !== 'object') return null

    const idols = parsed.idols as BaconianResult['idols'] | undefined
    const clearing = parsed.clearing as BaconianResult['clearing'] | undefined
    const truthTables = parsed.truth_tables as
      | BaconianResult['truth_tables']
      | undefined

    if (
      typeof parsed.summary !== 'string' ||
      !idols ||
      typeof idols.tribe !== 'string' ||
      typeof idols.cave !== 'string' ||
      typeof idols.market !== 'string' ||
      typeof idols.theater !== 'string' ||
      !clearing ||
      typeof clearing.tribe !== 'string' ||
      typeof clearing.cave !== 'string' ||
      typeof clearing.market !== 'string' ||
      typeof clearing.theater !== 'string' ||
      !truthTables ||
      typeof truthTables.presence !== 'string' ||
      typeof truthTables.absence !== 'string' ||
      typeof truthTables.degrees !== 'string' ||
      typeof parsed.forma_veritas !== 'string'
    ) {
      return null
    }

    return {
      summary: parsed.summary.trim(),
      idols: {
        tribe: idols.tribe.trim(),
        cave: idols.cave.trim(),
        market: idols.market.trim(),
        theater: idols.theater.trim(),
      },
      clearing: {
        tribe: clearing.tribe.trim(),
        cave: clearing.cave.trim(),
        market: clearing.market.trim(),
        theater: clearing.theater.trim(),
      },
      truth_tables: {
        presence: truthTables.presence.trim(),
        absence: truthTables.absence.trim(),
        degrees: truthTables.degrees.trim(),
      },
      forma_veritas: parsed.forma_veritas.trim(),
      confidence:
        parsed.confidence === 'low' ||
        parsed.confidence === 'medium' ||
        parsed.confidence === 'high'
          ? parsed.confidence
          : undefined,
    }
  } catch {
    return null
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function isStringList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(item => typeof item === 'string')
}

function isStringOrStringList(value: unknown): value is string | string[] {
  return typeof value === 'string' || isStringList(value)
}

function toRecordFromKeyValuePairs(
  value: unknown,
): Record<string, unknown> | null {
  if (!Array.isArray(value)) return null
  const out: Record<string, unknown> = {}
  for (const item of value) {
    if (!isRecord(item) || typeof item.key !== 'string') return null
    out[item.key] = item.value
  }
  return out
}

function toRecordFromAxisValuePairs(
  value: unknown,
): Record<string, unknown> | null {
  if (!Array.isArray(value)) return null
  const out: Record<string, unknown> = {}
  for (const item of value) {
    if (!isRecord(item) || typeof item.axis !== 'string') return null
    out[item.axis] = item.value
  }
  return out
}

function maybeParseFalsificationJson(text: string): FalsificationPlanResult | null {
  const trimmed = text.trim()
  if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) return null

  try {
    const parsed = JSON.parse(trimmed) as Partial<FalsificationPlanResult>
    if (!isRecord(parsed)) return null

    const falsificationPlan = parsed.falsification_plan
    const invariantsMatch = parsed.invariants_match
    if (!isRecord(falsificationPlan) || !isRecord(invariantsMatch)) {
      return null
    }

    const planMeta = falsificationPlan.meta
    const normalizedClaim = falsificationPlan.normalized_claim
    const tests = falsificationPlan.tests
    const testMatrix = falsificationPlan.test_matrix
    const dataRequests = falsificationPlan.data_requests

    if (!isRecord(planMeta) || !isRecord(normalizedClaim)) {
      return null
    }
    if (
      planMeta.plan_version !== 'falsification-plan-v1' ||
      (planMeta.status !== 'ready' && planMeta.status !== 'skipped')
    ) {
      return null
    }
    if (!Array.isArray(tests) || !isRecord(testMatrix) || !isStringList(dataRequests)) {
      return null
    }

    const normalizedClaimKeys = [
      'claim',
      'domain',
      'entities',
      'relation',
      'observables',
      'expected_direction',
      'conditions',
      'time_scope',
    ] as const

    for (const key of normalizedClaimKeys) {
      if (key === 'entities' || key === 'observables' || key === 'conditions') {
        if (!isStringOrStringList(normalizedClaim[key])) return null
        continue
      }
      if (typeof normalizedClaim[key] !== 'string') return null
    }

    const parsedTests: FalsificationPlanResult['falsification_plan']['tests'] = []
    for (const rawTest of tests) {
      if (!isRecord(rawTest)) return null
      const requiredTestStringKeys = [
        'id',
        'goal',
        'method',
        'minimal_data',
        'procedure',
        'what_would_falsify',
        'confounds',
      ] as const

      for (const key of requiredTestStringKeys) {
        if (typeof rawTest[key] !== 'string') return null
      }

      if (
        rawTest.falsifier_kind !== undefined &&
        rawTest.falsifier_kind !== 'mechanism' &&
        rawTest.falsifier_kind !== 'confound' &&
        rawTest.falsifier_kind !== 'boundary' &&
        rawTest.falsifier_kind !== 'invariance' &&
        rawTest.falsifier_kind !== 'intervention' &&
        rawTest.falsifier_kind !== 'measurement' &&
        rawTest.falsifier_kind !== 'alternative' &&
        rawTest.falsifier_kind !== 'robustness' &&
        rawTest.falsifier_kind !== 'counterexample'
      ) {
        return null
      }

      if (
        rawTest.phase !== undefined &&
        rawTest.phase !== 'toy' &&
        rawTest.phase !== 'field' &&
        rawTest.phase !== 'both'
      ) {
        return null
      }

      if (rawTest.priority !== undefined && typeof rawTest.priority !== 'number') {
        return null
      }

      parsedTests.push({
        id: rawTest.id,
        goal: rawTest.goal,
        method: rawTest.method,
        minimal_data: rawTest.minimal_data,
        procedure: rawTest.procedure,
        what_would_falsify: rawTest.what_would_falsify,
        confounds: rawTest.confounds,
        falsifier_kind: rawTest.falsifier_kind,
        phase: rawTest.phase,
        priority: rawTest.priority,
      })
    }

    const axesRaw = testMatrix.axes
    const variantsRaw = testMatrix.variants
    if (!Array.isArray(axesRaw) || !Array.isArray(variantsRaw)) return null
    if (variantsRaw.length > 5) return null

    const parsedAxes: FalsificationPlanResult['falsification_plan']['test_matrix']['axes'] =
      []
    for (const axis of axesRaw) {
      if (!isRecord(axis)) return null
      const parametersFromPairs = toRecordFromKeyValuePairs(axis.parameters)
      const normalizedParameters =
        typeof axis.parameters === 'string' ||
        isStringList(axis.parameters) ||
        isRecord(axis.parameters)
          ? (axis.parameters as string[] | Record<string, unknown> | string)
          : parametersFromPairs
      if (
        typeof axis.axis !== 'string' ||
        typeof axis.rationale !== 'string' ||
        !normalizedParameters
      ) {
        return null
      }
      parsedAxes.push({
        axis: axis.axis,
        rationale: axis.rationale,
        parameters: normalizedParameters,
      })
    }

    const parsedVariants: FalsificationPlanResult['falsification_plan']['test_matrix']['variants'] =
      []
    for (const variant of variantsRaw) {
      if (!isRecord(variant)) return null
      const axisValuesFromPairs = toRecordFromAxisValuePairs(variant.axis_values)
      const normalizedAxisValues = isRecord(variant.axis_values)
        ? variant.axis_values
        : axisValuesFromPairs
      if (
        typeof variant.id !== 'string' ||
        !normalizedAxisValues ||
        !isStringList(variant.applies_to_tests) ||
        typeof variant.rationale !== 'string'
      ) {
        return null
      }
      parsedVariants.push({
        id: variant.id,
        axis_values: normalizedAxisValues,
        applies_to_tests: variant.applies_to_tests,
        rationale: variant.rationale,
      })
    }

    const matchMeta = invariantsMatch.meta
    const matchesRaw = invariantsMatch.matches
    const overallRaw = invariantsMatch.overall
    if (!isRecord(matchMeta) || !Array.isArray(matchesRaw) || !isRecord(overallRaw)) {
      return null
    }
    if (
      matchMeta.match_version !== 'invariants-match-v1' ||
      (matchMeta.status !== 'ready' && matchMeta.status !== 'skipped') ||
      typeof matchMeta.reason !== 'string'
    ) {
      return null
    }
    if (matchMeta.catalog_sha256 !== undefined && typeof matchMeta.catalog_sha256 !== 'string') {
      return null
    }

    const parsedMatches: FalsificationPlanResult['invariants_match']['matches'] = []
    for (const match of matchesRaw) {
      if (!isRecord(match)) return null
      if (
        typeof match.invariant_name !== 'string' ||
        typeof match.gate_id !== 'string' ||
        (match.match_strength !== 'strong' &&
          match.match_strength !== 'moderate' &&
          match.match_strength !== 'weak') ||
        typeof match.why !== 'string' ||
        !isRecord(match.evidence_profile) ||
        !isStringList(match.dataset_hints) ||
        !isStringList(match.runner_implications)
      ) {
        return null
      }

      const profile = match.evidence_profile
      if (
        typeof profile.needs_gauge !== 'boolean' ||
        typeof profile.needs_nulls !== 'boolean' ||
        typeof profile.needs_bootstrap !== 'boolean' ||
        typeof profile.needs_intervention !== 'boolean'
      ) {
        return null
      }

      parsedMatches.push({
        invariant_name: match.invariant_name,
        gate_id: match.gate_id,
        match_strength: match.match_strength,
        why: match.why,
        evidence_profile: {
          needs_gauge: profile.needs_gauge,
          needs_nulls: profile.needs_nulls,
          needs_bootstrap: profile.needs_bootstrap,
          needs_intervention: profile.needs_intervention,
        },
        dataset_hints: match.dataset_hints,
        runner_implications: match.runner_implications,
      })
    }

    if (
      (overallRaw.match_strength !== 'none' &&
        overallRaw.match_strength !== 'weak' &&
        overallRaw.match_strength !== 'moderate' &&
        overallRaw.match_strength !== 'strong') ||
      typeof overallRaw.notes !== 'string' ||
      typeof overallRaw.next_action !== 'string'
    ) {
      return null
    }

    return {
      falsification_plan: {
        meta: {
          plan_version: 'falsification-plan-v1',
          status: planMeta.status,
          reason:
            typeof planMeta.reason === 'string' ? planMeta.reason : undefined,
        },
        normalized_claim: {
          claim: normalizedClaim.claim,
          domain: normalizedClaim.domain,
          entities: normalizedClaim.entities,
          relation: normalizedClaim.relation,
          observables: normalizedClaim.observables,
          expected_direction: normalizedClaim.expected_direction,
          conditions: normalizedClaim.conditions,
          time_scope: normalizedClaim.time_scope,
        },
        tests: parsedTests,
        test_matrix: {
          axes: parsedAxes,
          variants: parsedVariants,
        },
        data_requests: dataRequests,
      },
      invariants_match: {
        meta: {
          match_version: 'invariants-match-v1',
          status: matchMeta.status,
          reason: matchMeta.reason,
          catalog_sha256: matchMeta.catalog_sha256,
        },
        matches: parsedMatches,
        overall: {
          match_strength: overallRaw.match_strength,
          notes: overallRaw.notes,
          next_action: overallRaw.next_action,
        },
      },
    }
  } catch {
    return null
  }
}

function maybeParseExperimentRunnersJson(
  text: string,
): ExperimentRunnersResult | null {
  const trimmed = text.trim()
  if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) return null

  try {
    const parsed = JSON.parse(trimmed) as Partial<ExperimentRunnersResult>
    if (!isRecord(parsed)) return null

    const experimentRunners = parsed.experiment_runners
    if (!isRecord(experimentRunners)) return null

    const meta = experimentRunners.meta
    const assumptions = experimentRunners.assumptions
    const runners = experimentRunners.runners
    const executionOrder = experimentRunners.execution_order
    if (!isRecord(meta)) return null
    if (
      meta.plan_version !== 'experiment-runners-v1' ||
      (meta.status !== 'ready' && meta.status !== 'skipped')
    ) {
      return null
    }
    if (meta.reason !== undefined && typeof meta.reason !== 'string') return null
    if (typeof experimentRunners.hypothesis_snapshot !== 'string') return null
    if (!isStringList(assumptions)) return null
    if (!Array.isArray(runners)) return null
    if (!isStringList(executionOrder)) return null
    if (typeof experimentRunners.next_action !== 'string') return null

    const parsedRunners: ExperimentRunnersResult['experiment_runners']['runners'] = []
    for (const runner of runners) {
      if (!isRecord(runner)) return null
      if (
        typeof runner.id !== 'string' ||
        typeof runner.goal !== 'string' ||
        !isStringList(runner.test_ids) ||
        (runner.phase !== 'toy' &&
          runner.phase !== 'field' &&
          runner.phase !== 'both') ||
        (runner.language !== 'python' &&
          runner.language !== 'bash' &&
          runner.language !== 'pseudo') ||
        typeof runner.filename !== 'string' ||
        typeof runner.run_command !== 'string' ||
        !isStringList(runner.required_inputs) ||
        typeof runner.expected_signal !== 'string' ||
        typeof runner.failure_signal !== 'string' ||
        typeof runner.code !== 'string'
      ) {
        return null
      }

      parsedRunners.push({
        id: runner.id.trim(),
        goal: runner.goal.trim(),
        test_ids: runner.test_ids.map(testId => testId.trim()),
        phase: runner.phase,
        language: runner.language,
        filename: runner.filename.trim(),
        run_command: runner.run_command.trim(),
        required_inputs: runner.required_inputs.map(input => input.trim()),
        expected_signal: runner.expected_signal.trim(),
        failure_signal: runner.failure_signal.trim(),
        code: runner.code.trim(),
      })
    }

    return {
      experiment_runners: {
        meta: {
          plan_version: 'experiment-runners-v1',
          status: meta.status,
          reason: typeof meta.reason === 'string' ? meta.reason.trim() : undefined,
        },
        hypothesis_snapshot: experimentRunners.hypothesis_snapshot.trim(),
        assumptions: assumptions.map(item => item.trim()),
        runners: parsedRunners,
        execution_order: executionOrder.map(item => item.trim()),
        next_action: experimentRunners.next_action.trim(),
      },
    }
  } catch {
    return null
  }
}

function maybeParseNormalizationJson(
  text: string,
): HypothesisNormalizationResult | null {
  const trimmed = text.trim()
  if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) return null

  try {
    const parsed = JSON.parse(trimmed) as Partial<HypothesisNormalizationResult>
    if (!isRecord(parsed)) return null
    const meta = parsed.meta
    const normalization = parsed.hypothesis_normalization
    if (!isRecord(meta) || !isRecord(normalization)) return null

    if (
      meta.normalization_version !== 'normalization-v1' ||
      (meta.mode !== 'strict' && meta.mode !== 'autocorrect')
    ) {
      return null
    }

    const requiredStringKeys = [
      'claim',
      'domain',
      'relation',
      'expected_direction',
      'conditions',
      'time_scope',
      'notes',
    ] as const

    for (const key of requiredStringKeys) {
      if (typeof normalization[key] !== 'string') {
        return null
      }
    }

    if (
      !isStringList(normalization.entities) ||
      !isStringList(normalization.observables) ||
      !isStringList(normalization.missing_fields) ||
      !isStringList(normalization.clarification_questions) ||
      typeof normalization.clarification_required !== 'boolean'
    ) {
      return null
    }

    const clarificationPlan = normalization.clarification_plan
    if (clarificationPlan !== undefined && !isRecord(clarificationPlan)) {
      return null
    }

    if (isRecord(clarificationPlan)) {
      if (
        clarificationPlan.required_fields !== undefined &&
        !isStringList(clarificationPlan.required_fields)
      ) {
        return null
      }
      if (
        clarificationPlan.questions !== undefined &&
        !isStringList(clarificationPlan.questions)
      ) {
        return null
      }
      if (
        clarificationPlan.proxy_observables !== undefined &&
        !isStringList(clarificationPlan.proxy_observables)
      ) {
        return null
      }
      if (
        clarificationPlan.proxy_time_scope !== undefined &&
        typeof clarificationPlan.proxy_time_scope !== 'string'
      ) {
        return null
      }
      if (
        clarificationPlan.proxy_conditions !== undefined &&
        typeof clarificationPlan.proxy_conditions !== 'string'
      ) {
        return null
      }
      if (
        clarificationPlan.weakened_claim !== undefined &&
        typeof clarificationPlan.weakened_claim !== 'string'
      ) {
        return null
      }
      if (
        clarificationPlan.experiment_design_min !== undefined &&
        typeof clarificationPlan.experiment_design_min !== 'string'
      ) {
        return null
      }
    }

    return {
      meta: {
        normalization_version: 'normalization-v1',
        mode: meta.mode,
      },
      hypothesis_normalization: {
        claim: normalization.claim.trim(),
        domain: normalization.domain.trim(),
        entities: normalization.entities.map(item => item.trim()),
        relation: normalization.relation.trim(),
        observables: normalization.observables.map(item => item.trim()),
        expected_direction: normalization.expected_direction.trim(),
        conditions: normalization.conditions.trim(),
        time_scope: normalization.time_scope.trim(),
        notes: normalization.notes.trim(),
        missing_fields: normalization.missing_fields.map(item => item.trim()),
        clarification_required: normalization.clarification_required,
        clarification_questions: normalization.clarification_questions.map(item =>
          item.trim(),
        ),
        clarification_plan: isRecord(clarificationPlan)
          ? {
              required_fields: isStringList(clarificationPlan.required_fields)
                ? clarificationPlan.required_fields.map(item => item.trim())
                : undefined,
              questions: isStringList(clarificationPlan.questions)
                ? clarificationPlan.questions.map(item => item.trim())
                : undefined,
              proxy_observables: isStringList(
                clarificationPlan.proxy_observables,
              )
                ? clarificationPlan.proxy_observables.map(item => item.trim())
                : undefined,
              proxy_time_scope:
                typeof clarificationPlan.proxy_time_scope === 'string'
                  ? clarificationPlan.proxy_time_scope.trim()
                  : undefined,
              proxy_conditions:
                typeof clarificationPlan.proxy_conditions === 'string'
                  ? clarificationPlan.proxy_conditions.trim()
                  : undefined,
              weakened_claim:
                typeof clarificationPlan.weakened_claim === 'string'
                  ? clarificationPlan.weakened_claim.trim()
                  : undefined,
              experiment_design_min:
                typeof clarificationPlan.experiment_design_min === 'string'
                  ? clarificationPlan.experiment_design_min.trim()
                  : undefined,
            }
          : undefined,
      },
    }
  } catch {
    return null
  }
}

function stripCodeFenceEnvelope(text: string): string {
  const trimmed = text.trim()
  if (!trimmed.startsWith('```')) return trimmed

  const lines = trimmed.split('\n')
  if (lines.length < 2) return trimmed
  if (lines[lines.length - 1]?.trim() !== '```') return trimmed

  return lines.slice(1, -1).join('\n').trim()
}

function extractFirstJsonObject(text: string): string | null {
  const raw = text.trim()
  if (!raw) return null
  if (raw.startsWith('{') && raw.endsWith('}')) return raw

  const startIndex = raw.indexOf('{')
  if (startIndex < 0) return null

  let depth = 0
  let inString = false
  let escaped = false

  for (let index = startIndex; index < raw.length; index += 1) {
    const ch = raw[index]
    if (escaped) {
      escaped = false
      continue
    }
    if (inString) {
      if (ch === '\\\\') {
        escaped = true
      } else if (ch === '"') {
        inString = false
      }
      continue
    }

    if (ch === '"') {
      inString = true
      continue
    }
    if (ch === '{') {
      depth += 1
      continue
    }
    if (ch === '}') {
      depth -= 1
      if (depth === 0) {
        return raw.slice(startIndex, index + 1)
      }
    }
  }

  return null
}

function formatDialecticResult(result: DialecticResult): string {
  return [
    'Summary',
    result.summary || '(no summary)',
    '',
    'Hypothesis',
    result.hypothesis || '(no hypothesis)',
    '',
    'Antithesis',
    result.antithesis || '(no antithesis)',
    '',
    'Synthesis',
    result.synthesis || '(no synthesis)',
  ].join('\n')
}

function formatBaconianResult(result: BaconianResult): string {
  return [
    'Bacon (Idols)',
    `Tribe: ${result.idols.tribe || '(none)'}`,
    `Cave: ${result.idols.cave || '(none)'}`,
    `Market: ${result.idols.market || '(none)'}`,
    `Theater: ${result.idols.theater || '(none)'}`,
    '',
    'Clearing',
    `Tribe: ${result.clearing.tribe || '(none)'}`,
    `Cave: ${result.clearing.cave || '(none)'}`,
    `Market: ${result.clearing.market || '(none)'}`,
    `Theater: ${result.clearing.theater || '(none)'}`,
    '',
    'Truth Tables',
    `Presence: ${result.truth_tables.presence || '(none)'}`,
    `Absence: ${result.truth_tables.absence || '(none)'}`,
    `Degrees: ${result.truth_tables.degrees || '(none)'}`,
    '',
    'Forma Veritas',
    result.forma_veritas || '(none)',
  ].join('\n')
}

function formatFalsificationResult(result: FalsificationPlanResult): string {
  const plan = result.falsification_plan
  const invariants = result.invariants_match
  const testsPreview = plan.tests.slice(0, 3)
  const variantsPreview = plan.test_matrix.variants.slice(0, 3)
  const dataPreview = plan.data_requests.slice(0, 3)

  return [
    'Falsification Plan',
    `Status: ${plan.meta.status}`,
    `Version: ${plan.meta.plan_version}`,
    `Claim: ${plan.normalized_claim.claim || '(none)'}`,
    `Domain: ${plan.normalized_claim.domain || '(none)'}`,
    `Tests: ${plan.tests.length}`,
    `Variants: ${plan.test_matrix.variants.length}`,
    '',
    'Tests (preview)',
    ...testsPreview.map(test => `- ${test.id}: ${test.goal}`),
    ...(plan.tests.length > testsPreview.length
      ? [`- ... (${plan.tests.length - testsPreview.length} more)`]
      : []),
    '',
    'Variants (preview)',
    ...variantsPreview.map(variant => `- ${variant.id}: ${variant.rationale}`),
    ...(plan.test_matrix.variants.length > variantsPreview.length
      ? [
          `- ... (${plan.test_matrix.variants.length - variantsPreview.length} more)`,
        ]
      : []),
    '',
    'Data Requests (preview)',
    ...(dataPreview.length > 0
      ? dataPreview.map(entry => `- ${entry}`)
      : ['- (no data requests)']),
    ...(plan.data_requests.length > dataPreview.length
      ? [`- ... (${plan.data_requests.length - dataPreview.length} more)`]
      : []),
    '',
    'Invariants Match',
    `Status: ${invariants.meta.status}`,
    `Reason: ${invariants.meta.reason || '(none)'}`,
    `Matches: ${invariants.matches.length}`,
    `Overall strength: ${invariants.overall.match_strength}`,
    `Next action: ${invariants.overall.next_action}`,
  ].join('\n')
}

function formatExperimentRunnersResult(result: ExperimentRunnersResult): string {
  const plan = result.experiment_runners
  const runnersPreview = plan.runners.slice(0, 4)
  return [
    'Experiment Runners',
    `Status: ${plan.meta.status}`,
    `Version: ${plan.meta.plan_version}`,
    `Runners: ${plan.runners.length}`,
    `Execution order: ${plan.execution_order.join(', ') || '(none)'}`,
    `Next action: ${plan.next_action || '(none)'}`,
    '',
    'Runners (preview)',
    ...(runnersPreview.length > 0
      ? runnersPreview.map(
          runner =>
            `- ${runner.id} [${runner.language}] ${runner.filename} :: ${runner.goal}`,
        )
      : ['- (no runners)']),
    ...(plan.runners.length > runnersPreview.length
      ? [`- ... (${plan.runners.length - runnersPreview.length} more)`]
      : []),
    '',
    'Assumptions',
    ...(plan.assumptions.length > 0
      ? plan.assumptions.slice(0, 5).map(item => `- ${item}`)
      : ['- (no assumptions)']),
  ].join('\n')
}

function formatNormalizationResult(
  result: HypothesisNormalizationResult,
): string {
  const normalized = result.hypothesis_normalization
  return [
    'Hypothesis Normalization',
    `Modo: ${result.meta.mode}`,
    `Claim: ${normalized.claim || '(vacio)'}`,
    `Domain: ${normalized.domain || '(vacio)'}`,
    `Entities: ${normalized.entities.length}`,
    `Relation: ${normalized.relation || '(vacio)'}`,
    `Observables: ${normalized.observables.length}`,
    `Expected direction: ${normalized.expected_direction || '(vacio)'}`,
    `Conditions: ${normalized.conditions || '(vacio)'}`,
    `Time scope: ${normalized.time_scope || '(vacio)'}`,
    `Clarification required: ${normalized.clarification_required ? 'yes' : 'no'}`,
    `Missing fields: ${normalized.missing_fields.length > 0 ? normalized.missing_fields.join(', ') : '(none)'}`,
    normalized.notes ? `Notes: ${normalized.notes}` : '',
  ]
    .filter(Boolean)
    .join('\n')
}

function parseStrictDialecticOutput(rawText: string): DialecticResult | null {
  const unwrapped = stripCodeFenceEnvelope(rawText)
  const extracted = extractFirstJsonObject(unwrapped) ?? unwrapped
  return maybeParseDialecticJson(extracted)
}

function parseStrictBaconianOutput(rawText: string): BaconianResult | null {
  const unwrapped = stripCodeFenceEnvelope(rawText)
  const extracted = extractFirstJsonObject(unwrapped) ?? unwrapped
  return maybeParseBaconianJson(extracted)
}

function parseStrictFalsificationOutput(
  rawText: string,
): FalsificationPlanResult | null {
  const unwrapped = stripCodeFenceEnvelope(rawText)
  const extracted = extractFirstJsonObject(unwrapped) ?? unwrapped
  return maybeParseFalsificationJson(extracted)
}

function parseStrictExperimentRunnersOutput(
  rawText: string,
): ExperimentRunnersResult | null {
  const unwrapped = stripCodeFenceEnvelope(rawText)
  const extracted = extractFirstJsonObject(unwrapped) ?? unwrapped
  return maybeParseExperimentRunnersJson(extracted)
}

function parseStrictNormalizationOutput(
  rawText: string,
): HypothesisNormalizationResult | null {
  const unwrapped = stripCodeFenceEnvelope(rawText)
  const extracted = extractFirstJsonObject(unwrapped) ?? unwrapped
  return maybeParseNormalizationJson(extracted)
}

function parseStrictOrchestratorCompositeOutput(rawText: string): {
  dialectic: DialecticResult
  baconian: BaconianResult
} | null {
  const unwrapped = stripCodeFenceEnvelope(rawText)
  const extracted = extractFirstJsonObject(unwrapped) ?? unwrapped
  const trimmed = extracted.trim()
  if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) {
    return null
  }

  try {
    const parsed = JSON.parse(trimmed) as {
      dialectic?: unknown
      baconian?: unknown
    }
    if (!parsed || typeof parsed !== 'object') {
      return null
    }

    const dialecticRaw = JSON.stringify(parsed.dialectic ?? null)
    const baconianRaw = JSON.stringify(parsed.baconian ?? null)

    const dialectic = maybeParseDialecticJson(dialecticRaw)
    const baconian = maybeParseBaconianJson(baconianRaw)

    if (!dialectic || !baconian) {
      return null
    }

    return { dialectic, baconian }
  } catch {
    return null
  }
}

function extractFunctionResponseResultText(functionResponse: unknown): string {
  if (!functionResponse || typeof functionResponse !== 'object') {
    return ''
  }

  const payload = (functionResponse as any).response
  if (typeof payload === 'string') {
    return payload.trim()
  }
  if (!payload || typeof payload !== 'object') {
    return ''
  }

  const rawResult = (payload as any).result ?? (payload as any).output
  if (typeof rawResult === 'string') {
    return rawResult.trim()
  }
  if (!rawResult || typeof rawResult !== 'object') {
    return ''
  }

  try {
    return JSON.stringify(rawResult)
  } catch {
    return ''
  }
}

function extractBestEventText(event: Event): string {
  const direct = stringifyContent(event).trim()
  if (direct.length > 0) {
    return direct
  }

  const functionResponses = getFunctionResponses(event)
  for (let index = functionResponses.length - 1; index >= 0; index -= 1) {
    const candidate = extractFunctionResponseResultText(functionResponses[index])
    if (candidate.length > 0) {
      return candidate
    }
  }

  const content = (event as any)?.content
  if (typeof content === 'string') {
    const trimmed = content.trim()
    if (trimmed.length > 0) return trimmed
  }
  if (!content || typeof content !== 'object') {
    return ''
  }

  const parts = Array.isArray((content as any).parts)
    ? ((content as any).parts as unknown[])
    : []
  for (let index = parts.length - 1; index >= 0; index -= 1) {
    const part = parts[index]
    if (!part || typeof part !== 'object') continue

    const partText =
      typeof (part as any).text === 'string' ? (part as any).text.trim() : ''
    if (partText.length > 0) return partText

    const fnResponseText = extractFunctionResponseResultText(
      (part as any).functionResponse,
    )
    if (fnResponseText.length > 0) return fnResponseText

    const inlineData = (part as any).inlineData
    const encoded =
      inlineData &&
      typeof inlineData === 'object' &&
      typeof inlineData.data === 'string'
        ? inlineData.data
        : ''
    if (encoded.length > 0) {
      try {
        const decoded = Buffer.from(encoded, 'base64').toString('utf8').trim()
        if (decoded.length > 0) return decoded
      } catch {
        // no-op
      }
    }
  }

  try {
    const serialized = JSON.stringify(content)
    if (
      serialized &&
      serialized !== '{}' &&
      serialized !== '[]' &&
      serialized !== 'null'
    ) {
      return serialized
    }
  } catch {
    // no-op
  }

  return ''
}

function formatEventDiagnostics(event?: Event): string {
  if (!event) return ''

  const diagnostics: Record<string, unknown> = {}

  if (typeof event.finishReason === 'string') {
    diagnostics.finishReason = event.finishReason
  }
  if (event.interrupted === true) {
    diagnostics.interrupted = true
  }

  const errorCode =
    typeof event.errorCode === 'string' ? event.errorCode.trim() : ''
  if (errorCode) diagnostics.errorCode = errorCode

  const errorMessage =
    typeof event.errorMessage === 'string' ? event.errorMessage.trim() : ''
  if (errorMessage) diagnostics.errorMessage = errorMessage.slice(0, 600)

  const content = (event as any).content
  if (content && typeof content === 'object' && !Array.isArray(content)) {
    if (typeof (content as any).role === 'string') {
      diagnostics.contentRole = (content as any).role
    }

    const parts = Array.isArray((content as any).parts)
      ? ((content as any).parts as unknown[])
      : []
    if (parts.length > 0) {
      diagnostics.partTypes = parts.slice(0, 8).map(part => {
        if (!part || typeof part !== 'object') return 'unknown'
        if (typeof (part as any).text === 'string') return 'text'
        if ((part as any).functionCall) return 'functionCall'
        if ((part as any).functionResponse) return 'functionResponse'
        if ((part as any).inlineData) return 'inlineData'
        if ((part as any).fileData) return 'fileData'
        return 'unknown'
      })
      diagnostics.partCount = parts.length
    }
  }

  if (Object.keys(diagnostics).length === 0) return ''
  return ` Diagnostics=${JSON.stringify(diagnostics)}`
}

function maybeThrowOnLlmResponseError(event: Event): void {
  if (event.interrupted === true) {
    throw new Error('LLM generation was interrupted.')
  }

  const errorMessage =
    typeof event.errorMessage === 'string' ? event.errorMessage.trim() : ''
  const errorCode =
    typeof event.errorCode === 'string' ? event.errorCode.trim() : ''
  if (errorMessage || errorCode) {
    const prefix = errorCode ? `LLM error (${errorCode})` : 'LLM error'
    throw new Error(`${prefix}: ${errorMessage || 'Unknown error'}`)
  }

  // Some Gemini error / safety cases yield a final response with no content.
  if (event.finishReason === 'SAFETY') {
    const text = stringifyContent(event).trim()
    if (!text) {
      throw new Error('LLM output was blocked by safety filters.')
    }
  }
}

function buildBaconianInputFromDialectic(params: {
  hypothesisPrompt: string
  dialectic: DialecticResult
}): string {
  return [
    'User hypothesis/request:',
    params.hypothesisPrompt.trim(),
    '',
    'Dialectical output (JSON):',
    JSON.stringify(params.dialectic),
  ].join('\n')
}

function buildFalsificationInputFromContext(
  params: RunFalsificationSubagentParams,
): string {
  return [
    `Current hypothesis: ${params.hypothesisInput.trim()}`,
    `Cleaned hypothesis: ${params.hypothesisCleaned?.trim() || ''}`,
    `Veritas Form JSON: ${params.veritasFormRaw?.trim() || ''}`,
    `Normalization JSON: ${params.normalizationRaw?.trim() || ''}`,
    `Literature search JSON: ${params.literatureSearchRaw?.trim() || ''}`,
    `Literature extract JSON: ${params.literatureExtractRaw?.trim() || ''}`,
    `Canon invariants catalog (Markdown): ${params.invariantsCatalogMd?.trim() || ''}`,
    `Catalog sha256: ${params.catalogSha256?.trim() || ''}`,
    `Normalization ok: ${params.normalizationOk === true ? 'true' : 'false'}`,
    `Missing fields: ${JSON.stringify(params.missingFields ?? [])}`,
  ].join('\n')
}

function buildExperimentRunnersInputFromContext(
  params: RunExperimentRunnersSubagentParams,
): string {
  return [
    `Current hypothesis: ${params.hypothesisInput.trim()}`,
    `Dialectical synthesis: ${params.dialecticalSynthesis?.trim() || ''}`,
    `Baconian forma veritas: ${params.baconianFormaVeritas?.trim() || ''}`,
    `Normalization JSON: ${params.normalizationRaw?.trim() || ''}`,
    `Falsification plan JSON: ${params.falsificationRaw?.trim() || ''}`,
    `Literature summary: ${params.literatureSummary?.trim() || ''}`,
  ].join('\n')
}

function buildNormalizationInputFromContext(
  params: RunNormalizationSubagentParams,
): string {
  const mode = params.mode === 'autocorrect' ? 'autocorrect' : 'strict'
  return [
    `Mode: ${mode}`,
    `Hypothesis input: ${params.hypothesisInput.trim()}`,
    `Dialectical synthesis: ${params.dialecticalSynthesis?.trim() || ''}`,
    `Baconian forma veritas: ${params.baconianFormaVeritas?.trim() || ''}`,
    `Literature summary: ${params.literatureSummary?.trim() || ''}`,
    `Previous normalization draft JSON: ${params.previousNormalizationRaw?.trim() || ''}`,
  ].join('\n')
}

function formatCombinedDialecticBaconianResult(params: {
  dialectic: DialecticResult
  baconian: BaconianResult
}): string {
  return [
    formatDialecticResult(params.dialectic),
    '',
    formatBaconianResult(params.baconian),
  ].join('\n')
}

function formatArtifactsSavedAtLine(params: {
  runtime: AdkSessionRuntime
  session: { id: string; userId: string }
}): string {
  const absolutePath = ADK_LOCAL_ARTIFACT_SERVICE.getSessionDirectory({
    appName: params.runtime.appName,
    userId: params.session.userId,
    sessionId: params.session.id,
  })
  const homeDir = homedir()
  const displayPath = absolutePath.startsWith(homeDir)
    ? `~${absolutePath.slice(homeDir.length)}`
    : absolutePath
  return `Artifacts saved at: ${displayPath}`
}

function withArtifactsLocationFooter(
  text: string,
  params: { runtime: AdkSessionRuntime; session: { id: string; userId: string } },
): string {
  const footer = formatArtifactsSavedAtLine(params)
  const trimmed = text.trim()
  if (!trimmed) return footer
  return `${trimmed}\n\n${footer}`
}

async function runSingleOrchestratorPass(
  params: QueryAdkOrchestratorParams & AttemptMetadata,
): Promise<SingleRunResult> {
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

  const baconianAgent = new LlmAgent({
    name: BACONIAN_SUBAGENT_NAME,
    model: baseModel,
    description:
      "Builds Bacon's idols, clears them, derives truth tables and returns forma veritas from dialectical output.",
    instruction: BACONIAN_SUBAGENT_INSTRUCTION,
  })

  const useSequentialWorkflow = shouldUseSequentialOrchestratorWorkflow()
  const orchestratorAgent = useSequentialWorkflow
    ? new SequentialAgent({
        name: 'AmawtaOrchestratorPipeline',
        description:
          'Deterministic workflow: runs dialectical then baconian specialists in order.',
        subAgents: [dialecticalAgent, baconianAgent],
      })
    : new LlmAgent({
        name: 'AmawtaOrchestrator',
        model: baseModel,
        description:
          'Routes hypothesis-oriented requests to dialectical then baconian specialists and returns final structured output.',
        instruction: buildAdkOrchestratorInstruction(),
        tools: [
          new AgentTool({ agent: dialecticalAgent }),
          new AgentTool({ agent: baconianAgent }),
        ],
      })

  const runtime = buildAdkSessionRuntime(
    'orchestrator',
    params.conversationKey,
    { attemptIndex: params.attemptIndex },
  )

  const runner = createAdkRunner({
    appName: runtime.appName,
    agent: orchestratorAgent,
  })

  const session = await runner.sessionService.createSession({
    appName: runtime.appName,
    userId: runtime.userId,
    sessionId: runtime.sessionId,
    state: runtime.initialState,
  })

  const userText = buildOrchestratorInput(
    params.userPrompt,
    params.conversationContext,
  )

  const newMessage = {
    role: 'user',
    parts: [{ text: userText }],
  } as any

  let finalText = ''
  let lastRunnerEvent: Event | undefined
  let routedToDialectic = false
  let routedToBaconian = false
  let dialecticalToolResultText = ''
  let baconianToolResultText = ''
  const eventTrace: Record<string, unknown>[] = []
  const droppedEventTraceCount: DroppedCounter = { value: 0 }
  const budget = createExecutionBudget(runtime.scope)
  const attemptIndex = Math.max(0, params.attemptIndex ?? 0)
  const totalAttempts = Math.max(1, (params.maxRetries ?? 0) + 1)
  let stageStatus: 'success' | 'error' = 'success'
  let stageErrorMessage: string | undefined

  captureSyntheticTraceEventWithDrop({
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
      deterministicMode: isAdkDeterministicModeEnabled(),
      longRunMode: isAdkLongRunModeEnabled(),
      isolatedRetrySession: runtime.isolatedRetrySession === true,
    },
  })
  if (attemptIndex > 0) {
    captureSyntheticTraceEventWithDrop({
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
    await consumeRunnerEvents({
      runner,
      session,
      newMessage,
      signal: params.signal,
      budget,
      onEvent: event => {
        lastRunnerEvent = event
        captureRunnerEventWithLifecycle({
          scope: runtime.scope,
          trace: eventTrace,
          droppedCounter: droppedEventTraceCount,
          event,
        })
        maybeThrowOnLlmResponseError(event)

        const author = (event.author || '').trim()
        const eventText = extractBestEventText(event)
        if (author === DIALECTICAL_SUBAGENT_NAME && eventText.length > 0) {
          routedToDialectic = true
          dialecticalToolResultText = eventText
        }
        if (author === BACONIAN_SUBAGENT_NAME && eventText.length > 0) {
          routedToBaconian = true
          baconianToolResultText = eventText
        }

        const fnCalls = getFunctionCalls(event)
        if (fnCalls.some(call => call.name === DIALECTICAL_SUBAGENT_NAME)) {
          routedToDialectic = true
        }
        if (fnCalls.some(call => call.name === BACONIAN_SUBAGENT_NAME)) {
          routedToBaconian = true
        }

        const fnResponses = getFunctionResponses(event)
        for (const response of fnResponses) {
          if (response.name !== DIALECTICAL_SUBAGENT_NAME) {
            if (response.name !== BACONIAN_SUBAGENT_NAME) {
              continue
            }
            routedToBaconian = true
            const baconianCandidate = extractFunctionResponseResultText(response)
            if (baconianCandidate.length > 0) {
              baconianToolResultText = baconianCandidate
            }
            continue
          }
          routedToDialectic = true
          const candidate = extractFunctionResponseResultText(response)
          if (candidate.length > 0) {
            dialecticalToolResultText = candidate
          }
        }

        if (eventText.length > 0) {
          finalText = eventText
        }
      },
    })
  } catch (error) {
    stageStatus = 'error'
    stageErrorMessage = error instanceof Error ? error.message : String(error)
    captureSyntheticTraceEventWithDrop({
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
    captureSyntheticTraceEventWithDrop({
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
      await persistAdkSessionRuntimeState({
        runner,
        session,
        runtime,
      })
    } else {
      debugLogger.warn('ADK_STATE_PERSIST_SKIPPED_ON_STAGE_ERROR', {
        scope: runtime.scope,
        conversationKey: runtime.conversationKey,
        attemptIndex,
      })
    }

    await persistAdkArtifact({
      runner,
      runtime,
      session,
      filename: 'orchestrator-events.json',
      pointerKey: 'orchestrator_events',
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

  const trimmedFinalText = finalText.trim()
  const trimmedToolResult = dialecticalToolResultText.trim()
  const trimmedBaconianToolResult = baconianToolResultText.trim()
  if (!trimmedFinalText && !trimmedToolResult && !trimmedBaconianToolResult) {
    captureSyntheticTraceEventWithDrop({
      trace: eventTrace,
      droppedCounter: droppedEventTraceCount,
      scope: runtime.scope,
      kind: 'error',
      text: 'ADK orchestrator returned empty output.',
      metadata: { reason: 'empty_output' },
    })
    await persistAdkArtifact({
      runner,
      runtime,
      session,
      filename: 'orchestrator-events.json',
      pointerKey: 'orchestrator_events',
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
      `ADK orchestrator returned empty output.${formatEventDiagnostics(lastRunnerEvent)}`,
    )
  }

  if (routedToDialectic) {
    const compositeFromFinal = parseStrictOrchestratorCompositeOutput(trimmedFinalText)
    const dialectic =
      compositeFromFinal?.dialectic ??
      parseStrictDialecticOutput(trimmedToolResult)
    const baconian =
      compositeFromFinal?.baconian ??
      parseStrictBaconianOutput(trimmedBaconianToolResult)

    if (!dialectic || !baconian || !routedToBaconian) {
      captureSyntheticTraceEventWithDrop({
        trace: eventTrace,
        droppedCounter: droppedEventTraceCount,
        scope: runtime.scope,
        kind: 'error',
        text: 'ADK orchestrator contract violation: expected dialectical + baconian strict JSON output.',
        metadata: { reason: 'contract_violation' },
      })
      await persistAdkArtifact({
        runner,
        runtime,
        session,
        filename: 'orchestrator-events.json',
        pointerKey: 'orchestrator_events',
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
        'ADK orchestrator contract violation: expected dialectical + baconian strict JSON output.',
      )
    }

    debugLogger.api('ADK_ORCH_ROUTED_DIALECTIC_BACONIAN', {
      model: params.modelName,
      outputLength:
        trimmedFinalText.length ||
        trimmedToolResult.length + trimmedBaconianToolResult.length,
      source:
        compositeFromFinal !== null
          ? 'orchestrator_text'
          : useSequentialWorkflow
            ? 'sequential_subagents'
          : 'tool_response_fallback',
    })

    await persistAdkArtifact({
      runner,
      runtime,
      session,
      filename: 'orchestrator-result.json',
      pointerKey: 'orchestrator_result',
      payload: {
        route: 'dialectic',
        conversationKey: runtime.conversationKey,
        userPrompt: params.userPrompt,
        output: {
          dialectic,
          baconian,
        },
      },
    })

    return {
      route: 'dialectic',
      text: withArtifactsLocationFooter(
        formatCombinedDialecticBaconianResult({ dialectic, baconian }),
        { runtime, session },
      ),
      dialectic,
      baconian,
    }
  }

  if (trimmedFinalText === ADK_ORCHESTRATOR_NO_DIALECTIC_TOKEN) {
    await persistAdkArtifact({
      runner,
      runtime,
      session,
      filename: 'orchestrator-result.json',
      pointerKey: 'orchestrator_result',
      payload: {
        route: 'default',
        conversationKey: runtime.conversationKey,
        userPrompt: params.userPrompt,
        output: ADK_ORCHESTRATOR_NO_DIALECTIC_TOKEN,
      },
    })

    return { route: 'default', text: '' }
  }

  captureSyntheticTraceEventWithDrop({
    trace: eventTrace,
    droppedCounter: droppedEventTraceCount,
    scope: runtime.scope,
    kind: 'error',
    text: 'ADK orchestrator contract violation: expected dialectical delegation or explicit no-dialectic token.',
    metadata: { reason: 'contract_violation' },
  })
  await persistAdkArtifact({
    runner,
    runtime,
    session,
    filename: 'orchestrator-events.json',
    pointerKey: 'orchestrator_events',
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
    'ADK orchestrator contract violation: expected dialectical delegation or explicit no-dialectic token.',
  )
}

async function runSingleNormalizationPass(
  params: RunNormalizationSubagentParams & AttemptMetadata,
): Promise<SingleNormalizationRunResult> {
  const baseModel = new Gemini({
    model: params.modelName,
    apiKey: params.apiKey?.trim() || undefined,
  })

  const normalizationAgent = new LlmAgent({
    name: NORMALIZATION_SUBAGENT_NAME,
    model: baseModel,
    description:
      'Normalizes hypotheses into structured claim schema and reports missing fields for clarification.',
    instruction: NORMALIZATION_SUBAGENT_INSTRUCTION,
  })

  const runtime = buildAdkSessionRuntime(
    'normalization',
    params.conversationKey,
    { attemptIndex: params.attemptIndex },
  )

  const runner = createAdkRunner({
    appName: runtime.appName,
    agent: normalizationAgent,
  })

  const session = await runner.sessionService.createSession({
    appName: runtime.appName,
    userId: runtime.userId,
    sessionId: runtime.sessionId,
    state: runtime.initialState,
  })

  const newMessage = {
    role: 'user',
    parts: [{ text: buildNormalizationInputFromContext(params) }],
  } as any

  let finalText = ''
  let lastRunnerEvent: Event | undefined
  const eventTrace: Record<string, unknown>[] = []
  const droppedEventTraceCount: DroppedCounter = { value: 0 }
  const budget = createExecutionBudget(runtime.scope)
  const attemptIndex = Math.max(0, params.attemptIndex ?? 0)
  const totalAttempts = Math.max(1, (params.maxRetries ?? 0) + 1)
  let stageStatus: 'success' | 'error' = 'success'
  let stageErrorMessage: string | undefined

  captureSyntheticTraceEventWithDrop({
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
      deterministicMode: isAdkDeterministicModeEnabled(),
      longRunMode: isAdkLongRunModeEnabled(),
      isolatedRetrySession: runtime.isolatedRetrySession === true,
    },
  })
  if (attemptIndex > 0) {
    captureSyntheticTraceEventWithDrop({
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
    await consumeRunnerEvents({
      runner,
      session,
      newMessage,
      signal: params.signal,
      budget,
      onEvent: event => {
        lastRunnerEvent = event
        captureRunnerEventWithLifecycle({
          scope: runtime.scope,
          trace: eventTrace,
          droppedCounter: droppedEventTraceCount,
          event,
        })
        maybeThrowOnLlmResponseError(event)
        const text = extractBestEventText(event)
        if (text.length > 0) {
          finalText = text
        }
      },
    })
  } catch (error) {
    stageStatus = 'error'
    stageErrorMessage = error instanceof Error ? error.message : String(error)
    captureSyntheticTraceEventWithDrop({
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
    captureSyntheticTraceEventWithDrop({
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
      await persistAdkSessionRuntimeState({
        runner,
        session,
        runtime,
      })
    } else {
      debugLogger.warn('ADK_STATE_PERSIST_SKIPPED_ON_STAGE_ERROR', {
        scope: runtime.scope,
        conversationKey: runtime.conversationKey,
        attemptIndex,
      })
    }

    await persistAdkArtifact({
      runner,
      runtime,
      session,
      filename: 'normalization-events.json',
      pointerKey: 'normalization_events',
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
    captureSyntheticTraceEventWithDrop({
      trace: eventTrace,
      droppedCounter: droppedEventTraceCount,
      scope: runtime.scope,
      kind: 'error',
      text: 'Normalization subagent returned empty output.',
      metadata: { reason: 'empty_output' },
    })
    await persistAdkArtifact({
      runner,
      runtime,
      session,
      filename: 'normalization-events.json',
      pointerKey: 'normalization_events',
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
      `Normalization subagent returned empty output.${formatEventDiagnostics(lastRunnerEvent)}`,
    )
  }

  const parsed = parseStrictNormalizationOutput(trimmed)
  if (!parsed) {
    captureSyntheticTraceEventWithDrop({
      trace: eventTrace,
      droppedCounter: droppedEventTraceCount,
      scope: runtime.scope,
      kind: 'error',
      text: 'Normalization subagent contract violation: expected strict normalization JSON output.',
      metadata: { reason: 'contract_violation' },
    })
    await persistAdkArtifact({
      runner,
      runtime,
      session,
      filename: 'normalization-events.json',
      pointerKey: 'normalization_events',
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
      'Normalization subagent contract violation: expected strict normalization JSON output.',
    )
  }

  await persistAdkArtifact({
    runner,
    runtime,
    session,
    filename: 'normalization-result.json',
    pointerKey: 'normalization_result',
    payload: {
      input: {
        hypothesisInput: params.hypothesisInput,
        dialecticalSynthesis: params.dialecticalSynthesis,
        baconianFormaVeritas: params.baconianFormaVeritas,
        literatureSummary: params.literatureSummary,
        previousNormalizationRaw: params.previousNormalizationRaw,
        mode: params.mode ?? 'strict',
      },
      output: parsed,
    },
  })

  return {
    text: withArtifactsLocationFooter(formatNormalizationResult(parsed), {
      runtime,
      session,
    }),
    normalization: parsed,
  }
}

async function runSingleFalsificationPass(
  params: RunFalsificationSubagentParams & AttemptMetadata,
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
  })

  const runtime = buildAdkSessionRuntime(
    'falsification',
    params.conversationKey,
    { attemptIndex: params.attemptIndex },
  )

  const runner = createAdkRunner({
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
    parts: [{ text: buildFalsificationInputFromContext(params) }],
  } as any

  let finalText = ''
  let lastRunnerEvent: Event | undefined
  const eventTrace: Record<string, unknown>[] = []
  const droppedEventTraceCount: DroppedCounter = { value: 0 }
  const budget = createExecutionBudget(runtime.scope)
  const attemptIndex = Math.max(0, params.attemptIndex ?? 0)
  const totalAttempts = Math.max(1, (params.maxRetries ?? 0) + 1)
  let stageStatus: 'success' | 'error' = 'success'
  let stageErrorMessage: string | undefined

  captureSyntheticTraceEventWithDrop({
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
      deterministicMode: isAdkDeterministicModeEnabled(),
      longRunMode: isAdkLongRunModeEnabled(),
      isolatedRetrySession: runtime.isolatedRetrySession === true,
    },
  })
  if (attemptIndex > 0) {
    captureSyntheticTraceEventWithDrop({
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
    await consumeRunnerEvents({
      runner,
      session,
      newMessage,
      signal: params.signal,
      budget,
      onEvent: event => {
        lastRunnerEvent = event
        captureRunnerEventWithLifecycle({
          scope: runtime.scope,
          trace: eventTrace,
          droppedCounter: droppedEventTraceCount,
          event,
        })
        maybeThrowOnLlmResponseError(event)
        const text = extractBestEventText(event)
        if (text.length > 0) {
          finalText = text
        }
      },
    })
  } catch (error) {
    stageStatus = 'error'
    stageErrorMessage = error instanceof Error ? error.message : String(error)
    captureSyntheticTraceEventWithDrop({
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
    captureSyntheticTraceEventWithDrop({
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
      await persistAdkSessionRuntimeState({
        runner,
        session,
        runtime,
      })
    } else {
      debugLogger.warn('ADK_STATE_PERSIST_SKIPPED_ON_STAGE_ERROR', {
        scope: runtime.scope,
        conversationKey: runtime.conversationKey,
        attemptIndex,
      })
    }

    await persistAdkArtifact({
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

  const trimmed = finalText.trim()
  if (!trimmed) {
    captureSyntheticTraceEventWithDrop({
      trace: eventTrace,
      droppedCounter: droppedEventTraceCount,
      scope: runtime.scope,
      kind: 'error',
      text: 'Falsification subagent returned empty output.',
      metadata: { reason: 'empty_output' },
    })
    await persistAdkArtifact({
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
      `Falsification subagent returned empty output.${formatEventDiagnostics(lastRunnerEvent)}`,
    )
  }

  const parsed = parseStrictFalsificationOutput(trimmed)
  if (!parsed) {
    captureSyntheticTraceEventWithDrop({
      trace: eventTrace,
      droppedCounter: droppedEventTraceCount,
      scope: runtime.scope,
      kind: 'error',
      text: 'Falsification subagent contract violation: expected strict falsification JSON output.',
      metadata: { reason: 'contract_violation' },
    })
    await persistAdkArtifact({
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
    await persistAdkArtifact({
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

  await persistAdkArtifact({
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
    text: withArtifactsLocationFooter(formatFalsificationResult(parsed), {
      runtime,
      session,
    }),
    falsification: parsed,
  }
}

async function runSingleExperimentRunnersPass(
  params: RunExperimentRunnersSubagentParams & AttemptMetadata,
): Promise<SingleExperimentRunnersRunResult> {
  const baseModel = new Gemini({
    model: params.modelName,
    apiKey: params.apiKey?.trim() || undefined,
  })

  const runnersAgent = new LlmAgent({
    name: EXPERIMENT_RUNNERS_SUBAGENT_NAME,
    model: baseModel,
    description:
      'Builds basic executable experiment runners from normalization + falsification context.',
    instruction: EXPERIMENT_RUNNERS_SUBAGENT_INSTRUCTION,
  })

  const runtime = buildAdkSessionRuntime(
    'runners',
    params.conversationKey,
    { attemptIndex: params.attemptIndex },
  )

  const runner = createAdkRunner({
    appName: runtime.appName,
    agent: runnersAgent,
  })

  const session = await runner.sessionService.createSession({
    appName: runtime.appName,
    userId: runtime.userId,
    sessionId: runtime.sessionId,
    state: runtime.initialState,
  })

  const newMessage = {
    role: 'user',
    parts: [{ text: buildExperimentRunnersInputFromContext(params) }],
  } as any

  let finalText = ''
  let lastRunnerEvent: Event | undefined
  const eventTrace: Record<string, unknown>[] = []
  const droppedEventTraceCount: DroppedCounter = { value: 0 }
  const budget = createExecutionBudget(runtime.scope)
  const attemptIndex = Math.max(0, params.attemptIndex ?? 0)
  const totalAttempts = Math.max(1, (params.maxRetries ?? 0) + 1)
  let stageStatus: 'success' | 'error' = 'success'
  let stageErrorMessage: string | undefined

  captureSyntheticTraceEventWithDrop({
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
      deterministicMode: isAdkDeterministicModeEnabled(),
      longRunMode: isAdkLongRunModeEnabled(),
      isolatedRetrySession: runtime.isolatedRetrySession === true,
    },
  })
  if (attemptIndex > 0) {
    captureSyntheticTraceEventWithDrop({
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
    await consumeRunnerEvents({
      runner,
      session,
      newMessage,
      signal: params.signal,
      budget,
      onEvent: event => {
        lastRunnerEvent = event
        captureRunnerEventWithLifecycle({
          scope: runtime.scope,
          trace: eventTrace,
          droppedCounter: droppedEventTraceCount,
          event,
        })

        maybeThrowOnLlmResponseError(event)
        const text = extractBestEventText(event)
        if (text.length > 0) {
          finalText = text
        }
      },
    })
  } catch (error) {
    stageStatus = 'error'
    stageErrorMessage = error instanceof Error ? error.message : String(error)
    captureSyntheticTraceEventWithDrop({
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
    captureSyntheticTraceEventWithDrop({
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
      await persistAdkSessionRuntimeState({
        runner,
        session,
        runtime,
      })
    } else {
      debugLogger.warn('ADK_STATE_PERSIST_SKIPPED_ON_STAGE_ERROR', {
        scope: runtime.scope,
        conversationKey: runtime.conversationKey,
        attemptIndex,
      })
    }

    await persistAdkArtifact({
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

  const trimmed = finalText.trim()
  if (!trimmed) {
    captureSyntheticTraceEventWithDrop({
      trace: eventTrace,
      droppedCounter: droppedEventTraceCount,
      scope: runtime.scope,
      kind: 'error',
      text: 'Experiment runners subagent returned empty output.',
      metadata: { reason: 'empty_output' },
    })
    await persistAdkArtifact({
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
      `Experiment runners subagent returned empty output.${formatEventDiagnostics(lastRunnerEvent)}`,
    )
  }

  const parsed = parseStrictExperimentRunnersOutput(trimmed)
  if (!parsed) {
    captureSyntheticTraceEventWithDrop({
      trace: eventTrace,
      droppedCounter: droppedEventTraceCount,
      scope: runtime.scope,
      kind: 'error',
      text: 'Experiment runners subagent contract violation: expected strict experiment runners JSON output.',
      metadata: { reason: 'contract_violation' },
    })
    await persistAdkArtifact({
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
    await persistAdkArtifact({
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

  await persistAdkArtifact({
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
    text: withArtifactsLocationFooter(formatExperimentRunnersResult(parsed), {
      runtime,
      session,
    }),
    runners: parsed,
  }
}

export async function queryAdkDialecticalOrchestrator(
  params: QueryAdkOrchestratorParams,
): Promise<AdkOrchestratorResult> {
  const scope: AdkSessionScope = 'orchestrator'
  const maxRetries = Number.isFinite(params.maxRetries as number)
    ? Math.max(0, Math.floor(params.maxRetries as number))
    : 2
  const globalTimeoutMs = getScopeGlobalTimeoutMs(scope)
  const attemptTimeoutMs = getScopeAttemptTimeoutMs(scope)
  const globalControl = createScopedAbortControl({
    parentSignal: params.signal,
    timeoutMs: globalTimeoutMs,
    timeoutErrorMessage: `ADK ${scope} global timeout exceeded (${globalTimeoutMs}ms)`,
  })
  const effectiveSignal = globalControl.signal

  debugLogger.api('ADK_ORCH_START', {
    model: params.modelName,
    maxRetries,
    promptLength: params.userPrompt.length,
    hasConversationContext: Boolean(params.conversationContext),
    globalTimeoutMs,
    attemptTimeoutMs,
  })

  let retriesUsed = 0
  try {
    while (true) {
      const attemptControl = createScopedAbortControl({
        parentSignal: effectiveSignal,
        timeoutMs: attemptTimeoutMs,
        timeoutErrorMessage: `ADK ${scope} attempt timeout exceeded (${attemptTimeoutMs}ms)`,
      })
      try {
        const result = await runSingleOrchestratorPass({
          ...params,
          signal: attemptControl.signal,
          attemptIndex: retriesUsed,
          maxRetries,
        })
        const handled = result.route === 'dialectic'

        debugLogger.api('ADK_ORCH_SUCCESS', {
          model: params.modelName,
          route: result.route,
          handled,
          retriesUsed,
          outputLength: handled ? result.text.length : 0,
        })

        return {
          handled,
          route: result.route,
          text: handled ? result.text : '',
          dialectic: handled ? result.dialectic : undefined,
          baconian: handled ? result.baconian : undefined,
          retriesUsed,
        }
      } catch (error) {
        const normalizedError = attemptControl.didTimeout()
          ? new Error(attemptControl.timeoutErrorMessage)
          : error
        const shouldRetry =
          retriesUsed < maxRetries &&
          !effectiveSignal.aborted &&
          isRetryableAdkError(normalizedError)

        if (!shouldRetry) {
          const finalError = globalControl.didTimeout()
            ? new Error(globalControl.timeoutErrorMessage)
            : normalizedError
          debugLogger.error('ADK_ORCH_FAILURE', {
            model: params.modelName,
            retriesUsed,
            error:
              finalError instanceof Error
                ? finalError.message
                : String(finalError),
          })
          throw finalError
        }

        const delayMs = computeRetryDelayMs({ attempt: retriesUsed })
        debugLogger.warn('ADK_ORCH_RETRY', {
          model: params.modelName,
          attempt: retriesUsed + 1,
          maxRetries,
          delayMs,
          error:
            normalizedError instanceof Error
              ? normalizedError.message
              : String(normalizedError),
        })
        await abortableDelay(delayMs, effectiveSignal)
        retriesUsed += 1
      } finally {
        attemptControl.cleanup()
      }
    }
  } finally {
    globalControl.cleanup()
  }
}

export async function runNormalizationSubagent(
  params: RunNormalizationSubagentParams,
): Promise<{
  text: string
  retriesUsed: number
  normalization?: HypothesisNormalizationResult
}> {
  const scope: AdkSessionScope = 'normalization'
  const maxRetries = Number.isFinite(params.maxRetries as number)
    ? Math.max(0, Math.floor(params.maxRetries as number))
    : 2
  const globalTimeoutMs = getScopeGlobalTimeoutMs(scope)
  const attemptTimeoutMs = getScopeAttemptTimeoutMs(scope)
  const globalControl = createScopedAbortControl({
    parentSignal: params.signal,
    timeoutMs: globalTimeoutMs,
    timeoutErrorMessage: `ADK ${scope} global timeout exceeded (${globalTimeoutMs}ms)`,
  })
  const effectiveSignal = globalControl.signal

  let retriesUsed = 0
  try {
    while (true) {
      const attemptControl = createScopedAbortControl({
        parentSignal: effectiveSignal,
        timeoutMs: attemptTimeoutMs,
        timeoutErrorMessage: `ADK ${scope} attempt timeout exceeded (${attemptTimeoutMs}ms)`,
      })
      try {
        const result = await runSingleNormalizationPass({
          ...params,
          signal: attemptControl.signal,
          attemptIndex: retriesUsed,
          maxRetries,
        })
        return {
          text: result.text,
          normalization: result.normalization,
          retriesUsed,
        }
      } catch (error) {
        const normalizedError = attemptControl.didTimeout()
          ? new Error(attemptControl.timeoutErrorMessage)
          : error
        const shouldRetry =
          retriesUsed < maxRetries &&
          !effectiveSignal.aborted &&
          isRetryableAdkError(normalizedError)
        if (!shouldRetry) {
          if (globalControl.didTimeout()) {
            throw new Error(globalControl.timeoutErrorMessage)
          }
          throw normalizedError
        }

        const delayMs = computeRetryDelayMs({ attempt: retriesUsed })
        await abortableDelay(delayMs, effectiveSignal)
        retriesUsed += 1
      } finally {
        attemptControl.cleanup()
      }
    }
  } finally {
    globalControl.cleanup()
  }
}

export async function runFalsificationSubagent(
  params: RunFalsificationSubagentParams,
): Promise<{
  text: string
  retriesUsed: number
  falsification?: FalsificationPlanResult
}> {
  const scope: AdkSessionScope = 'falsification'
  const maxRetries = Number.isFinite(params.maxRetries as number)
    ? Math.max(0, Math.floor(params.maxRetries as number))
    : 2
  const globalTimeoutMs = getScopeGlobalTimeoutMs(scope)
  const attemptTimeoutMs = getScopeAttemptTimeoutMs(scope)
  const globalControl = createScopedAbortControl({
    parentSignal: params.signal,
    timeoutMs: globalTimeoutMs,
    timeoutErrorMessage: `ADK ${scope} global timeout exceeded (${globalTimeoutMs}ms)`,
  })
  const effectiveSignal = globalControl.signal

  let retriesUsed = 0
  try {
    while (true) {
      const attemptControl = createScopedAbortControl({
        parentSignal: effectiveSignal,
        timeoutMs: attemptTimeoutMs,
        timeoutErrorMessage: `ADK ${scope} attempt timeout exceeded (${attemptTimeoutMs}ms)`,
      })
      try {
        const result = await runSingleFalsificationPass({
          ...params,
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
          isRetryableAdkError(normalizedError)
        if (!shouldRetry) {
          if (globalControl.didTimeout()) {
            throw new Error(globalControl.timeoutErrorMessage)
          }
          throw normalizedError
        }

        const delayMs = computeRetryDelayMs({ attempt: retriesUsed })
        await abortableDelay(delayMs, effectiveSignal)
        retriesUsed += 1
      } finally {
        attemptControl.cleanup()
      }
    }
  } finally {
    globalControl.cleanup()
  }
}

export async function runExperimentRunnersSubagent(
  params: RunExperimentRunnersSubagentParams,
): Promise<{
  text: string
  retriesUsed: number
  runners?: ExperimentRunnersResult
}> {
  const scope: AdkSessionScope = 'runners'
  const maxRetries = Number.isFinite(params.maxRetries as number)
    ? Math.max(0, Math.floor(params.maxRetries as number))
    : 2
  const globalTimeoutMs = getScopeGlobalTimeoutMs(scope)
  const attemptTimeoutMs = getScopeAttemptTimeoutMs(scope)
  const globalControl = createScopedAbortControl({
    parentSignal: params.signal,
    timeoutMs: globalTimeoutMs,
    timeoutErrorMessage: `ADK ${scope} global timeout exceeded (${globalTimeoutMs}ms)`,
  })
  const effectiveSignal = globalControl.signal

  let retriesUsed = 0
  try {
    while (true) {
      const attemptControl = createScopedAbortControl({
        parentSignal: effectiveSignal,
        timeoutMs: attemptTimeoutMs,
        timeoutErrorMessage: `ADK ${scope} attempt timeout exceeded (${attemptTimeoutMs}ms)`,
      })
      try {
        const result = await runSingleExperimentRunnersPass({
          ...params,
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
          isRetryableAdkError(normalizedError)
        if (!shouldRetry) {
          if (globalControl.didTimeout()) {
            throw new Error(globalControl.timeoutErrorMessage)
          }
          throw normalizeStrictJsonContractError(scope, normalizedError)
        }

        const delayMs = computeRetryDelayMs({ attempt: retriesUsed })
        await abortableDelay(delayMs, effectiveSignal)
        retriesUsed += 1
      } finally {
        attemptControl.cleanup()
      }
    }
  } finally {
    globalControl.cleanup()
  }
}

export const __agentRuntime = {
  isAdkDeterministicModeEnabled,
  isAdkLongRunModeEnabled,
  getScopeGlobalTimeoutMs,
  getScopeAttemptTimeoutMs,
  createScopedAbortControl,
  isRetryableAdkError,
  computeRetryDelayMs,
  abortableDelay,
  buildAdkSessionRuntime,
  createAdkRunner,
  createExecutionBudget,
  consumeRunnerEvents,
  captureSyntheticTraceEventWithDrop,
  captureRunnerEventWithLifecycle,
  maybeThrowOnLlmResponseError,
  extractBestEventText,
  persistAdkSessionRuntimeState,
  persistAdkArtifact,
  parseStrictDialecticOutput,
  parseStrictBaconianOutput,
  parseStrictNormalizationOutput,
  parseStrictFalsificationOutput,
  parseStrictExperimentRunnersOutput,
  formatDialecticResult,
  formatBaconianResult,
  formatNormalizationResult,
  formatFalsificationResult,
  formatExperimentRunnersResult,
  formatEventDiagnostics,
  buildBaconianInputFromDialectic,
  buildNormalizationInputFromContext,
  buildFalsificationInputFromContext,
  buildExperimentRunnersInputFromContext,
  withArtifactsLocationFooter,
}

export const __testOnly = {
  parseStrictOrchestratorCompositeOutput,
  parseStrictDialecticOutput,
  parseStrictBaconianOutput,
  parseStrictNormalizationOutput,
  parseStrictFalsificationOutput,
  parseStrictExperimentRunnersOutput,
  stripCodeFenceEnvelope,
  maybeParseDialecticJson,
  maybeParseBaconianJson,
  maybeParseNormalizationJson,
  maybeParseFalsificationJson,
  maybeParseExperimentRunnersJson,
  extractFunctionResponseResultText,
  extractBestEventText,
  isRetryableAdkError,
  normalizeStrictJsonContractError,
  formatBaconianResult,
  formatDialecticResult,
  formatNormalizationResult,
  formatFalsificationResult,
  formatExperimentRunnersResult,
  formatCombinedDialecticBaconianResult,
  formatArtifactsSavedAtLine,
  withArtifactsLocationFooter,
  computeRetryDelayMs,
  createExecutionBudget,
  enforceExecutionBudgetOrThrow,
  buildBaconianInputFromDialectic,
  buildNormalizationInputFromContext,
  buildFalsificationInputFromContext,
  buildExperimentRunnersInputFromContext,
  buildAdkEventSnapshot,
  captureAdkEventTrace,
}
