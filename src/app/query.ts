import {
  Message as APIAssistantMessage,
  MessageParam,
  ToolUseBlock,
} from '@anthropic-ai/sdk/resources/index.mjs'
import { randomUUID } from 'crypto'
import type { UUID } from '@amawta-types/common'
import type { Tool, ToolUseContext } from '@tool'
import type { ToolPermissionContext } from '@amawta-types/toolPermissionContext'
import {
  messagePairValidForBinaryFeedback,
  shouldUseBinaryFeedback,
} from './binaryFeedback'
import type { CanUseToolFn } from '@amawta-types/canUseTool'
import { queryLLM } from '@services/llmLazy'
import { formatSystemPromptWithContext } from '@services/systemPrompt'
import { emitReminderEvent } from '@services/systemReminder'
import { getOutputStyleSystemPromptAdditions } from '@services/outputStyles'
import { logError } from '@utils/log'
import {
  debug as debugLogger,
  markPhase,
  getCurrentRequest,
  logUserFriendly,
} from '@utils/log/debugLogger'
import { getModelManager } from '@utils/model'
import {
  createAssistantMessage,
  createAssistantAPIErrorMessage,
  createProgressMessage,
  createUserMessage,
  FullToolUseResult,
  INTERRUPT_MESSAGE,
  INTERRUPT_MESSAGE_FOR_TOOL_USE,
  REJECT_MESSAGE,
  NormalizedMessage,
  normalizeMessagesForAPI,
} from '@utils/messages'
import { appendSessionJsonlFromMessage } from '@utils/protocol/agentSessionLog'
import {
  getPlanModeSystemPromptAdditions,
  hydratePlanSlugFromMessages,
} from '@utils/plan/planMode'
import { setRequestStatus } from '@utils/session/requestStatus'
import { BashTool } from '@tools/BashTool/BashTool'
import {
  BunShell,
  renderBackgroundShellStatusAttachment,
  renderBashNotification,
} from '@utils/bun/shell'
import { resolveToolNameAlias } from '@utils/tooling/toolNameAliases'
import { getCwd } from '@utils/state'
import { checkAutoCompact } from '@utils/session/autoCompactCore'
import {
  drainHookSystemPromptAdditions,
  getHookTranscriptPath,
  queueHookAdditionalContexts,
  queueHookSystemMessages,
  runPostToolUseHooks,
  runPreToolUseHooks,
  runStopHooks,
  runUserPromptSubmitHooks,
  updateHookTranscriptForMessages,
} from '@utils/session/sessionHooks'

interface ExtendedToolUseContext extends ToolUseContext {
  abortController: AbortController
  options: {
    commands: any[]
    forkNumber: number
    messageLogName: string
    tools: Tool[]
    mcpClients?: any[]
    verbose: boolean
    safeMode: boolean
    maxThinkingTokens: number
    isKodingRequest?: boolean
    lastUserPrompt?: string
    model?: string | import('@utils/config').ModelPointerType
    toolPermissionContext?: ToolPermissionContext
    shouldAvoidPermissionPrompts?: boolean
    persistSession?: boolean
    latestNormalizationJson?: string
    latestFalsificationPlanJson?: string
  }
  readFileTimestamps: { [filename: string]: number }
  setToolJSX: (jsx: any) => void
  requestId?: string
}

export type Response = { costUSD: number; response: string }
export type UserMessage = {
  message: MessageParam
  type: 'user'
  uuid: UUID
  toolUseResult?: FullToolUseResult
  options?: {
    isKodingRequest?: boolean
    kodingContext?: string
    isCustomCommand?: boolean
    commandName?: string
    commandArgs?: string
  }
}

export type AssistantMessage = {
  costUSD: number
  durationMs: number
  message: APIAssistantMessage
  type: 'assistant'
  uuid: UUID
  isApiErrorMessage?: boolean
  responseId?: string
}

export type BinaryFeedbackResult =
  | { message: AssistantMessage | null; shouldSkipPermissionCheck: false }
  | { message: AssistantMessage; shouldSkipPermissionCheck: true }

export type ProgressMessage = {
  content: AssistantMessage
  normalizedMessages: NormalizedMessage[]
  siblingToolUseIDs: Set<string>
  tools: Tool[]
  toolUseID: string
  persistHistory?: boolean
  type: 'progress'
  uuid: UUID
}

export type Message = UserMessage | AssistantMessage | ProgressMessage

const HYPOTHESIS_STAGE_TOOL_NAMES = new Set([
  'DialecticalAnalysis',
  'BaconianAnalysis',
  'HypothesisNormalization',
  'FalsificationPlan',
  'ExperimentRunners',
])
const INTERNAL_TOOL_RESULT_NAMES = new Set(['Task', 'TaskOutput'])
const PIPELINE_LIFECYCLE_TOOL_NAMES = new Set([
  ...HYPOTHESIS_STAGE_TOOL_NAMES,
  'AskUserQuestion',
  'WebSearch',
])
const MAX_STOP_HOOK_ATTEMPTS = 5
const STAGE_RESTART_INTENT_MARKERS = [
  'comenzar',
  'comenzare',
  'comenzando',
  'iniciar',
  'iniciare',
  'iniciando',
  'voy a',
  'proceder',
  'procedere',
  'procediendo',
  'generar',
  'generare',
  'generando',
  'ejecutar',
  'ejecutare',
  'ejecutando',
  'start',
  'starting',
  'i will',
  "i'll",
] as const
const STAGE_RESTART_MARKERS: Partial<
  Record<NonNullable<FullToolUseResult['stage']>, readonly string[]>
> = {
  dialectical: ['analisis dialectico', 'dialectical analysis'],
  baconian: ['analisis baconiano', 'baconian analysis'],
  normalization: [
    'normalizar hipotesis',
    'normalizacion de hipotesis',
    'hypothesis normalization',
  ],
  falsification: ['plan de falsacion', 'falsification plan'],
  experiment_runners: ['runners experimentales', 'experiment runners'],
}

function toRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object') return {}
  return value as Record<string, unknown>
}

function toNumber(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined
  return value
}

function shouldEmitPipelineLifecycleProgress(
  toolName: string,
  context: { agentId?: string },
): boolean {
  return PIPELINE_LIFECYCLE_TOOL_NAMES.has(toolName)
}

function normalizeNarrationForMatching(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
}

function includesAnyMarker(text: string, markers: readonly string[]): boolean {
  return markers.some(marker => text.includes(marker))
}

function hasRenderableAssistantText(message: AssistantMessage): boolean {
  const content = message?.message?.content
  if (!Array.isArray(content)) return false
  for (const block of content) {
    if (block.type !== 'text' || typeof block.text !== 'string') continue
    if (block.text.trim().length > 0) return true
  }
  return false
}

type TurnResponseLanguage = 'en' | 'es'

function detectPreferredTurnResponseLanguage(
  prompt: string,
): TurnResponseLanguage | undefined {
  const raw = (prompt || '').trim()
  if (!raw) return undefined

  const normalized = raw
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()

  if (/[¿¡]/.test(raw)) return 'es'
  if (/\b(hypothesis|controlling|dataset|curvature|effort|falsification)\b/.test(normalized))
    return 'en'
  if (/\b(hipotesis|hipótesis|controlando|curvatura|esfuerzo|falsacion|falsación)\b/.test(raw.toLowerCase()))
    return 'es'

  const spanishMarkers = new Set([
    'el',
    'la',
    'los',
    'las',
    'de',
    'que',
    'y',
    'para',
    'con',
    'sin',
    'una',
    'un',
    'en',
    'del',
    'por',
    'como',
  ])
  const englishMarkers = new Set([
    'the',
    'and',
    'for',
    'with',
    'without',
    'under',
    'this',
    'that',
    'is',
    'are',
    'dataset',
    'hypothesis',
    'controlling',
    'between',
    'effort',
    'curvature',
  ])

  const words = normalized.match(/[a-z]+/g) || []
  let esScore = 0
  let enScore = 0
  for (const word of words) {
    if (spanishMarkers.has(word)) esScore += 1
    if (englishMarkers.has(word)) enScore += 1
  }

  if (enScore >= esScore + 2) return 'en'
  if (esScore >= enScore + 2) return 'es'
  return undefined
}

function buildTurnLanguageSystemPrompt(messages: Message[]): string | null {
  const { userPrompt } = extractLatestTurnContext(messages)
  const language = detectPreferredTurnResponseLanguage(userPrompt)
  if (language === 'en') {
    return [
      'LANGUAGE POLICY (TURN-LOCAL): respond in English for this turn.',
      'Keep narration, summaries, and selector-facing prose in English.',
      'Only preserve non-English text when quoting user-provided labels/paths/verbatim snippets.',
    ].join(' ')
  }
  if (language === 'es') {
    return [
      'POLITICA DE IDIOMA (TURNO ACTUAL): responde en español en este turno.',
      'Mantén narración, resúmenes y textos del selector en español.',
      'Solo conserva texto en otro idioma cuando cites etiquetas/rutas/snippets verbatim.',
    ].join(' ')
  }
  return null
}

function buildPipelineToolStartProgress(
  toolName: string,
  input: Record<string, unknown>,
): string {
  const hypothesisQuery =
    typeof input.hypothesis_query === 'string'
      ? input.hypothesis_query.trim()
      : ''
  const datasetHint =
    typeof input.dataset_hint === 'string' ? input.dataset_hint.trim() : ''

  switch (toolName) {
    case 'DialecticalAnalysis':
      return 'Plan: run DialecticalAnalysis to stress-test the hypothesis (thesis -> antithesis -> synthesis).'
    case 'BaconianAnalysis':
      return 'Plan: run BaconianAnalysis to clear biases and formalize presence tables.'
    case 'HypothesisNormalization':
      return 'Plan: run HypothesisNormalization to lock claim, variables, and observables.'
    case 'FalsificationPlan':
      return `Plan: run FalsificationPlan to define refutation tests${hypothesisQuery ? ' for the current hypothesis' : ''}.`
    case 'ExperimentRunners':
      return `Plan: run ExperimentRunners to validate the evidence contract${datasetHint ? ' using detected dataset_hint' : ''}.`
    case 'AskUserQuestion':
      return 'Plan: run AskUserQuestion to unblock a pending pipeline decision.'
    case 'WebSearch':
      return 'Plan: run WebSearch to collect external evidence and/or dataset candidates.'
    default:
      return `Plan: run ${toolName}.`
  }
}

function buildPipelineToolDoingProgress(toolName: string): string {
  switch (toolName) {
    case 'DialecticalAnalysis':
      return 'In progress: running DialecticalAnalysis.'
    case 'BaconianAnalysis':
      return 'In progress: running BaconianAnalysis.'
    case 'HypothesisNormalization':
      return 'In progress: running HypothesisNormalization.'
    case 'FalsificationPlan':
      return 'In progress: running FalsificationPlan.'
    case 'ExperimentRunners':
      return 'In progress: running ExperimentRunners.'
    case 'AskUserQuestion':
      return 'In progress: requesting user decision with AskUserQuestion.'
    case 'WebSearch':
      return 'In progress: running WebSearch.'
    default:
      return `In progress: running ${toolName}.`
  }
}

function buildPipelineToolFallbackNextAction(
  toolName: string,
  data: unknown,
): string {
  const record = toRecord(data)

  if (toolName === 'FalsificationPlan') {
    return 'Run ExperimentRunners to validate the falsification plan.'
  }

  if (toolName === 'ExperimentRunners') {
    const gates = toRecord(record.gates)
    const stageDecision =
      typeof gates.stageDecision === 'string' ? gates.stageDecision : ''
    const toyGate = toRecord(gates.toy)
    const toyTruth =
      typeof toyGate.truthAssessment === 'string'
        ? toyGate.truthAssessment.toUpperCase()
        : ''
    switch (stageDecision) {
      case 'REJECT_EARLY':
        return toyTruth === 'FAIL'
          ? 'Stop: toy falsified the claim. Close with refutation or reformulate before rerunning.'
          : 'Auto-repair upstream stages and retry FalsificationPlan + ExperimentRunners.'
      case 'DEFINITIVE_FAIL':
        return 'Auto-repair upstream stages and retry FalsificationPlan + ExperimentRunners.'
      case 'PROVISIONAL_PASS':
      case 'NEEDS_FIELD':
        return 'Complete field evidence (dataset_used=true, n_rows>=30, lobo_folds>=2).'
      case 'DEFINITIVE_PASS':
        return 'Proceed to the next pipeline block.'
      default:
        return 'Review gates and continue according to stage decision.'
    }
  }

  if (toolName === 'AskUserQuestion') {
    return 'Apply the user decision and continue with the corresponding tool.'
  }

  if (toolName === 'WebSearch') {
    return 'Process discovered evidence and continue with normalization/falsification.'
  }

  return ''
}

function buildPipelineToolCompletionProgress(
  toolName: string,
  data: unknown,
): string {
  const record = toRecord(data)
  const explicitNextAction =
    typeof record.nextAction === 'string' ? record.nextAction.trim() : ''
  const fallbackNextAction = buildPipelineToolFallbackNextAction(toolName, data)
  const nextAction = explicitNextAction || fallbackNextAction

  let done = `Done: ${toolName} completed.`

  if (toolName === 'FalsificationPlan') {
    const planStatus =
      typeof record.planStatus === 'string' ? record.planStatus : 'unknown'
    const overallMatch =
      typeof record.overallMatch === 'string' ? record.overallMatch : ''
    done = `Done: FalsificationPlan status=${planStatus}${overallMatch ? ` match=${overallMatch}` : ''}.`
  } else if (toolName === 'ExperimentRunners') {
    const executionSummary = toRecord(record.executionSummary)
    const executionResults = Array.isArray(record.executionResults)
      ? record.executionResults
      : []

    const runsTotal = toNumber(executionSummary.runsCount) ?? executionResults.length
    const runsOk =
      toNumber(executionSummary.successes) ??
      executionResults.filter(
        run => run && typeof run === 'object' && (run as any).status === 'success',
      ).length
    const runsFail =
      toNumber(executionSummary.failures) ??
      executionResults.filter(
        run => run && typeof run === 'object' && (run as any).status === 'failed',
      ).length
    const runsSkipped =
      toNumber(executionSummary.skipped) ??
      executionResults.filter(
        run => run && typeof run === 'object' && (run as any).status === 'skipped',
      ).length

    const gates = toRecord(record.gates)
    const stageDecision =
      typeof gates.stageDecision === 'string' ? gates.stageDecision : ''

    done =
      `Done: ExperimentRunners runs=${runsTotal} ok=${runsOk} fail=${runsFail} skipped=${runsSkipped}` +
      (stageDecision ? ` gate=${stageDecision}` : '') +
      '.'
  } else if (toolName === 'AskUserQuestion') {
    done = 'Done: AskUserQuestion answered.'
  } else if (toolName === 'WebSearch') {
    const resultsCount = toNumber(record.resultsCount)
    done = `Done: WebSearch completed${typeof resultsCount === 'number' ? ` (results=${resultsCount})` : ''}.`
  }

  if (!nextAction) return done
  return `${done} Next: ${nextAction}`
}

function inferLastCompletedHypothesisStage(
  messages: Message[],
): FullToolUseResult['stage'] | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]
    if (!message || message.type !== 'user') continue
    const stage = message.toolUseResult?.stage
    if (
      stage === 'dialectical' ||
      stage === 'baconian' ||
      stage === 'normalization' ||
      stage === 'falsification' ||
      stage === 'experiment_runners'
    ) {
      return stage
    }
  }
  return undefined
}

function sanitizeStaleStageRestartNarration(
  assistantMessage: AssistantMessage,
  priorMessages: Message[],
): AssistantMessage {
  if (!Array.isArray(assistantMessage.message.content)) return assistantMessage

  const lastStage = inferLastCompletedHypothesisStage(priorMessages)
  if (!lastStage) return assistantMessage

  const stageMarkers = STAGE_RESTART_MARKERS[lastStage]
  if (!stageMarkers || stageMarkers.length === 0) return assistantMessage

  let changed = false
  const sanitizedContent: APIAssistantMessage['content'] = []

  const collapseRepeatedAutoRepairPhrases = (text: string): string => {
    let next = text
    next = next.replace(
      /(?:Auto-repair: executing mandatory evidence-pipeline steps\.?\s*){2,}/gi,
      'Auto-repair: executing mandatory evidence-pipeline steps. ',
    )
    next = next.replace(
      /(Auto-repair: executing mandatory evidence-pipeline steps\.)\s*(?:\1\s*)+/gi,
      '$1 ',
    )
    next = next.replace(
      /(?:Auto-repair: executing ADK-directed next step \(\d+\/\d+\)\.?\s*){2,}/gi,
      (match: string) => {
        const first = match.match(
          /Auto-repair: executing ADK-directed next step \(\d+\/\d+\)\.?/i,
        )
        return `${(first?.[0] || '').replace(/\.$/, '')}. `
      },
    )
    next = next.replace(
      /(Auto-repair: executing ADK-directed next step \(\d+\/\d+\)\.)\s*(?:\1\s*)+/gi,
      '$1 ',
    )
    next = next.replace(
      /(?:Auto-repair: executing evidence-pipeline step \(\d+\/\d+\)\.?\s*){2,}/gi,
      (match: string) => {
        const first = match.match(
          /Auto-repair: executing evidence-pipeline step \(\d+\/\d+\)\.?/i,
        )
        return `${(first?.[0] || '').replace(/\.$/, '')}. `
      },
    )
    next = next.replace(
      /(Auto-repair: executing evidence-pipeline step \(\d+\/\d+\)\.)\s*(?:\1\s*)+/gi,
      '$1 ',
    )

    // Strip spurious attribution footers that sometimes leak into model outputs.
    next = next.replace(
      /^\s*(?:🤖\s*)?Generated with https?:\/\/github\.com\/shareAI-lab\/(?:Amawta|Anykode)[^\n]*$/gim,
      '',
    )
    next = next.replace(/^\s*Co-Authored-By:\s*.*$/gim, '')
    next = next.replace(/^\s*Co-authored-by:\s*.*$/gim, '')
    next = next.replace(/^\s*-\s*file:\/\/\/[^\n]*$/gim, '')
    return next
  }

  for (const block of assistantMessage.message.content) {
    if (block.type !== 'text' || typeof block.text !== 'string') {
      sanitizedContent.push(block)
      continue
    }

    const collapsedText = collapseRepeatedAutoRepairPhrases(block.text)
    if (collapsedText !== block.text) {
      changed = true
    }
    const originalLines = collapsedText.split('\n')
    const keptLines = originalLines.filter(line => {
      const normalizedLine = line.trim()
      if (!normalizedLine) return true
      const normalizedForMatching = normalizeNarrationForMatching(normalizedLine)
      return !(
        includesAnyMarker(normalizedForMatching, STAGE_RESTART_INTENT_MARKERS) &&
        includesAnyMarker(normalizedForMatching, stageMarkers)
      )
    })

    if (keptLines.length !== originalLines.length) {
      changed = true
    }

    const nextText = collapseRepeatedAutoRepairPhrases(
      keptLines.join('\n').replace(/\n{3,}/g, '\n\n').trim(),
    )
    if (nextText.length > 0) {
      sanitizedContent.push({
        ...block,
        text: nextText,
      })
    }
  }

  if (!changed) return assistantMessage

  if (sanitizedContent.length === 0) {
    return {
      ...assistantMessage,
      message: {
        ...assistantMessage.message,
        content: [{ type: 'text', text: '' }] as any,
      },
    }
  }

  return {
    ...assistantMessage,
    message: {
      ...assistantMessage.message,
      content: sanitizedContent as any,
    },
  }
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

function shouldEnableHypothesisEvidenceAutoLoop(
  toolUseContext: ExtendedToolUseContext,
): boolean {
  if (toolUseContext.agentId && toolUseContext.agentId !== 'main') return false
  if (isAdkPrimaryOrchestrationModeEnabled(toolUseContext)) return false
  return readBooleanEnv('AMAWTA_EVIDENCE_AUTOLOOP', true)
}

function isAdkPrimaryOrchestrationModeEnabled(
  toolUseContext: ExtendedToolUseContext,
): boolean {
  if (toolUseContext.agentId && toolUseContext.agentId !== 'main') return false
  return readBooleanEnv('AMAWTA_ADK_PRIMARY_ORCHESTRATION', true)
}

type HypothesisEvidenceObligation =
  | 'run_falsification_plan'
  | 'run_experiment_runners'
  | 'autorepair_failed_critical_tests'
  | 'ask_dataset_decision'
  | 'collect_field_evidence'

function isStrictHypothesisEvidenceObligation(
  obligation: HypothesisEvidenceObligation | undefined,
): boolean {
  return (
    obligation === 'run_falsification_plan' ||
    obligation === 'run_experiment_runners' ||
    obligation === 'autorepair_failed_critical_tests' ||
    obligation === 'ask_dataset_decision'
  )
}

function buildDatasetSelectorQuestionText(): string {
  return 'No real dataset was resolved automatically for field phase. How do you want to continue?'
}

function buildDatasetWebSearchQuery(hypothesisQuery: string): string {
  const normalized = hypothesisQuery.trim().replace(/\s+/g, ' ')
  if (!normalized) return 'open dataset measurable variables proxies csv parquet'
  return `${normalized} dataset measurable variables proxies for hypothesis testing tabular time series csv parquet open data`
}

function buildDatasetSelectorToolUse(questionText?: string): ToolUseBlock {
  return {
    type: 'tool_use' as const,
    id: randomUUID(),
    name: 'AskUserQuestion',
    input: {
      questions: [
        {
          header: 'Dataset',
          question: questionText || buildDatasetSelectorQuestionText(),
          options: [
            {
              label: 'Provide URL/path now (Recommended)',
              description: 'You provide a real dataset and field is retried.',
            },
            {
              label: 'Validate with local dataset',
              description:
                'Use local tabular files already present in the workspace.',
            },
            {
              label: 'Authorize extended web search',
              description: 'Try additional web discovery of real datasets.',
            },
            {
              label: 'Use provisional synthetic',
              description: 'Allow provisional progress without definitive closure.',
            },
          ],
          multiSelect: false,
        },
      ],
    },
  } as ToolUseBlock
}

function buildHypothesisEvidenceAutoLoopToolUses(
  messages: Message[],
  toolUseContext: ExtendedToolUseContext,
): ToolUseBlock[] {
  const snapshot = computeHypothesisEvidenceSnapshot(messages)
  const { userPrompt } = extractLatestTurnContext(messages)
  const hypothesisQuery = userPrompt.trim()
  if (!hypothesisQuery || hypothesisQuery.length < 8) return []

  // When the autoloop injects ExperimentRunners, include the latest structured
  // normalization + falsification context so the tool doesn't have to rely only
  // on in-memory caches (which can miss across tool contexts).
  const { normalizationJson, falsificationPlanJson } =
    getLatestExperimentRunnersStructuredContext(messages)

  const withExperimentRunnersContext = (
    input: Record<string, unknown>,
  ): Record<string, unknown> => ({
    ...input,
    ...(normalizationJson ? { normalization_json: normalizationJson } : {}),
    ...(falsificationPlanJson
      ? { falsification_plan_json: falsificationPlanJson }
      : {}),
  })

  const obligations = snapshot.pendingObligations
  if (obligations.length === 0) return []

  const hasTool = (name: string) =>
    toolUseContext.options.tools.some(tool => tool.name === name)
  const isInteractiveMode = !toolUseContext.options.shouldAvoidPermissionPrompts
  const hasAskUserQuestionTool = hasTool('AskUserQuestion')
  const hasWebSearchTool = hasTool('WebSearch')
  const hasExperimentRunnersTool = hasTool('ExperimentRunners')
  const hasFalsificationTool = hasTool('FalsificationPlan')

  if (
    obligations.includes('run_falsification_plan') &&
    hasFalsificationTool
  ) {
    return [
      {
        type: 'tool_use' as const,
        id: randomUUID(),
        name: 'FalsificationPlan',
        input: { hypothesis_query: hypothesisQuery },
      } as ToolUseBlock,
    ]
  }

  if (obligations.includes('ask_dataset_decision')) {
    const selection =
      snapshot.datasetDecisionAction || snapshot.datasetDecisionHasConcreteRef
        ? {
            action: snapshot.datasetDecisionAction,
            hasConcreteRef: snapshot.datasetDecisionHasConcreteRef === true,
          }
        : null

    if (selection?.action === 'web_search' && hasWebSearchTool) {
      const toolUses: ToolUseBlock[] = [
        {
          type: 'tool_use' as const,
          id: randomUUID(),
          name: 'WebSearch',
          input: {
            query: buildDatasetWebSearchQuery(hypothesisQuery),
          },
        } as ToolUseBlock,
      ]
      if (hasExperimentRunnersTool) {
        toolUses.push({
          type: 'tool_use' as const,
          id: randomUUID(),
          name: 'ExperimentRunners',
          input: withExperimentRunnersContext({
            hypothesis_query: hypothesisQuery,
            dataset_hint:
              snapshot.datasetDecisionValue || '__dataset_decision:web_search',
          }),
        } as ToolUseBlock)
      }
      return toolUses
    }

    if (selection?.action === 'synthetic_provisional' && hasExperimentRunnersTool) {
      return [
        {
          type: 'tool_use' as const,
          id: randomUUID(),
          name: 'ExperimentRunners',
          input: withExperimentRunnersContext({
            hypothesis_query: hypothesisQuery,
            dataset_hint:
              snapshot.datasetDecisionValue ||
              '__dataset_decision:synthetic_provisional',
          }),
        } as ToolUseBlock,
      ]
    }

    if (
      selection?.action === 'provide_url_or_path' &&
      selection.hasConcreteRef &&
      hasExperimentRunnersTool
    ) {
      return [
        {
          type: 'tool_use' as const,
          id: randomUUID(),
          name: 'ExperimentRunners',
          input: withExperimentRunnersContext({
            hypothesis_query: hypothesisQuery,
            dataset_hint: snapshot.datasetDecisionValue || hypothesisQuery,
          }),
        } as ToolUseBlock,
      ]
    }

    if (selection?.action === 'validate_local' && hasExperimentRunnersTool) {
      return [
        {
          type: 'tool_use' as const,
          id: randomUUID(),
          name: 'ExperimentRunners',
          input: withExperimentRunnersContext({
            hypothesis_query: hypothesisQuery,
            dataset_hint: snapshot.datasetDecisionValue || 'dataset local',
          }),
        } as ToolUseBlock,
      ]
    }

    if (!isInteractiveMode) {
      if (hasWebSearchTool) {
        const toolUses: ToolUseBlock[] = [
          {
            type: 'tool_use' as const,
            id: randomUUID(),
            name: 'WebSearch',
            input: {
              query: buildDatasetWebSearchQuery(hypothesisQuery),
            },
          } as ToolUseBlock,
        ]
        if (hasExperimentRunnersTool) {
          toolUses.push({
            type: 'tool_use' as const,
            id: randomUUID(),
            name: 'ExperimentRunners',
            input: withExperimentRunnersContext({
              hypothesis_query: hypothesisQuery,
              dataset_hint: '__dataset_decision:web_search',
            }),
          } as ToolUseBlock)
        }
        return toolUses
      }
      return []
    }

    if (hasAskUserQuestionTool) {
      const followUpQuestion =
        selection?.action === 'provide_url_or_path' &&
        !selection.hasConcreteRef
          ? 'You selected provide URL/path, but no usable reference was detected. How do you want to continue?'
          : undefined
      return [buildDatasetSelectorToolUse(followUpQuestion)]
    }
  }

  if (
    obligations.includes('autorepair_failed_critical_tests') &&
    hasExperimentRunnersTool
  ) {
    if (!snapshot.hasFalsificationReady && hasFalsificationTool) {
      return [
        {
          type: 'tool_use' as const,
          id: randomUUID(),
          name: 'FalsificationPlan',
          input: { hypothesis_query: hypothesisQuery },
        } as ToolUseBlock,
      ]
    }
    return [
      {
        type: 'tool_use' as const,
        id: randomUUID(),
        name: 'ExperimentRunners',
        input: withExperimentRunnersContext({ hypothesis_query: hypothesisQuery }),
      } as ToolUseBlock,
    ]
  }

  if (!hasExperimentRunnersTool) return []

  if (
    obligations.includes('run_experiment_runners') ||
    obligations.includes('collect_field_evidence') ||
    obligations.includes('autorepair_failed_critical_tests')
  ) {
    const datasetHintFromDecision =
      snapshot.datasetDecisionAction === 'provide_url_or_path' ||
      snapshot.datasetDecisionAction === 'validate_local'
        ? snapshot.datasetDecisionValue
        : snapshot.datasetDecisionAction === 'web_search'
          ? snapshot.datasetDecisionValue || '__dataset_decision:web_search'
          : snapshot.datasetDecisionAction === 'synthetic_provisional'
            ? snapshot.datasetDecisionValue ||
              '__dataset_decision:synthetic_provisional'
        : undefined
    return [
      {
        type: 'tool_use' as const,
        id: randomUUID(),
        name: 'ExperimentRunners',
        input: withExperimentRunnersContext({
          hypothesis_query: hypothesisQuery,
          ...(datasetHintFromDecision
            ? { dataset_hint: datasetHintFromDecision }
            : {}),
        }),
      } as ToolUseBlock,
    ]
  }

  return [
    {
      type: 'tool_use' as const,
      id: randomUUID(),
      name: 'ExperimentRunners',
      input: withExperimentRunnersContext({ hypothesis_query: hypothesisQuery }),
    } as ToolUseBlock,
  ]
}

function getLatestStructuredHypothesisToolResult(
  messages: Message[],
): FullToolUseResult | null {
  const { turnMessages } = extractLatestTurnContext(messages)
  for (let index = turnMessages.length - 1; index >= 0; index -= 1) {
    const message = turnMessages[index]
    if (!message || message.type !== 'user') continue
    const result = message.toolUseResult
    if (!result || result.visibility === 'internal') continue
    if (!result.toolName || !HYPOTHESIS_STAGE_TOOL_NAMES.has(result.toolName)) {
      continue
    }
    return result
  }
  return null
}

function getLatestDatasetDecision(
  messages: Message[],
):
  | {
      action: DatasetDecisionAction
      value: string
      hasConcreteRef: boolean
    }
  | undefined {
  const { turnMessages } = extractLatestTurnContext(messages)
  for (let index = turnMessages.length - 1; index >= 0; index -= 1) {
    const message = turnMessages[index]
    if (!message || message.type !== 'user') continue
    const parsed = parseDatasetDecisionFromToolUseResult(message.toolUseResult)
    if (parsed) return parsed
  }
  return undefined
}

function getLatestToolUseResultByToolName(
  messages: Message[],
  toolName: string,
): FullToolUseResult | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (!message || message.type !== 'user') continue
    const result = message.toolUseResult
    if (!result || result.visibility === 'internal') continue
    if (result.toolName !== toolName) continue
    return result
  }
  return null
}

function getLatestToolUseResultWithObjectDataKeys(
  messages: Message[],
  toolName: string,
  keys: string[],
): FullToolUseResult | null {
  const { turnMessages } = extractLatestTurnContext(messages)
  const candidates: FullToolUseResult[] = []

  for (let index = turnMessages.length - 1; index >= 0; index -= 1) {
    const message = turnMessages[index]
    if (!message || message.type !== 'user') continue
    const result = message.toolUseResult
    if (!result) continue
    if (result.toolName !== toolName) continue
    const data =
      result.data && typeof result.data === 'object'
        ? (result.data as Record<string, unknown>)
        : null
    if (!data) continue
    const hasAnyObjectKey = keys.some(key => {
      const value = data[key]
      return !!value && typeof value === 'object'
    })
    if (!hasAnyObjectKey) continue
    candidates.push(result)
  }

  if (candidates.length > 0) {
    for (const result of candidates) {
      const data =
        result.data && typeof result.data === 'object'
          ? (result.data as Record<string, unknown>)
          : null
      const planStatus = typeof data?.planStatus === 'string' ? data.planStatus : ''
      if (planStatus === 'ready') return result
      const evidenceStatus =
        result.evidence && typeof result.evidence.status === 'string'
          ? result.evidence.status
          : ''
      if (evidenceStatus === 'ready') return result
      const plan =
        data && typeof data.plan === 'object'
          ? (data.plan as Record<string, unknown>)
          : null
      const nestedMeta =
        plan &&
        typeof plan.falsification_plan === 'object' &&
        (plan.falsification_plan as any)?.meta &&
        typeof (plan.falsification_plan as any).meta === 'object'
          ? ((plan.falsification_plan as any).meta as Record<string, unknown>)
          : null
      if (typeof nestedMeta?.status === 'string' && nestedMeta.status === 'ready') {
        return result
      }
    }
    return candidates[0] ?? null
  }

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (!message || message.type !== 'user') continue
    const result = message.toolUseResult
    if (!result) continue
    if (result.toolName !== toolName) continue
    const data =
      result.data && typeof result.data === 'object'
        ? (result.data as Record<string, unknown>)
        : null
    if (!data) continue
    const hasAnyObjectKey = keys.some(key => {
      const value = data[key]
      return !!value && typeof value === 'object'
    })
    if (hasAnyObjectKey) return result
  }
  return null
}

function extractJsonFromToolResultData(
  value: unknown,
  key: string,
): string | undefined {
  if (!value || typeof value !== 'object') return undefined
  const record = value as Record<string, unknown>
  const candidate = record[key]
  if (!candidate || typeof candidate !== 'object') return undefined
  try {
    return JSON.stringify(candidate)
  } catch {
    return undefined
  }
}

function inferFalsificationPlanReadiness(
  raw: string | undefined,
): 'ready' | 'not_ready' | 'unknown' {
  const value = (raw || '').trim()
  if (!value) return 'not_ready'

  try {
    const parsed = JSON.parse(value) as {
      falsification_plan?: { meta?: { status?: string } }
    }
    const status = parsed?.falsification_plan?.meta?.status
    if (status === 'ready') return 'ready'
    if (typeof status === 'string') return 'not_ready'
  } catch {
    // Best-effort textual fallback below.
  }

  const normalized = value.replace(/\s+/g, ' ').trim().toLowerCase()
  if (
    normalized.includes('status plan/match: ready') ||
    (normalized.includes('"falsification_plan"') &&
      normalized.includes('"status":"ready"'))
  ) {
    return 'ready'
  }
  if (
    normalized.includes('status plan/match: skipped') ||
    normalized.includes('normalization_incomplete') ||
    normalized.includes('falsification_incomplete') ||
    normalized.includes('"status":"skipped"')
  ) {
    return 'not_ready'
  }
  return 'unknown'
}

function getLatestExperimentRunnersStructuredContext(messages: Message[]): {
  normalizationJson?: string
  falsificationPlanJson?: string
} {
  const latestNormalizationResult = getLatestToolUseResultWithObjectDataKeys(
    messages,
    'HypothesisNormalization',
    ['normalization'],
  )
  const latestFalsificationResult = getLatestToolUseResultWithObjectDataKeys(
    messages,
    'FalsificationPlan',
    ['plan', 'falsification_plan'],
  )
  const normalizationJson = extractJsonFromToolResultData(
    latestNormalizationResult?.data,
    'normalization',
  )
  const falsificationPlanJson =
    extractJsonFromToolResultData(latestFalsificationResult?.data, 'plan') ||
    extractJsonFromToolResultData(
      latestFalsificationResult?.data,
      'falsification_plan',
    )
  return { normalizationJson, falsificationPlanJson }
}

function enrichExperimentRunnersToolUsesWithStructuredContext(
  toolUses: ToolUseBlock[],
  messages: Message[],
): ToolUseBlock[] {
  if (toolUses.length === 0) return toolUses
  const { normalizationJson, falsificationPlanJson } =
    getLatestExperimentRunnersStructuredContext(messages)
  if (!normalizationJson && !falsificationPlanJson) return toolUses

  let changed = false
  const nextToolUses = toolUses.map(toolUse => {
    const resolvedName = resolveToolNameAlias(toolUse.name).resolvedName
    if (resolvedName !== 'ExperimentRunners') return toolUse

    const input =
      toolUse.input && typeof toolUse.input === 'object'
        ? (toolUse.input as Record<string, unknown>)
        : {}
    const hasNormalization =
      typeof input.normalization_json === 'string' &&
      input.normalization_json.trim().length > 0
    const hasFalsification =
      typeof input.falsification_plan_json === 'string' &&
      input.falsification_plan_json.trim().length > 0
    const currentFalsificationStatus = inferFalsificationPlanReadiness(
      hasFalsification ? String(input.falsification_plan_json || '') : '',
    )
    const contextualFalsificationStatus = inferFalsificationPlanReadiness(
      falsificationPlanJson,
    )

    const enrichedInput: Record<string, unknown> = {
      ...input,
      ...(!hasNormalization && normalizationJson
        ? { normalization_json: normalizationJson }
        : {}),
      ...((!hasFalsification && falsificationPlanJson) ||
      (currentFalsificationStatus !== 'ready' &&
        contextualFalsificationStatus === 'ready' &&
        !!falsificationPlanJson)
        ? { falsification_plan_json: falsificationPlanJson }
        : {}),
    }

    if (
      enrichedInput.normalization_json === input.normalization_json &&
      enrichedInput.falsification_plan_json === input.falsification_plan_json
    ) {
      return toolUse
    }

    changed = true
    return { ...toolUse, input: enrichedInput } as ToolUseBlock
  })

  return changed ? nextToolUses : toolUses
}

function orderHypothesisPipelineToolUses(
  toolUses: ToolUseBlock[],
): ToolUseBlock[] {
  if (toolUses.length <= 1) return toolUses

  const priorityByName = new Map<string, number>([
    ['HypothesisNormalization', 10],
    ['FalsificationPlan', 20],
    ['ExperimentRunners', 30],
  ])

  const annotated = toolUses.map((toolUse, index) => {
    const resolvedName = resolveToolNameAlias(toolUse.name).resolvedName
    const priority = priorityByName.get(resolvedName) ?? 100
    return { toolUse, index, priority }
  })

  const sorted = [...annotated].sort((a, b) => {
    if (a.priority !== b.priority) return a.priority - b.priority
    return a.index - b.index
  })

  const changed = sorted.some((entry, index) => entry.index !== index)
  if (!changed) return toolUses
  return sorted.map(entry => entry.toolUse)
}

function buildAdkDirectedAutoLoopToolUses(
  messages: Message[],
  toolUseContext: ExtendedToolUseContext,
): ToolUseBlock[] {
  const { userPrompt } = extractLatestTurnContext(messages)
  const hypothesisQuery = userPrompt.trim()
  if (!hypothesisQuery || hypothesisQuery.length < 8) return []

  const latestResult = getLatestStructuredHypothesisToolResult(messages)
  if (!latestResult) return []
  const snapshot = computeHypothesisEvidenceSnapshot(messages)

  // When the autoloop injects ExperimentRunners, include the latest structured
  // context so the tool doesn't have to rely on in-memory caches that may miss
  // across tool contexts (which can lead to confusing "FalsificationPlan not
  // ready" skips despite a prior ready plan in the transcript).
  const { normalizationJson, falsificationPlanJson } =
    getLatestExperimentRunnersStructuredContext(messages)

  const withExperimentRunnersContext = (
    input: Record<string, unknown>,
  ): Record<string, unknown> => ({
    ...input,
    ...(normalizationJson ? { normalization_json: normalizationJson } : {}),
    ...(falsificationPlanJson
      ? { falsification_plan_json: falsificationPlanJson }
      : {}),
  })

  const hasTool = (name: string) =>
    toolUseContext.options.tools.some(tool => tool.name === name)
  const hasFalsificationTool = hasTool('FalsificationPlan')
  const hasExperimentRunnersTool = hasTool('ExperimentRunners')
  const hasAskUserQuestionTool = hasTool('AskUserQuestion')
  const hasWebSearchTool = hasTool('WebSearch')
  const isInteractiveMode = !toolUseContext.options.shouldAvoidPermissionPrompts

  const stage =
    latestResult.stage === 'falsification' ||
    latestResult.stage === 'experiment_runners'
      ? latestResult.stage
      : 'other'

  if (stage === 'falsification') {
    const status = latestResult.evidence?.status
    if (status === 'ready' && hasExperimentRunnersTool) {
      return [
        {
          type: 'tool_use' as const,
          id: randomUUID(),
          name: 'ExperimentRunners',
          input: withExperimentRunnersContext({ hypothesis_query: hypothesisQuery }),
        } as ToolUseBlock,
      ]
    }
    return []
  }

  if (stage !== 'experiment_runners') return []

  const evidence = latestResult.evidence || {}
  const resultData =
    latestResult.data && typeof latestResult.data === 'object'
      ? (latestResult.data as Record<string, unknown>)
      : null
  const gates =
    resultData?.gates && typeof resultData.gates === 'object'
      ? (resultData.gates as Record<string, unknown>)
      : null
  const toyGate =
    gates?.toy && typeof gates.toy === 'object'
      ? (gates.toy as Record<string, unknown>)
      : null
  const evidenceGate =
    gates?.evidenceSufficiency && typeof gates.evidenceSufficiency === 'object'
      ? (gates.evidenceSufficiency as Record<string, unknown>)
      : null
  const stageDecision =
    normalizeStageDecision(evidence.stageDecision) ||
    normalizeStageDecision(gates?.stageDecision)
  const toyTruth =
    normalizeToyTruth(evidence.toyTruth) ||
    normalizeToyTruth(toyGate?.truthAssessment)
  const hasRealDataset =
    evidence.hasRealDataset === true ||
    evidenceGate?.hasRealDataset === true
  const claimDatasetFit =
    evidence.claimDatasetFit === true
      ? true
      : evidence.claimDatasetFit === false
        ? false
        : evidenceGate?.claimDatasetFit === true
          ? true
          : evidenceGate?.claimDatasetFit === false
            ? false
        : undefined
  const latestDecision = getLatestDatasetDecision(messages)
  const effectiveDecision =
    latestDecision?.action === 'unknown' ? undefined : latestDecision

  if (stageDecision === 'DEFINITIVE_PASS') return []
  if (stageDecision === 'REJECT_EARLY' && toyTruth === 'FAIL') return []

  if (
    ((stageDecision === 'REJECT_EARLY' && toyTruth !== 'FAIL') ||
      stageDecision === 'DEFINITIVE_FAIL') &&
    hasFalsificationTool
  ) {
    return [
      {
        type: 'tool_use' as const,
        id: randomUUID(),
        name: 'FalsificationPlan',
        input: { hypothesis_query: hypothesisQuery },
      } as ToolUseBlock,
    ]
  }

  if (stageDecision === 'NEEDS_FIELD' || stageDecision === 'PROVISIONAL_PASS') {
    // Avoid running field/dataset steps when the falsification plan is missing.
    // This prevents confusing "ExperimentRunners skipped: FalsificationPlan not ready" loops.
    if (!snapshot.hasFalsificationReady && hasFalsificationTool) {
      return [
        {
          type: 'tool_use' as const,
          id: randomUUID(),
          name: 'FalsificationPlan',
          input: { hypothesis_query: hypothesisQuery },
        } as ToolUseBlock,
      ]
    }

    if (effectiveDecision?.action === 'provide_url_or_path') {
      if (effectiveDecision.hasConcreteRef && hasExperimentRunnersTool) {
        return [
          {
            type: 'tool_use' as const,
            id: randomUUID(),
            name: 'ExperimentRunners',
            input: withExperimentRunnersContext({
              hypothesis_query: hypothesisQuery,
              dataset_hint: effectiveDecision.value,
            }),
          } as ToolUseBlock,
        ]
      }
      if (isInteractiveMode && hasAskUserQuestionTool) {
        return [buildDatasetSelectorToolUse()]
      }
      return []
    }

    if (effectiveDecision?.action === 'validate_local' && hasExperimentRunnersTool) {
      return [
        {
          type: 'tool_use' as const,
          id: randomUUID(),
          name: 'ExperimentRunners',
          input: withExperimentRunnersContext({
            hypothesis_query: hypothesisQuery,
            dataset_hint: effectiveDecision.value || 'dataset local',
          }),
        } as ToolUseBlock,
      ]
    }

    if (
      effectiveDecision?.action === 'synthetic_provisional' &&
      hasExperimentRunnersTool
    ) {
      return [
        {
          type: 'tool_use' as const,
          id: randomUUID(),
          name: 'ExperimentRunners',
          input: withExperimentRunnersContext({
            hypothesis_query: hypothesisQuery,
            dataset_hint:
              effectiveDecision.value || '__dataset_decision:synthetic_provisional',
          }),
        } as ToolUseBlock,
      ]
    }

    if (effectiveDecision?.action === 'web_search') {
      const toolUses: ToolUseBlock[] = []
      if (hasWebSearchTool) {
        toolUses.push({
          type: 'tool_use' as const,
          id: randomUUID(),
          name: 'WebSearch',
          input: {
            query: buildDatasetWebSearchQuery(hypothesisQuery),
          },
        } as ToolUseBlock)
      }
      if (hasExperimentRunnersTool) {
        toolUses.push({
          type: 'tool_use' as const,
          id: randomUUID(),
          name: 'ExperimentRunners',
          input: withExperimentRunnersContext({
            hypothesis_query: hypothesisQuery,
            dataset_hint: effectiveDecision.value || '__dataset_decision:web_search',
          }),
        } as ToolUseBlock)
      }
      return toolUses
    }

    if (!hasRealDataset || claimDatasetFit === false) {
      if (isInteractiveMode && hasAskUserQuestionTool) {
        return [buildDatasetSelectorToolUse()]
      }
      if (hasWebSearchTool) {
        return [
          {
            type: 'tool_use' as const,
            id: randomUUID(),
            name: 'WebSearch',
            input: {
              query: buildDatasetWebSearchQuery(hypothesisQuery),
            },
          } as ToolUseBlock,
        ]
      }
      return []
    }
  }

  return []
}

function buildToolUseActionSignature(toolUses: ToolUseBlock[]): string {
  return JSON.stringify(
    toolUses.map(toolUse => ({
      name: toolUse.name,
      input: toolUse.input ?? {},
    })),
  )
}

function buildAdkAutoLoopDecisionKey(messages: Message[]): string {
  const latestResult = getLatestStructuredHypothesisToolResult(messages)
  const latestDecision = getLatestDatasetDecision(messages)
  const snapshot = computeHypothesisEvidenceSnapshot(messages)
  return JSON.stringify({
    stage: latestResult?.stage || null,
    stageDecision:
      latestResult?.stage === 'experiment_runners'
        ? latestResult?.evidence?.stageDecision || null
        : null,
    criticalOverall:
      latestResult?.stage === 'experiment_runners'
        ? latestResult?.evidence?.criticalOverall || null
        : null,
    evidenceStatus:
      latestResult?.stage === 'falsification'
        ? latestResult?.evidence?.status || null
        : null,
    hasRealDataset:
      latestResult?.stage === 'experiment_runners'
        ? latestResult?.evidence?.hasRealDataset ?? null
        : null,
    claimDatasetFit:
      latestResult?.stage === 'experiment_runners'
        ? latestResult?.evidence?.claimDatasetFit ?? null
        : null,
    datasetDecisionAction: latestDecision?.action || null,
    datasetDecisionHasConcreteRef: latestDecision?.hasConcreteRef ?? null,
    datasetDecisionValue: latestDecision?.value
      ? latestDecision.value.slice(0, 256)
      : null,
  })
}

function createSyntheticAssistantToolUseMessage(params: {
  introText: string
  toolUses: ToolUseBlock[]
}): AssistantMessage {
  const assistant = createAssistantMessage(params.introText)
  const introText = (params.introText || '').trim()
  if (!introText) {
    assistant.message.content = params.toolUses as any
    return assistant
  }
  if (Array.isArray(assistant.message.content)) {
    assistant.message.content = [
      ...assistant.message.content,
      ...(params.toolUses as any[]),
    ] as any
  } else {
    assistant.message.content = params.toolUses as any
  }
  return assistant
}

function appendToolUsesToAssistantMessage(
  assistant: AssistantMessage,
  params: { introText?: string; toolUses: ToolUseBlock[] },
): AssistantMessage {
  if (!Array.isArray(assistant?.message?.content)) return assistant

  const introText = (params.introText || '').trim()
  const appendedBlocks: any[] = []

  // Keep the model's narration intact. Only add the auto-repair intro when
  // the assistant did not produce any renderable text (video-friendly).
  if (introText.length > 0) {
    appendedBlocks.push({
      type: 'text',
      text: introText,
      citations: [],
    })
  }

  appendedBlocks.push(...(params.toolUses as any[]))
  assistant.message.content = [
    ...assistant.message.content,
    ...appendedBlocks,
  ] as any
  return assistant
}

type HypothesisEvidenceSnapshot = {
  isHypothesisTurn: boolean
  hasPipelineSignal: boolean
  pendingObligations: HypothesisEvidenceObligation[]
  hasFalsificationReady: boolean
  hasExperimentRunnersReady: boolean
  hasDefinitivePass: boolean
  hasAutorepairRequired: boolean
  hasNeedsField: boolean
  hasNeedsDatasetDecision: boolean
  hasRealDatasetEvidence: boolean
  hasDatasetSemanticMismatch: boolean
  hasCriticalRunnerFail: boolean
  datasetDecisionAction?: DatasetDecisionAction
  datasetDecisionValue?: string
  datasetDecisionHasConcreteRef?: boolean
  syntheticProvisionalAccepted?: boolean
  lastToyTruth?: 'PASS' | 'FAIL' | 'INCONCLUSIVE'
  lastStageDecision?:
    | 'REJECT_EARLY'
    | 'PROVISIONAL_PASS'
    | 'NEEDS_FIELD'
    | 'DEFINITIVE_PASS'
    | 'DEFINITIVE_FAIL'
}

type DatasetDecisionAction =
  | 'provide_url_or_path'
  | 'validate_local'
  | 'web_search'
  | 'synthetic_provisional'
  | 'unknown'

function isToolResultContentBlockArray(content: unknown): boolean {
  if (!Array.isArray(content)) return false
  return content.some(
    block => block && typeof block === 'object' && (block as any).type === 'tool_result',
  )
}

function extractLatestTurnContext(messages: Message[]): {
  userPrompt: string
  turnMessages: Message[]
} {
  let latestUserPrompt = ''
  let latestUserPromptIndex = -1

  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]
    if (!message || message.type !== 'user') continue
    const content = message.message?.content
    if (typeof content === 'string') {
      latestUserPrompt = content
      latestUserPromptIndex = i
      break
    }
    if (!isToolResultContentBlockArray(content)) {
      latestUserPrompt = Array.isArray(content)
        ? content
            .filter(
              block =>
                block &&
                typeof block === 'object' &&
                (block as any).type === 'text' &&
                typeof (block as any).text === 'string',
            )
            .map(block => String((block as any).text))
            .join('\n')
        : ''
      latestUserPromptIndex = i
      break
    }
  }

  return {
    userPrompt: latestUserPrompt,
    turnMessages: messages.slice(latestUserPromptIndex + 1),
  }
}

function normalizeStageDecision(
  value: unknown,
): HypothesisEvidenceSnapshot['lastStageDecision'] | undefined {
  if (typeof value !== 'string') return undefined
  const normalized = value.trim().toUpperCase()
  if (
    normalized === 'REJECT_EARLY' ||
    normalized === 'PROVISIONAL_PASS' ||
    normalized === 'NEEDS_FIELD' ||
    normalized === 'DEFINITIVE_PASS' ||
    normalized === 'DEFINITIVE_FAIL'
  ) {
    return normalized
  }
  return undefined
}

function normalizeToyTruth(
  value: unknown,
): HypothesisEvidenceSnapshot['lastToyTruth'] | undefined {
  if (typeof value !== 'string') return undefined
  const normalized = value.trim().toUpperCase()
  if (
    normalized === 'PASS' ||
    normalized === 'FAIL' ||
    normalized === 'INCONCLUSIVE'
  ) {
    return normalized
  }
  return undefined
}

function deriveHypothesisEvidenceObligations(
  snapshot: Omit<HypothesisEvidenceSnapshot, 'pendingObligations'>,
): HypothesisEvidenceObligation[] {
  const shouldEnforce = snapshot.isHypothesisTurn || snapshot.hasPipelineSignal
  if (!shouldEnforce) return []

  if (!snapshot.hasFalsificationReady) {
    if (
      !snapshot.hasPipelineSignal &&
      !snapshot.hasExperimentRunnersReady &&
      !snapshot.lastStageDecision
    ) {
      return []
    }
    return ['run_falsification_plan']
  }

  if (!snapshot.hasExperimentRunnersReady) {
    return ['run_experiment_runners']
  }

  if (
    snapshot.lastStageDecision === 'REJECT_EARLY' &&
    snapshot.lastToyTruth === 'FAIL'
  ) {
    return []
  }

  // User explicitly accepted provisional synthetic mode: avoid repeated
  // dataset-resolution loops for non-definitive field states.
  if (
    snapshot.syntheticProvisionalAccepted &&
    (snapshot.lastStageDecision === 'PROVISIONAL_PASS' ||
      snapshot.lastStageDecision === 'NEEDS_FIELD')
  ) {
    return []
  }

  if (snapshot.hasCriticalRunnerFail || snapshot.hasAutorepairRequired) {
    return ['autorepair_failed_critical_tests']
  }

  if (snapshot.hasNeedsDatasetDecision) {
    return ['ask_dataset_decision']
  }

  if (snapshot.hasNeedsField && !snapshot.hasDefinitivePass) {
    if (
      snapshot.syntheticProvisionalAccepted &&
      snapshot.lastStageDecision === 'PROVISIONAL_PASS'
    ) {
      return []
    }
    return ['collect_field_evidence']
  }

  return []
}

function normalizeDatasetDecisionText(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
}

function hasConcreteDatasetReference(text: string): boolean {
  if (!text) return false
  return (
    /https?:\/\/\S+/i.test(text) ||
    /(?:^|[\s"'`])\/[^\s"'`]+/.test(text) ||
    /[a-zA-Z]:\\[^\s"'`]+/.test(text) ||
    /\b[\w./\\-]+\.(csv|tsv|parquet|jsonl|json|xlsx?)\b/i.test(text)
  )
}

function parseDatasetDecisionFromToolUseResult(toolUseResult?: FullToolUseResult): {
  action: DatasetDecisionAction
  value: string
  hasConcreteRef: boolean
} | null {
  if (!toolUseResult || toolUseResult.toolName !== 'AskUserQuestion') return null
  const data = toolUseResult.data
  if (!data || typeof data !== 'object') return null

  const record = data as Record<string, unknown>
  const answers = record.answers
  if (!answers || typeof answers !== 'object') return null

  const answerValues = Object.values(answers as Record<string, unknown>)
    .map(value => String(value || '').trim())
    .filter(Boolean)
  if (answerValues.length === 0) return null

  const rawValue = answerValues.join(' | ')
  const normalized = normalizeDatasetDecisionText(rawValue)
  const hasConcreteRef = hasConcreteDatasetReference(rawValue)

  if (hasConcreteRef) {
    return {
      action: 'provide_url_or_path',
      value: rawValue,
      hasConcreteRef: true,
    }
  }

  if (
    /\b(validar|usar|probar|trabajar)\b.*\b(dataset|datos)\b.*\blocal(?:es)?\b/.test(
      normalized,
    ) ||
    /\b(local dataset|local data)\b/.test(normalized) ||
    /\b(use|usar|validate|validar|test|probar)\b.*\blocal\b/.test(normalized) ||
    /\blocal\b.*\b(csv|tsv|parquet|jsonl|json|xlsx?|dataset|data|files?|archivo|archivos)\b/.test(
      normalized,
    )
  ) {
    return {
      action: 'validate_local',
      value: rawValue,
      hasConcreteRef: false,
    }
  }

  if (
    /\b(autorizar|habilitar|usar|authorize|enable|use)\b.*\b(busqueda|busqueda web|web search|discovery web|extended web search)\b/.test(
      normalized,
    ) ||
    /\bbusqueda web ampliada\b/.test(normalized)
  ) {
    return {
      action: 'web_search',
      value: rawValue,
      hasConcreteRef: false,
    }
  }

  if (/\b(sintetico|synthetic|provisional)\b/.test(normalized)) {
    return {
      action: 'synthetic_provisional',
      value: rawValue,
      hasConcreteRef: false,
    }
  }

  if (/\b(url|ruta|path)\b/.test(normalized)) {
    return {
      action: 'provide_url_or_path',
      value: rawValue,
      hasConcreteRef: false,
    }
  }

  return {
    action: 'unknown',
    value: rawValue,
    hasConcreteRef: false,
  }
}

function isDatasetDecisionSelectorAnswer(
  toolUseResult?: FullToolUseResult,
): boolean {
  return parseDatasetDecisionFromToolUseResult(toolUseResult) !== null
}

function inferHypothesisStageFromToolName(
  toolName: string | undefined,
): FullToolUseResult['stage'] {
  switch (toolName) {
    case 'DialecticalAnalysis':
      return 'dialectical'
    case 'BaconianAnalysis':
      return 'baconian'
    case 'HypothesisNormalization':
      return 'normalization'
    case 'FalsificationPlan':
      return 'falsification'
    case 'ExperimentRunners':
      return 'experiment_runners'
    default:
      return 'other'
  }
}

function inferToolResultVisibility(
  toolName: string,
  context: { agentId?: string },
): 'internal' | 'public' {
  if (context.agentId && context.agentId !== 'main') return 'internal'
  if (INTERNAL_TOOL_RESULT_NAMES.has(toolName)) return 'internal'
  return 'public'
}

function inferToolResultEvidence(
  toolName: string,
  data: unknown,
): NonNullable<FullToolUseResult['evidence']> | undefined {
  if (!data || typeof data !== 'object') return undefined
  const record = data as Record<string, unknown>

  if (toolName === 'FalsificationPlan') {
    const planStatus =
      typeof record.planStatus === 'string' ? record.planStatus : undefined
    return {
      status:
        planStatus === 'ready' || planStatus === 'skipped'
          ? planStatus
          : 'unknown',
      executed: true,
    }
  }

  if (toolName === 'ExperimentRunners') {
    const planStatus =
      typeof record.planStatus === 'string' ? record.planStatus : undefined
    const executionResults = Array.isArray(record.executionResults)
      ? record.executionResults
      : []
    const runsOk = executionResults.filter(
      run => run && typeof run === 'object' && (run as any).status === 'success',
    ).length
    const runsFailed = executionResults.filter(
      run => run && typeof run === 'object' && (run as any).status === 'failed',
    ).length
    const gates =
      record.gates && typeof record.gates === 'object'
        ? (record.gates as Record<string, unknown>)
        : null
    const toy =
      gates?.toy && typeof gates.toy === 'object'
        ? (gates.toy as Record<string, unknown>)
        : null
    const runnerContract =
      gates?.runnerContract && typeof gates.runnerContract === 'object'
        ? (gates.runnerContract as Record<string, unknown>)
        : null
    const evidenceSufficiency =
      gates?.evidenceSufficiency &&
      typeof gates.evidenceSufficiency === 'object'
        ? (gates.evidenceSufficiency as Record<string, unknown>)
        : null
    const stageDecisionRaw =
      typeof gates?.stageDecision === 'string' ? gates.stageDecision : undefined
    const stageDecision =
      stageDecisionRaw === 'REJECT_EARLY' ||
      stageDecisionRaw === 'PROVISIONAL_PASS' ||
      stageDecisionRaw === 'NEEDS_FIELD' ||
      stageDecisionRaw === 'DEFINITIVE_PASS' ||
      stageDecisionRaw === 'DEFINITIVE_FAIL'
        ? stageDecisionRaw
        : undefined
    const criticalVerdicts =
      record.criticalVerdicts && typeof record.criticalVerdicts === 'object'
        ? (record.criticalVerdicts as Record<string, unknown>)
        : null
    const criticalOverallRaw =
      typeof criticalVerdicts?.overall === 'string'
        ? criticalVerdicts.overall
        : undefined
    const criticalOverall =
      criticalOverallRaw === 'PASS' ||
      criticalOverallRaw === 'FAIL' ||
      criticalOverallRaw === 'INCONCLUSIVE'
        ? criticalOverallRaw
        : undefined
    return {
      status:
        planStatus === 'ready' || planStatus === 'skipped'
          ? planStatus
          : 'unknown',
      executed: true,
      runsTotal: executionResults.length,
      runsOk,
      runsFailed,
      toyTruth:
        toy?.truthAssessment === 'PASS' ||
        toy?.truthAssessment === 'FAIL' ||
        toy?.truthAssessment === 'INCONCLUSIVE'
          ? (toy.truthAssessment as 'PASS' | 'FAIL' | 'INCONCLUSIVE')
          : undefined,
      runnerContract:
        runnerContract?.status === 'PASS' || runnerContract?.status === 'FAIL'
          ? (runnerContract.status as 'PASS' | 'FAIL')
          : undefined,
      evidenceSufficiency:
        evidenceSufficiency?.status === 'PASS' ||
        evidenceSufficiency?.status === 'FAIL'
          ? (evidenceSufficiency.status as 'PASS' | 'FAIL')
          : undefined,
      stageDecision,
      criticalOverall,
      datasetUsed:
        typeof evidenceSufficiency?.datasetUsed === 'boolean'
          ? evidenceSufficiency.datasetUsed
          : undefined,
      hasRealDataset:
        typeof evidenceSufficiency?.hasRealDataset === 'boolean'
          ? evidenceSufficiency.hasRealDataset
          : undefined,
      claimDatasetFit:
        typeof evidenceSufficiency?.claimDatasetFit === 'boolean'
          ? evidenceSufficiency.claimDatasetFit
          : undefined,
      nRows:
        typeof evidenceSufficiency?.nRows === 'number'
          ? evidenceSufficiency.nRows
          : undefined,
      loboFolds:
        typeof evidenceSufficiency?.loboFolds === 'number'
          ? evidenceSufficiency.loboFolds
          : undefined,
    }
  }

  return undefined
}

function computeHypothesisEvidenceSnapshot(
  messages: Message[],
): HypothesisEvidenceSnapshot {
  const { userPrompt, turnMessages } = extractLatestTurnContext(messages)
  const normalizedPrompt = userPrompt.toLowerCase()
  const isHypothesisTurn =
    normalizedPrompt.includes('hipotes') || normalizedPrompt.includes('hypothes')

  let hasPipelineSignal = false
  let hasFalsificationReady = false
  let hasExperimentRunnersReady = false
  let hasDefinitivePass = false
  let hasAutorepairRequired = false
  let hasNeedsField = false
  let hasNeedsDatasetDecision = false
  let hasRealDatasetEvidence = false
  let hasDatasetSemanticMismatch = false
  let hasCriticalRunnerFail = false
  let lastToyTruth: HypothesisEvidenceSnapshot['lastToyTruth']
  let lastStageDecision: HypothesisEvidenceSnapshot['lastStageDecision']
  let latestStructuredRunnersSnapshot:
    | {
        stageDecision?: HypothesisEvidenceSnapshot['lastStageDecision']
        toyTruth?: HypothesisEvidenceSnapshot['lastToyTruth']
        criticalOverall?: 'PASS' | 'FAIL' | 'INCONCLUSIVE'
        hasRealDataset?: boolean
        claimDatasetFit?: boolean
      }
    | undefined

  let latestExperimentRunnersTurnIndex = -1
  let latestDatasetDecisionAnswerIndex = -1
  let latestDatasetDecision:
    | {
        action: DatasetDecisionAction
        value: string
        hasConcreteRef: boolean
      }
    | undefined
  let syntheticProvisionalAccepted = false

  for (const [turnIndex, message] of turnMessages.entries()) {
    if (!message) continue

    if (message.type === 'assistant' && Array.isArray(message.message?.content)) {
      for (const block of message.message.content as any[]) {
        if (
          block &&
          typeof block === 'object' &&
          (block.type === 'tool_use' ||
            block.type === 'server_tool_use' ||
            block.type === 'mcp_tool_use') &&
          HYPOTHESIS_STAGE_TOOL_NAMES.has(String(block.name || ''))
        ) {
          hasPipelineSignal = true
        }
      }
    }

    if (message.type !== 'user') continue
    const datasetDecision = parseDatasetDecisionFromToolUseResult(
      message.toolUseResult,
    )
    if (datasetDecision) {
      latestDatasetDecisionAnswerIndex = turnIndex
      latestDatasetDecision = datasetDecision
      hasNeedsDatasetDecision =
        datasetDecision.action === 'unknown' ||
        (datasetDecision.action === 'provide_url_or_path' &&
          !datasetDecision.hasConcreteRef)
    }
    const toolResult = message.toolUseResult
    if (!toolResult) continue
    const stage = toolResult.stage
    const data = (toolResult.data || {}) as Record<string, unknown>
    const planStatus = typeof data.planStatus === 'string' ? data.planStatus : ''
    const executionResults = Array.isArray(data.executionResults)
      ? data.executionResults
      : []
    const evidence = toolResult.evidence
    const stageDecision =
      normalizeStageDecision(evidence?.stageDecision) ||
      normalizeStageDecision((data.gates as any)?.stageDecision)

    if (
      stage === 'dialectical' ||
      stage === 'baconian' ||
      stage === 'normalization' ||
      stage === 'falsification' ||
      stage === 'experiment_runners'
    ) {
      hasPipelineSignal = true
    }

    if (
      stage === 'falsification' ||
      (planStatus === 'ready' &&
        typeof data.testsCount === 'number' &&
        typeof data.variantsCount === 'number')
    ) {
      if (planStatus === 'ready') hasFalsificationReady = true
    }

    if (stage === 'experiment_runners') {
      if (planStatus === 'ready') hasExperimentRunnersReady = true
      latestExperimentRunnersTurnIndex = turnIndex
      if (stageDecision) lastStageDecision = stageDecision
      const toyTruth =
        normalizeToyTruth(evidence?.toyTruth) ||
        normalizeToyTruth((data.gates as any)?.toy?.truthAssessment)
      const hasRealDataset =
        evidence?.hasRealDataset === true ||
        (typeof (data.gates as any)?.evidenceSufficiency?.hasRealDataset ===
          'boolean'
          ? (data.gates as any).evidenceSufficiency.hasRealDataset === true
          : false)
      const claimDatasetFit =
        typeof evidence?.claimDatasetFit === 'boolean'
          ? evidence.claimDatasetFit
          : typeof (data.gates as any)?.evidenceSufficiency?.claimDatasetFit ===
                'boolean'
            ? (data.gates as any).evidenceSufficiency.claimDatasetFit === true
            : undefined
      if (hasRealDataset) hasRealDatasetEvidence = true
      if (claimDatasetFit === false) hasDatasetSemanticMismatch = true
      const criticalOverall =
        evidence?.criticalOverall ||
        (typeof (data.criticalVerdicts as any)?.overall === 'string'
          ? ((data.criticalVerdicts as any).overall as
              | 'PASS'
              | 'FAIL'
              | 'INCONCLUSIVE')
          : undefined)
      latestStructuredRunnersSnapshot = {
        stageDecision,
        toyTruth,
        criticalOverall,
        hasRealDataset,
        claimDatasetFit,
      }
      if (criticalOverall === 'FAIL') {
        hasCriticalRunnerFail = true
      }
      if (stageDecision === 'DEFINITIVE_PASS') hasDefinitivePass = true
      if (toyTruth) {
        lastToyTruth = toyTruth
      }
      if (
        (stageDecision === 'REJECT_EARLY' && toyTruth !== 'FAIL') ||
        stageDecision === 'DEFINITIVE_FAIL'
      ) {
        hasAutorepairRequired = true
      }
      if (stageDecision === 'PROVISIONAL_PASS' || stageDecision === 'NEEDS_FIELD') {
        hasNeedsField = true
        if (
          stageDecision === 'NEEDS_FIELD' &&
          (!hasRealDataset || claimDatasetFit === false)
        ) {
          hasNeedsDatasetDecision = true
        }
      }
    } else if (
      typeof data.runnersCount === 'number' &&
      (executionResults.length > 0 || data.plan !== undefined) &&
      planStatus === 'ready'
    ) {
      hasExperimentRunnersReady = true
    }
  }

  const latestSnapshot = latestStructuredRunnersSnapshot
  if (latestSnapshot) {
    const latestStageDecision = latestSnapshot.stageDecision
    const latestToyTruth = latestSnapshot.toyTruth
    const latestHasRealDataset = latestSnapshot.hasRealDataset === true
    const latestClaimDatasetFit =
      latestSnapshot.claimDatasetFit === true
        ? true
        : latestSnapshot.claimDatasetFit === false
          ? false
          : undefined
    const latestCriticalFail = latestSnapshot.criticalOverall === 'FAIL'

    if (latestStageDecision) {
      lastStageDecision = latestStageDecision
    }
    if (latestToyTruth) {
      lastToyTruth = latestToyTruth
    }
    hasExperimentRunnersReady = true
    hasCriticalRunnerFail = latestCriticalFail
    hasRealDatasetEvidence = latestHasRealDataset || hasRealDatasetEvidence
    hasDatasetSemanticMismatch =
      latestClaimDatasetFit === false || hasDatasetSemanticMismatch
    hasDefinitivePass = latestStageDecision === 'DEFINITIVE_PASS'
    hasAutorepairRequired =
      ((latestStageDecision === 'REJECT_EARLY' && latestToyTruth !== 'FAIL') ||
        latestStageDecision === 'DEFINITIVE_FAIL')
    hasNeedsField =
      latestStageDecision === 'PROVISIONAL_PASS' ||
      latestStageDecision === 'NEEDS_FIELD'
    hasNeedsDatasetDecision =
      latestStageDecision === 'NEEDS_FIELD' &&
      (!latestHasRealDataset || latestClaimDatasetFit === false)
  }

  const datasetDecisionAnsweredAfterLatestRunners =
    latestDatasetDecisionAnswerIndex > latestExperimentRunnersTurnIndex

  // Persist explicit synthetic-provisional authorization for this turn
  // regardless of whether the answer came before/after the latest runners.
  if (latestDatasetDecision?.action === 'synthetic_provisional') {
    syntheticProvisionalAccepted = true
  }

  if (hasNeedsDatasetDecision && datasetDecisionAnsweredAfterLatestRunners) {
    const requiresConcreteReference =
      latestDatasetDecision?.action === 'provide_url_or_path' &&
      !latestDatasetDecision.hasConcreteRef
    const unresolvedDecision = latestDatasetDecision?.action === 'unknown'
    hasNeedsDatasetDecision = requiresConcreteReference || unresolvedDecision
  }
  if (
    datasetDecisionAnsweredAfterLatestRunners &&
    latestDatasetDecision?.action === 'synthetic_provisional'
  ) {
    syntheticProvisionalAccepted = true
  }
  if (syntheticProvisionalAccepted) {
    hasNeedsDatasetDecision = false
  }

  const snapshotBase: Omit<HypothesisEvidenceSnapshot, 'pendingObligations'> = {
    isHypothesisTurn,
    hasPipelineSignal,
    hasFalsificationReady,
    hasExperimentRunnersReady,
    hasDefinitivePass,
    hasAutorepairRequired,
    hasNeedsField,
    hasNeedsDatasetDecision,
    hasRealDatasetEvidence,
    hasDatasetSemanticMismatch,
    hasCriticalRunnerFail,
    datasetDecisionAction: latestDatasetDecision?.action,
    datasetDecisionValue: latestDatasetDecision?.value,
    datasetDecisionHasConcreteRef: latestDatasetDecision?.hasConcreteRef,
    syntheticProvisionalAccepted,
    lastToyTruth,
    lastStageDecision,
  }

  return {
    ...snapshotBase,
    pendingObligations: deriveHypothesisEvidenceObligations(snapshotBase),
  }
}

function buildHypothesisEvidenceGateInstruction(messages: Message[]): string | null {
  const snapshot = computeHypothesisEvidenceSnapshot(messages)
  const [obligation] = snapshot.pendingObligations
  if (!obligation) return null

  if (obligation === 'run_falsification_plan') {
    return [
      'SYSTEM GATE: Hypothesis pipeline signals already exist, but FalsificationPlan is not ready yet.',
      'Before finalizing, you must run FalsificationPlan and then ExperimentRunners.',
      'Do not close with final narrative while this minimum contract is missing.',
    ].join(' ')
  }

  if (obligation === 'run_experiment_runners') {
    return [
      'SYSTEM GATE: In this hypothesis turn, FalsificationPlan is already ready.',
      'Before finalizing, you must call ExperimentRunners exactly once.',
      'Then summarize using concrete execution evidence (runs ok/fail, diffs, command output).',
      'Do not close with narrative without that evidence.',
    ].join(' ')
  }

  if (obligation === 'autorepair_failed_critical_tests') {
    return [
      `SYSTEM GATE: Current stage decision is ${snapshot.lastStageDecision || 'REJECT_EARLY'}.`,
      'FAIL was detected in at least one critical ExperimentRunners test.',
      'You must auto-repair upstream stages before closing: rerun FalsificationPlan with failure signals and then ExperimentRunners.',
      'Do not finalize until you exit REJECT_EARLY/DEFINITIVE_FAIL.',
    ].join(' ')
  }

  if (obligation === 'ask_dataset_decision') {
    const reason = snapshot.hasDatasetSemanticMismatch
      ? 'the detected dataset is not relevant to the claim'
      : 'there is no usable real dataset'
    return [
      `SYSTEM GATE: Current result is ${snapshot.lastStageDecision || 'NEEDS_FIELD'} and ${reason}.`,
      'Before closing, you must invoke AskUserQuestion (Amawta Selector) to decide field dataset strategy (user URL/path, extended web search, or provisional synthetic mode).',
      'Do not close with final narrative or attempt definitive pass without that user decision.',
    ].join(' ')
  }

  if (obligation === 'collect_field_evidence') {
    return [
      `SYSTEM GATE: Current result is ${snapshot.lastStageDecision || 'NEEDS_FIELD'} (non-definitive).`,
      'You must continue field phase with sufficient evidence (dataset_used=true, n_rows>=30, lobo_folds>=2).',
      'Do not claim definitive validation until reaching DEFINITIVE_PASS.',
    ].join(' ')
  }

  return null
}

function buildHypothesisEvidenceGateHardBlockMessage(
  messages: Message[],
): string | null {
  const snapshot = computeHypothesisEvidenceSnapshot(messages)
  const [obligation] = snapshot.pendingObligations
  if (!obligation) return null

  if (obligation === 'run_falsification_plan') {
    return [
      'I cannot close this response: FalsificationPlan is not ready in this turn.',
      'Mandatory next step: run FalsificationPlan and then ExperimentRunners.',
    ].join(' ')
  }

  if (obligation === 'run_experiment_runners') {
    return [
      'I cannot close this response: ExperimentRunners has not run in this turn.',
      'Mandatory next step: run ExperimentRunners and continue with real run evidence.',
    ].join(' ')
  }

  if (obligation === 'autorepair_failed_critical_tests') {
    return [
      'I cannot close with final narrative: at least one critical test reported FAIL.',
      'Mandatory next step: auto-repair (update plan and rerun critical tests) before any positive conclusion.',
    ].join(' ')
  }

  if (obligation === 'ask_dataset_decision') {
    const reason = snapshot.hasDatasetSemanticMismatch
      ? 'the detected dataset is not relevant to the claim'
      : 'there is no usable real dataset'
    return [
      `I cannot close: current stage is ${snapshot.lastStageDecision || 'NEEDS_FIELD'} and ${reason}.`,
      'Mandatory next step: AskUserQuestion (Amawta Selector) to decide field dataset strategy.',
      'If running in non-interactive mode (for example --print), provide a real dataset URL/path directly in the prompt.',
      'If interactive mode is enabled and the selector did not appear, run one more turn to trigger AskUserQuestion again.',
    ].join(' ')
  }

  if (obligation === 'collect_field_evidence') {
    return [
      `I cannot close: current result is ${snapshot.lastStageDecision || 'NEEDS_FIELD'} (non-definitive).`,
      'Mandatory next step: continue field phase with sufficient evidence (dataset_used=true, n_rows>=30, lobo_folds>=2).',
    ].join(' ')
  }

  return null
}

const startedSessionReminderKeys = new Set<string>()

function getSessionReminderStartupKey(context: ExtendedToolUseContext): string {
  const messageLogName = context.options?.messageLogName || 'default'
  const forkNumber = context.options?.forkNumber ?? 0
  const agentId = context.agentId || 'main'
  return `${messageLogName}:${forkNumber}:${agentId}`
}

type ToolQueueEntry = {
  id: string
  block: ToolUseBlock
  assistantMessage: AssistantMessage
  status: 'queued' | 'executing' | 'completed' | 'yielded'
  isConcurrencySafe: boolean
  pendingProgress: ProgressMessage[]
  queuedProgressEmitted?: boolean
  results?: (UserMessage | AssistantMessage)[]
  contextModifiers?: Array<
    (ctx: ExtendedToolUseContext) => ExtendedToolUseContext
  >
  promise?: Promise<void>
}

type ToolUseLikeBlock = ToolUseBlock & {
  type: 'tool_use' | 'server_tool_use' | 'mcp_tool_use'
}

function isToolUseLikeBlock(block: any): block is ToolUseLikeBlock {
  return (
    block &&
    typeof block === 'object' &&
    (block.type === 'tool_use' ||
      block.type === 'server_tool_use' ||
      block.type === 'mcp_tool_use')
  )
}

export const __isToolUseLikeBlockForTests = isToolUseLikeBlock

function createSyntheticToolUseErrorMessage(
  toolUseId: string,
  reason: 'user_interrupted' | 'sibling_error',
): UserMessage {
  if (reason === 'user_interrupted') {
    return createUserMessage([
      {
        type: 'tool_result',
        content: REJECT_MESSAGE,
        is_error: true,
        tool_use_id: toolUseId,
      },
    ])
  }

  return createUserMessage([
    {
      type: 'tool_result',
      content: '<tool_use_error>Sibling tool call errored</tool_use_error>',
      is_error: true,
      tool_use_id: toolUseId,
    },
  ])
}

class ToolUseQueue {
  private toolDefinitions: Tool[]
  private canUseTool: CanUseToolFn
  private tools: ToolQueueEntry[] = []
  private toolUseContext: ExtendedToolUseContext
  private hasErrored = false
  private progressAvailableResolve: (() => void) | undefined
  private siblingToolUseIDs: Set<string>
  private shouldSkipPermissionCheck?: boolean

  constructor(options: {
    toolDefinitions: Tool[]
    canUseTool: CanUseToolFn
    toolUseContext: ExtendedToolUseContext
    siblingToolUseIDs: Set<string>
    shouldSkipPermissionCheck?: boolean
  }) {
    this.toolDefinitions = options.toolDefinitions
    this.canUseTool = options.canUseTool
    this.toolUseContext = options.toolUseContext
    this.siblingToolUseIDs = options.siblingToolUseIDs
    this.shouldSkipPermissionCheck = options.shouldSkipPermissionCheck
  }

  addTool(toolUse: ToolUseBlock, assistantMessage: AssistantMessage) {
    const resolvedToolName = resolveToolNameAlias(toolUse.name).resolvedName
    const toolDefinition = this.toolDefinitions.find(
      t => t.name === resolvedToolName,
    )
    const parsedInput = toolDefinition?.inputSchema.safeParse(toolUse.input)
    const isConcurrencySafe =
      toolDefinition && parsedInput?.success
        ? toolDefinition.isConcurrencySafe(parsedInput.data as any)
        : false

    this.tools.push({
      id: toolUse.id,
      block: toolUse,
      assistantMessage,
      status: 'queued',
      isConcurrencySafe,
      pendingProgress: [],
      queuedProgressEmitted: false,
    })

    void this.processQueue()
  }

  private canExecuteTool(isConcurrencySafe: boolean) {
    const executing = this.tools.filter(t => t.status === 'executing')
    return (
      executing.length === 0 ||
      (isConcurrencySafe && executing.every(t => t.isConcurrencySafe))
    )
  }

  private async processQueue() {
    for (const entry of this.tools) {
      if (entry.status !== 'queued') continue

      if (this.canExecuteTool(entry.isConcurrencySafe)) {
        await this.executeTool(entry)
      } else {
        if (!entry.queuedProgressEmitted) {
          entry.queuedProgressEmitted = true
          entry.pendingProgress.push(
            createProgressMessage(
              entry.id,
              this.siblingToolUseIDs,
              createAssistantMessage('<tool-progress>Waiting…</tool-progress>'),
              [],
              this.toolUseContext.options.tools,
            ),
          )
          if (this.progressAvailableResolve) {
            this.progressAvailableResolve()
            this.progressAvailableResolve = undefined
          }
        }

        if (!entry.isConcurrencySafe) {
          break
        }
      }
    }
  }

  private getAbortReason(): 'sibling_error' | 'user_interrupted' | null {
    if (this.hasErrored) return 'sibling_error'
    if (this.toolUseContext.abortController.signal.aborted)
      return 'user_interrupted'
    return null
  }

  private async executeTool(entry: ToolQueueEntry) {
    entry.status = 'executing'

    const results: (UserMessage | AssistantMessage)[] = []
    const contextModifiers: Array<
      (ctx: ExtendedToolUseContext) => ExtendedToolUseContext
    > = []

    const promise = (async () => {
      const abortReason = this.getAbortReason()
      if (abortReason) {
        results.push(createSyntheticToolUseErrorMessage(entry.id, abortReason))
        entry.results = results
        entry.contextModifiers = contextModifiers
        entry.status = 'completed'
        return
      }

      const generator = runToolUse(
        entry.block,
        this.siblingToolUseIDs,
        entry.assistantMessage,
        this.canUseTool,
        this.toolUseContext,
        this.shouldSkipPermissionCheck,
      )

      let toolErrored = false

      for await (const message of generator) {
        const reason = this.getAbortReason()
        if (reason && !toolErrored) {
          results.push(createSyntheticToolUseErrorMessage(entry.id, reason))
          break
        }

        if (
          message.type === 'user' &&
          Array.isArray(message.message.content) &&
          message.message.content.some(
            block => block.type === 'tool_result' && block.is_error === true,
          )
        ) {
          this.hasErrored = true
          toolErrored = true
        }

        if (message.type === 'progress') {
          entry.pendingProgress.push(message)
          if (this.progressAvailableResolve) {
            this.progressAvailableResolve()
            this.progressAvailableResolve = undefined
          }
        } else {
          results.push(message)

          if (
            message.type === 'user' &&
            message.toolUseResult?.contextModifier
          ) {
            contextModifiers.push(
              message.toolUseResult.contextModifier.modifyContext as any,
            )
          }
        }
      }

      entry.results = results
      entry.contextModifiers = contextModifiers
      entry.status = 'completed'

      if (contextModifiers.length > 0) {
        for (const modifyContext of contextModifiers) {
          this.toolUseContext = modifyContext(this.toolUseContext)
        }
      }
    })()

    entry.promise = promise
    promise.finally(() => {
      void this.processQueue()
    })
  }

  private *getCompletedResults(): Generator<Message, void> {
    let barrierExecuting = false
    for (const entry of this.tools) {
      while (entry.pendingProgress.length > 0) {
        yield entry.pendingProgress.shift()!
      }

      if (entry.status === 'yielded') continue

      if (barrierExecuting) continue

      if (entry.status === 'completed' && entry.results) {
        entry.status = 'yielded'
        for (const message of entry.results) {
          yield message
        }
      } else if (entry.status === 'executing' && !entry.isConcurrencySafe) {
        barrierExecuting = true
      }
    }
  }

  private hasPendingProgress() {
    return this.tools.some(t => t.pendingProgress.length > 0)
  }

  private hasCompletedResults() {
    return this.tools.some(t => t.status === 'completed')
  }

  private hasExecutingTools() {
    return this.tools.some(t => t.status === 'executing')
  }

  private hasUnfinishedTools() {
    return this.tools.some(t => t.status !== 'yielded')
  }

  async *getRemainingResults(): AsyncGenerator<Message, void> {
    while (this.hasUnfinishedTools()) {
      await this.processQueue()

      for (const message of this.getCompletedResults()) {
        yield message
      }

      if (
        this.hasExecutingTools() &&
        !this.hasCompletedResults() &&
        !this.hasPendingProgress()
      ) {
        const promises = this.tools
          .filter(t => t.status === 'executing' && t.promise)
          .map(t => t.promise!)

        const progressPromise = new Promise<void>(resolve => {
          this.progressAvailableResolve = resolve
        })

        if (promises.length > 0) {
          await Promise.race([...promises, progressPromise])
        }
      }
    }

    for (const message of this.getCompletedResults()) {
      yield message
    }
  }

  getUpdatedContext() {
    return this.toolUseContext
  }
}

export const __ToolUseQueueForTests = ToolUseQueue

async function queryWithBinaryFeedback(
  toolUseContext: ExtendedToolUseContext,
  getAssistantResponse: () => Promise<AssistantMessage>,
  getBinaryFeedbackResponse?: (
    m1: AssistantMessage,
    m2: AssistantMessage,
  ) => Promise<BinaryFeedbackResult>,
): Promise<BinaryFeedbackResult> {
  const renderAssistantErrorMessage = (error: unknown): string => {
    const raw =
      error instanceof Error
        ? error.message
        : typeof error === 'string'
          ? error
          : 'Unknown error'

    if (
      /Model pointer 'main' is not configured/i.test(raw) ||
      /No valid ModelProfile available/i.test(raw) ||
      /No models configured/i.test(raw)
    ) {
      return [
        'No model is configured for this session.',
        'Run `/model` and set `main` to one of:',
        '- `gemini-3-flash-preview`',
        '- `gemini-3-pro-preview`',
      ].join('\n')
    }

    return `Request failed: ${raw}`
  }

  const getAssistantResponseSafe = async (): Promise<AssistantMessage> => {
    try {
      return await getAssistantResponse()
    } catch (error) {
      logError(error)
      debugLogger.error('QUERY_LLM_RESPONSE_ERROR', {
        error:
          error instanceof Error
            ? { message: error.message, stack: error.stack }
            : String(error),
        requestId: getCurrentRequest()?.id,
      })
      return createAssistantAPIErrorMessage(renderAssistantErrorMessage(error))
    }
  }

  if (
    process.env.USER_TYPE !== 'ant' ||
    !getBinaryFeedbackResponse ||
    !(await shouldUseBinaryFeedback())
  ) {
    const assistantMessage = await getAssistantResponseSafe()
    if (toolUseContext.abortController.signal.aborted) {
      return { message: null, shouldSkipPermissionCheck: false }
    }
    return { message: assistantMessage, shouldSkipPermissionCheck: false }
  }
  const [m1, m2] = await Promise.all([
    getAssistantResponseSafe(),
    getAssistantResponseSafe(),
  ])
  if (toolUseContext.abortController.signal.aborted) {
    return { message: null, shouldSkipPermissionCheck: false }
  }
  if (m2.isApiErrorMessage) {
    return { message: m1, shouldSkipPermissionCheck: false }
  }
  if (m1.isApiErrorMessage) {
    return { message: m2, shouldSkipPermissionCheck: false }
  }
  if (!messagePairValidForBinaryFeedback(m1, m2)) {
    return { message: m1, shouldSkipPermissionCheck: false }
  }
  return await getBinaryFeedbackResponse(m1, m2)
}

export async function* query(
  messages: Message[],
  systemPrompt: string[],
  context: { [k: string]: string },
  canUseTool: CanUseToolFn,
  toolUseContext: ExtendedToolUseContext,
  getBinaryFeedbackResponse?: (
    m1: AssistantMessage,
    m2: AssistantMessage,
  ) => Promise<BinaryFeedbackResult>,
): AsyncGenerator<Message, void> {
  const reminderStartupKey = getSessionReminderStartupKey(toolUseContext)
  if (!startedSessionReminderKeys.has(reminderStartupKey)) {
    startedSessionReminderKeys.add(reminderStartupKey)
    emitReminderEvent('session:startup', {
      agentId: toolUseContext.agentId,
      context,
      messages: messages.length,
      timestamp: Date.now(),
    })
  }

  const shouldPersistSession =
    toolUseContext.options?.persistSession !== false &&
    process.env.NODE_ENV !== 'test'

  // Persist the last user message that triggered this query (if it's a text message, not a tool result)
  // This ensures user prompts are saved to the session file for resume/undo functionality
  if (shouldPersistSession && messages.length > 0) {
    const lastMessage = messages[messages.length - 1]
    if (
      lastMessage?.type === 'user' &&
      (typeof lastMessage.message.content === 'string' ||
        (Array.isArray(lastMessage.message.content) &&
          lastMessage.message.content.length > 0 &&
          lastMessage.message.content[0]?.type !== 'tool_result'))
    ) {
      appendSessionJsonlFromMessage({ message: lastMessage, toolUseContext })
    }
  }

  for await (const message of queryCore(
    messages,
    systemPrompt,
    context,
    canUseTool,
    toolUseContext,
    getBinaryFeedbackResponse,
  )) {
    if (shouldPersistSession) {
      appendSessionJsonlFromMessage({ message, toolUseContext })
    }
    yield message
  }
}

async function* queryCore(
  messages: Message[],
  systemPrompt: string[],
  context: { [k: string]: string },
  canUseTool: CanUseToolFn,
  toolUseContext: ExtendedToolUseContext,
  getBinaryFeedbackResponse?: (
    m1: AssistantMessage,
    m2: AssistantMessage,
  ) => Promise<BinaryFeedbackResult>,
  hookState?: {
    stopHookActive?: boolean
    stopHookAttempts?: number
    evidenceAutoLoopAttempts?: number
    adkAutoLoopLastActionSignature?: string
    adkAutoLoopLastDecisionKey?: string
    isRecursiveCall?: boolean
  },
): AsyncGenerator<Message, void> {
  const isRecursiveCall = hookState?.isRecursiveCall === true
  if (!isRecursiveCall) {
    setRequestStatus({ kind: 'thinking' })
  }

  try {
    const currentRequest = getCurrentRequest()

    markPhase('QUERY_INIT')
    const stopHookActive = hookState?.stopHookActive === true
    const stopHookAttempts = hookState?.stopHookAttempts ?? 0
    const evidenceAutoLoopAttempts = hookState?.evidenceAutoLoopAttempts ?? 0
    const adkAutoLoopLastActionSignature =
      hookState?.adkAutoLoopLastActionSignature ?? ''
    const adkAutoLoopLastDecisionKey = hookState?.adkAutoLoopLastDecisionKey ?? ''

    const { messages: processedMessages, wasCompacted } =
      await checkAutoCompact(messages, toolUseContext)
    if (wasCompacted) {
      messages = processedMessages
    }

    if (toolUseContext.agentId === 'main') {
      const shell = BunShell.getInstance()

      const notifications = shell.flushBashNotifications()
      for (const notification of notifications) {
        const text = renderBashNotification(notification)
        if (text.trim().length === 0) continue
        const msg = createAssistantMessage(text)
        messages = [...messages, msg]
        yield msg
      }

      const attachments = shell.flushBackgroundShellStatusAttachments()
      for (const attachment of attachments) {
        const text = renderBackgroundShellStatusAttachment(attachment)
        if (text.trim().length === 0) continue
        const msg = createAssistantMessage(
          `<tool-progress>${text}</tool-progress>`,
        )
        messages = [...messages, msg]
        yield msg
      }
    }

    updateHookTranscriptForMessages(toolUseContext, messages)

    {
      const last = messages[messages.length - 1]
      let userPromptText: string | null = null
      if (last && typeof last === 'object' && (last as any).type === 'user') {
        const content = (last as any).message?.content
        if (typeof content === 'string') {
          userPromptText = content
        } else if (Array.isArray(content)) {
          const hasToolResult = content.some(
            (b: any) => b && typeof b === 'object' && b.type === 'tool_result',
          )
          if (!hasToolResult) {
            userPromptText = content
              .filter(
                (b: any) => b && typeof b === 'object' && b.type === 'text',
              )
              .map((b: any) => String(b.text ?? ''))
              .join('')
          }
        }
      }

      if (userPromptText !== null) {
        toolUseContext.options.lastUserPrompt = userPromptText

        const promptOutcome = await runUserPromptSubmitHooks({
          prompt: userPromptText,
          permissionMode: toolUseContext.options?.toolPermissionContext?.mode,
          cwd: getCwd(),
          transcriptPath: getHookTranscriptPath(toolUseContext),
          safeMode: toolUseContext.options?.safeMode ?? false,
          signal: toolUseContext.abortController.signal,
        })

        queueHookSystemMessages(toolUseContext, promptOutcome.systemMessages)
        queueHookAdditionalContexts(
          toolUseContext,
          promptOutcome.additionalContexts,
        )

        if (promptOutcome.decision === 'block') {
          yield createAssistantMessage(promptOutcome.message)
          return
        }
      }
    }

    markPhase('SYSTEM_PROMPT_BUILD')

    hydratePlanSlugFromMessages(messages as any[], toolUseContext)

    const { systemPrompt: fullSystemPrompt, reminders } =
      formatSystemPromptWithContext(
        systemPrompt,
        context,
        toolUseContext.agentId,
      )

    const planModeAdditions = getPlanModeSystemPromptAdditions(
      messages as any[],
      toolUseContext,
    )
    if (planModeAdditions.length > 0) {
      fullSystemPrompt.push(...planModeAdditions)
    }

    const hookAdditions = drainHookSystemPromptAdditions(toolUseContext)
    if (hookAdditions.length > 0) {
      fullSystemPrompt.push(...hookAdditions)
    }

    if (toolUseContext.agentId === 'main') {
      const outputStyleAdditions = getOutputStyleSystemPromptAdditions()
      if (outputStyleAdditions.length > 0) {
        fullSystemPrompt.push(...outputStyleAdditions)
      }
    }

    const turnLanguagePrompt = buildTurnLanguageSystemPrompt(messages)
    if (turnLanguagePrompt) {
      fullSystemPrompt.push(turnLanguagePrompt)
    }

    if (reminders) {
      fullSystemPrompt.push(reminders)
    }

    markPhase('LLM_PREPARATION')

    function getAssistantResponse() {
      return queryLLM(
        normalizeMessagesForAPI(messages),
        fullSystemPrompt,
        toolUseContext.options.maxThinkingTokens,
        toolUseContext.options.tools,
        toolUseContext.abortController.signal,
        {
          safeMode: toolUseContext.options.safeMode ?? false,
          model: toolUseContext.options.model || 'main',
          prependCLISysprompt: true,
          toolUseContext: toolUseContext,
        },
      )
    }

    const result = await queryWithBinaryFeedback(
      toolUseContext,
      getAssistantResponse,
      getBinaryFeedbackResponse,
    )

    if (toolUseContext.abortController.signal.aborted) {
      yield createAssistantMessage(INTERRUPT_MESSAGE)
      return
    }

    if (result.message === null) {
      yield createAssistantMessage(INTERRUPT_MESSAGE)
      return
    }

    let assistantMessage = result.message
    assistantMessage = sanitizeStaleStageRestartNarration(
      assistantMessage,
      messages,
    )
    const shouldSkipPermissionCheck = result.shouldSkipPermissionCheck

    let toolUseMessages =
      assistantMessage.message.content.filter(isToolUseLikeBlock)

    if (!toolUseMessages.length) {
      const enforceHypothesisGates = readBooleanEnv(
        'AMAWTA_ENFORCE_HYPOTHESIS_GATES',
        false,
      )
      if (enforceHypothesisGates) {
        const adkPrimaryMode =
          isAdkPrimaryOrchestrationModeEnabled(toolUseContext)

        if (adkPrimaryMode) {
        const adkAutoLoopMax =
          readPositiveIntEnv('AMAWTA_ADK_PRIMARY_AUTOLOOP_MAX') ?? 4
        const adkAutoLoopHardMax =
          readPositiveIntEnv('AMAWTA_ADK_PRIMARY_AUTOLOOP_HARD_MAX') ??
          adkAutoLoopMax + 4
        const formatAdkAutoRepairProgress = (attempt: number): string => {
          const safeAttempt = Math.max(1, attempt)
          const displayMax =
            safeAttempt <= adkAutoLoopMax ? adkAutoLoopMax : adkAutoLoopHardMax
          const boundedAttempt = Math.min(safeAttempt, displayMax)
          return `${boundedAttempt}/${displayMax}`
        }
        const decisionKey = buildAdkAutoLoopDecisionKey([
          ...messages,
          assistantMessage,
        ])
        const canAttemptAdkLoop = evidenceAutoLoopAttempts < adkAutoLoopMax
        if (canAttemptAdkLoop) {
          const adkDirectedToolUses = buildAdkDirectedAutoLoopToolUses(
            [...messages, assistantMessage],
            toolUseContext,
          )
          if (adkDirectedToolUses.length > 0) {
            const actionSignature =
              buildToolUseActionSignature(adkDirectedToolUses)
            const repeatedWithoutProgress =
              adkAutoLoopLastActionSignature === actionSignature &&
              adkAutoLoopLastDecisionKey === decisionKey
            if (repeatedWithoutProgress) {
              queueHookSystemMessages(toolUseContext, [
                'SYSTEM NOTE: ADK autoloop avoided a duplicate step with unchanged evidence; wait for new evidence or user dataset decision.',
              ])
            } else {
              const shouldIncludeIntroText =
                !hasRenderableAssistantText(assistantMessage)
              assistantMessage = appendToolUsesToAssistantMessage(assistantMessage, {
                introText: shouldIncludeIntroText
                  ? `Auto-repair: executing ADK-directed next step (${formatAdkAutoRepairProgress(
                      evidenceAutoLoopAttempts + 1,
                    )}).`
                  : '',
                toolUses: adkDirectedToolUses,
              })
              toolUseMessages = assistantMessage.message.content.filter(
                isToolUseLikeBlock,
              )
              hookState = {
                ...hookState,
                evidenceAutoLoopAttempts: evidenceAutoLoopAttempts + 1,
                adkAutoLoopLastActionSignature: actionSignature,
                adkAutoLoopLastDecisionKey: decisionKey,
              }
            }
          }
        }

        const gateInstruction = buildHypothesisEvidenceGateInstruction([
          ...messages,
          assistantMessage,
        ])
        if (gateInstruction) {
          queueHookSystemMessages(toolUseContext, [gateInstruction])
        }

        if (toolUseMessages.length === 0 && gateInstruction) {
          const loopSnapshot = computeHypothesisEvidenceSnapshot([
            ...messages,
            assistantMessage,
          ])
          const loopObligation = loopSnapshot.pendingObligations[0]
          const strictObligation = isStrictHypothesisEvidenceObligation(
            loopObligation,
          )
          const canAttemptFallbackLoop =
            evidenceAutoLoopAttempts < adkAutoLoopHardMax &&
            (evidenceAutoLoopAttempts < adkAutoLoopMax || strictObligation)

          if (canAttemptFallbackLoop) {
            const fallbackToolUses = buildHypothesisEvidenceAutoLoopToolUses(
              [...messages, assistantMessage],
              toolUseContext,
            )
            if (fallbackToolUses.length > 0) {
              const actionSignature =
                buildToolUseActionSignature(fallbackToolUses)
              const repeatedWithoutProgress =
                adkAutoLoopLastActionSignature === actionSignature &&
                adkAutoLoopLastDecisionKey === decisionKey
              if (repeatedWithoutProgress) {
                queueHookSystemMessages(toolUseContext, [
                  'SYSTEM NOTE: ADK autoloop avoided a duplicate fallback step with unchanged evidence; waiting for new signals.',
                ])
              } else {
                const shouldIncludeIntroText =
                  !hasRenderableAssistantText(assistantMessage)
                assistantMessage = appendToolUsesToAssistantMessage(assistantMessage, {
                  introText: shouldIncludeIntroText
                    ? evidenceAutoLoopAttempts === 0
                      ? 'Auto-repair: executing mandatory evidence-pipeline steps.'
                      : `Auto-repair: executing evidence-pipeline step (${formatAdkAutoRepairProgress(
                          evidenceAutoLoopAttempts + 1,
                        )}).`
                    : '',
                  toolUses: fallbackToolUses,
                })
                toolUseMessages = assistantMessage.message.content.filter(
                  isToolUseLikeBlock,
                )
                hookState = {
                  ...hookState,
                  evidenceAutoLoopAttempts: evidenceAutoLoopAttempts + 1,
                  adkAutoLoopLastActionSignature: actionSignature,
                  adkAutoLoopLastDecisionKey: decisionKey,
                }
              }
            }
          }
        }

        if (toolUseMessages.length === 0 && gateInstruction) {
          const hardBlockMessage =
            buildHypothesisEvidenceGateHardBlockMessage([
              ...messages,
              assistantMessage,
            ]) ||
            'I cannot close this response: mandatory evidence-pipeline steps are still missing.'
          yield createAssistantMessage(hardBlockMessage)
          return
        }
        } else {
        const gateInstruction = buildHypothesisEvidenceGateInstruction([
          ...messages,
          assistantMessage,
        ])
        if (gateInstruction) {
          queueHookSystemMessages(toolUseContext, [gateInstruction])

          const evidenceAutoLoopEnabled =
            shouldEnableHypothesisEvidenceAutoLoop(toolUseContext)
          const evidenceAutoLoopMax =
            readPositiveIntEnv('AMAWTA_EVIDENCE_AUTOLOOP_MAX') ?? 4
          const evidenceAutoLoopHardMax =
            readPositiveIntEnv('AMAWTA_EVIDENCE_AUTOLOOP_HARD_MAX') ??
            evidenceAutoLoopMax + 4
          const loopSnapshot = computeHypothesisEvidenceSnapshot([
            ...messages,
            assistantMessage,
          ])
          const loopObligation = loopSnapshot.pendingObligations[0]
          const strictObligation = isStrictHypothesisEvidenceObligation(
            loopObligation,
          )
          const canAttemptAutoLoop =
            evidenceAutoLoopEnabled &&
            evidenceAutoLoopAttempts < evidenceAutoLoopHardMax &&
            (evidenceAutoLoopAttempts < evidenceAutoLoopMax || strictObligation)

          if (canAttemptAutoLoop) {
            const toolUses = buildHypothesisEvidenceAutoLoopToolUses(
              [...messages, assistantMessage],
              toolUseContext,
            )
            if (toolUses.length > 0) {
              const shouldIncludeIntroText =
                !hasRenderableAssistantText(assistantMessage)
              assistantMessage = appendToolUsesToAssistantMessage(assistantMessage, {
                introText:
                  shouldIncludeIntroText && evidenceAutoLoopAttempts === 0
                    ? 'Auto-repair: executing mandatory evidence-pipeline steps.'
                    : '',
                toolUses,
              })
              toolUseMessages = assistantMessage.message.content.filter(
                isToolUseLikeBlock,
              )
              hookState = {
                ...hookState,
                evidenceAutoLoopAttempts: evidenceAutoLoopAttempts + 1,
              }
            }
          }

          if (toolUseMessages.length === 0) {
            if (stopHookAttempts < MAX_STOP_HOOK_ATTEMPTS) {
              yield* await queryCore(
                [...messages, assistantMessage],
                systemPrompt,
                context,
                canUseTool,
                toolUseContext,
                getBinaryFeedbackResponse,
                {
                  ...hookState,
                  stopHookActive: true,
                  stopHookAttempts: stopHookAttempts + 1,
                  isRecursiveCall: true,
                },
              )
              return
            }
            const hardBlockMessage =
              buildHypothesisEvidenceGateHardBlockMessage([
                ...messages,
                assistantMessage,
              ]) ||
              'I cannot close this response: mandatory evidence-pipeline steps are still missing.'
            yield createAssistantMessage(hardBlockMessage)
            return
          }
        }
        }
      }
    }

    toolUseMessages = enrichExperimentRunnersToolUsesWithStructuredContext(
      toolUseMessages,
      messages,
    )
    toolUseMessages = orderHypothesisPipelineToolUses(toolUseMessages)

    if (!toolUseMessages.length) {
      if (!hasRenderableAssistantText(assistantMessage)) {
        yield createAssistantMessage(
          'I did not generate a visible response for your last message. Please retry or rephrase briefly.',
        )
        return
      }
      const stopHookEvent =
        toolUseContext.agentId && toolUseContext.agentId !== 'main'
          ? ('SubagentStop' as const)
          : ('Stop' as const)
      const stopReason =
        (assistantMessage.message as any)?.stop_reason ||
        (assistantMessage.message as any)?.stopReason ||
        'end_turn'

      const stopOutcome = await runStopHooks({
        hookEvent: stopHookEvent,
        reason: String(stopReason ?? ''),
        agentId: toolUseContext.agentId,
        permissionMode: toolUseContext.options?.toolPermissionContext?.mode,
        cwd: getCwd(),
        transcriptPath: getHookTranscriptPath(toolUseContext),
        safeMode: toolUseContext.options?.safeMode ?? false,
        stopHookActive,
        signal: toolUseContext.abortController.signal,
      })

      if (stopOutcome.systemMessages.length > 0) {
        queueHookSystemMessages(toolUseContext, stopOutcome.systemMessages)
      }
      if (stopOutcome.additionalContexts.length > 0) {
        queueHookAdditionalContexts(
          toolUseContext,
          stopOutcome.additionalContexts,
        )
      }

      if (stopOutcome.decision === 'block') {
        queueHookSystemMessages(toolUseContext, [stopOutcome.message])
        if (stopHookAttempts < MAX_STOP_HOOK_ATTEMPTS) {
          yield* await queryCore(
            [...messages, assistantMessage],
            systemPrompt,
            context,
            canUseTool,
            toolUseContext,
            getBinaryFeedbackResponse,
            {
              ...hookState,
              stopHookActive: true,
              stopHookAttempts: stopHookAttempts + 1,
              isRecursiveCall: true,
            },
          )
          return
        }
      }

      yield assistantMessage
      return
    }

    yield assistantMessage
    const siblingToolUseIDs = new Set<string>(toolUseMessages.map(_ => _.id))
    const toolQueue = new ToolUseQueue({
      toolDefinitions: toolUseContext.options.tools,
      canUseTool,
      toolUseContext,
      siblingToolUseIDs,
      shouldSkipPermissionCheck,
    })

    for (const toolUse of toolUseMessages) {
      toolQueue.addTool(toolUse, assistantMessage)
    }

    const toolMessagesForNextTurn: (UserMessage | AssistantMessage)[] = []
    for await (const message of toolQueue.getRemainingResults()) {
      yield message
      if (message.type !== 'progress') {
        toolMessagesForNextTurn.push(message as UserMessage | AssistantMessage)
      }
    }

    toolUseContext = toolQueue.getUpdatedContext()

    if (toolUseContext.abortController.signal.aborted) {
      yield createAssistantMessage(INTERRUPT_MESSAGE_FOR_TOOL_USE)
      return
    }

    try {
      yield* await queryCore(
        [...messages, assistantMessage, ...toolMessagesForNextTurn],
        systemPrompt,
        context,
        canUseTool,
        toolUseContext,
        getBinaryFeedbackResponse,
        {
          ...hookState,
          isRecursiveCall: true,
        },
      )
    } catch (error) {
      throw error
    }
  } finally {
    if (!isRecursiveCall) {
      setRequestStatus({ kind: 'idle' })
    }
  }
}

export async function* runToolUse(
  toolUse: ToolUseBlock,
  siblingToolUseIDs: Set<string>,
  assistantMessage: AssistantMessage,
  canUseTool: CanUseToolFn,
  toolUseContext: ExtendedToolUseContext,
  shouldSkipPermissionCheck?: boolean,
): AsyncGenerator<Message, void> {
  const currentRequest = getCurrentRequest()
  const aliasResolution = resolveToolNameAlias(toolUse.name)
  setRequestStatus({ kind: 'tool', detail: aliasResolution.resolvedName })

  debugLogger.flow('TOOL_USE_START', {
    toolName: toolUse.name,
    toolUseID: toolUse.id,
    inputSize: JSON.stringify(toolUse.input).length,
    siblingToolCount: siblingToolUseIDs.size,
    shouldSkipPermissionCheck: !!shouldSkipPermissionCheck,
    requestId: currentRequest?.id,
  })

  logUserFriendly(
    'TOOL_EXECUTION',
    {
      toolName: toolUse.name,
      action: 'Starting',
      target: toolUse.input ? Object.keys(toolUse.input).join(', ') : '',
    },
    currentRequest?.id,
  )

  const toolName = aliasResolution.resolvedName
  const tool = toolUseContext.options.tools.find(t => t.name === toolName)

  if (!tool) {
    debugLogger.error('TOOL_NOT_FOUND', {
      requestedTool: toolName,
      availableTools: toolUseContext.options.tools.map(t => t.name),
      toolUseID: toolUse.id,
      requestId: currentRequest?.id,
    })

    yield createUserMessage([
      {
        type: 'tool_result',
        content: `Error: No such tool available: ${toolName}`,
        is_error: true,
        tool_use_id: toolUse.id,
      },
    ])
    return
  }

  const toolInput = toolUse.input as Record<string, unknown>

  debugLogger.flow('TOOL_VALIDATION_START', {
    toolName: tool.name,
    toolUseID: toolUse.id,
    inputKeys: Object.keys(toolInput),
    requestId: currentRequest?.id,
  })

  try {
    for await (const message of checkPermissionsAndCallTool(
      tool,
      toolUse.id,
      siblingToolUseIDs,
      toolInput,
      toolUseContext,
      canUseTool,
      assistantMessage,
      shouldSkipPermissionCheck,
    )) {
      yield message
    }
  } catch (e) {
    logError(e)

    const errorMessage = createUserMessage([
      {
        type: 'tool_result',
        content: `Tool execution failed: ${e instanceof Error ? e.message : String(e)}`,
        is_error: true,
        tool_use_id: toolUse.id,
      },
    ])
    yield errorMessage
  }
}

export function normalizeToolInput(
  tool: Tool,
  input: Record<string, unknown>,
): Record<string, unknown> {
  switch (tool) {
    case BashTool: {
      const parsed = BashTool.inputSchema.parse(input)
      const {
        command,
        timeout,
        description,
        run_in_background,
        dangerouslyDisableSandbox,
      } = parsed
      return {
        command: command
          .replace(`cd ${getCwd()} && `, '')
          .replace(/\\\\;/g, '\\;'),
        ...(timeout !== undefined ? { timeout } : {}),
        ...(description ? { description } : {}),
        ...(run_in_background ? { run_in_background } : {}),
        ...(dangerouslyDisableSandbox ? { dangerouslyDisableSandbox } : {}),
      }
    }
    default:
      return input
  }
}

function preprocessToolInput(
  tool: Tool,
  input: Record<string, unknown>,
): Record<string, unknown> {
  if (tool.name === 'TaskOutput') {
    const task_id =
      (typeof input.task_id === 'string' && input.task_id) ||
      (typeof (input as any).agentId === 'string' &&
        String((input as any).agentId)) ||
      (typeof (input as any).bash_id === 'string' &&
        String((input as any).bash_id)) ||
      ''

    const block = typeof input.block === 'boolean' ? input.block : true

    const timeout =
      typeof input.timeout === 'number'
        ? input.timeout
        : typeof (input as any).wait_up_to === 'number'
          ? Number((input as any).wait_up_to) * 1000
          : undefined

    return {
      task_id,
      block,
      ...(timeout !== undefined ? { timeout } : {}),
    }
  }

  return input
}

function getToolInputObjectShapeKeys(tool: Tool): Set<string> | null {
  const schemaDef = (tool.inputSchema as any)?._def
  if (!schemaDef) return null

  const rawShape = schemaDef.shape
  const shape =
    typeof rawShape === 'function'
      ? rawShape()
      : rawShape && typeof rawShape === 'object'
        ? rawShape
        : null

  if (!shape || typeof shape !== 'object') return null
  return new Set(Object.keys(shape))
}

function stripUnknownToolInputKeys(
  tool: Tool,
  input: Record<string, unknown>,
): Record<string, unknown> {
  const shapeKeys = getToolInputObjectShapeKeys(tool)
  if (!shapeKeys) return input

  const sanitizedEntries = Object.entries(input).filter(([key]) =>
    shapeKeys.has(key),
  )
  if (sanitizedEntries.length === Object.keys(input).length) return input
  return Object.fromEntries(sanitizedEntries)
}

function injectExperimentRunnersContextFromSession(
  tool: Tool,
  input: Record<string, unknown>,
  context: ToolUseContext,
): Record<string, unknown> {
  if (tool.name !== 'ExperimentRunners') return input
  const options = context.options || {}
  const currentNormalization =
    typeof input.normalization_json === 'string'
      ? input.normalization_json.trim()
      : ''
  const currentFalsification =
    typeof input.falsification_plan_json === 'string'
      ? input.falsification_plan_json.trim()
      : ''
  const currentFalsificationStatus = inferFalsificationPlanReadiness(
    currentFalsification,
  )

  const injectedNormalization =
    typeof options.latestNormalizationJson === 'string'
      ? options.latestNormalizationJson.trim()
      : ''
  const injectedFalsification =
    typeof options.latestFalsificationPlanJson === 'string'
      ? options.latestFalsificationPlanJson.trim()
      : ''
  const injectedFalsificationStatus = inferFalsificationPlanReadiness(
    injectedFalsification,
  )

  if (
    (currentNormalization || !injectedNormalization) &&
    ((currentFalsification || !injectedFalsification) ||
      (currentFalsificationStatus === 'ready' &&
        injectedFalsificationStatus !== 'ready'))
  ) {
    return input
  }

  return {
    ...input,
    ...(!currentNormalization && injectedNormalization
      ? { normalization_json: injectedNormalization }
      : {}),
    ...((!currentFalsification && injectedFalsification) ||
    (currentFalsificationStatus !== 'ready' &&
      injectedFalsificationStatus === 'ready')
      ? { falsification_plan_json: injectedFalsification }
      : {}),
  }
}

function safeParseToolInput(
  tool: Tool,
  input: Record<string, unknown>,
):
  | { success: true; data: Record<string, unknown> }
  | { success: false; error: any } {
  const initial = tool.inputSchema.safeParse(input)
  if (initial.success) {
    return { success: true, data: initial.data as Record<string, unknown> }
  }

  const issues = Array.isArray((initial.error as any)?.issues)
    ? (initial.error as any).issues
    : []
  const hasUnrecognizedKeysIssue = issues.some(
    (issue: any) => issue?.code === 'unrecognized_keys',
  )
  if (!hasUnrecognizedKeysIssue) {
    return { success: false, error: initial.error }
  }

  const sanitizedInput = stripUnknownToolInputKeys(tool, input)
  if (sanitizedInput === input) {
    return { success: false, error: initial.error }
  }

  const recovered = tool.inputSchema.safeParse(sanitizedInput)
  if (recovered.success) {
    return { success: true, data: recovered.data as Record<string, unknown> }
  }
  return { success: false, error: initial.error }
}

async function* checkPermissionsAndCallTool(
  tool: Tool,
  toolUseID: string,
  siblingToolUseIDs: Set<string>,
  input: Record<string, unknown>,
  context: ToolUseContext,
  canUseTool: CanUseToolFn,
  assistantMessage: AssistantMessage,
  shouldSkipPermissionCheck?: boolean,
): AsyncGenerator<Message, void> {
  const preprocessedInput = injectExperimentRunnersContextFromSession(
    tool,
    preprocessToolInput(tool, input),
    context,
  )
  const isValidInput = safeParseToolInput(tool, preprocessedInput)
  if (!isValidInput.success) {
    const parseError = 'error' in isValidInput ? isValidInput.error : null
    let errorMessage = `InputValidationError: ${parseError?.message ?? 'Invalid input'}`

    if (tool.name === 'Read' && Object.keys(preprocessedInput).length === 0) {
      errorMessage = `Error: The Read tool requires a 'file_path' parameter to specify which file to read. Please provide the absolute path to the file you want to read. For example: {"file_path": "/path/to/file.txt"}`
    }

    yield createUserMessage([
      {
        type: 'tool_result',
        content: errorMessage,
        is_error: true,
        tool_use_id: toolUseID,
      },
    ])
    return
  }

  let normalizedInput = normalizeToolInput(tool, isValidInput.data)

  const isValidCall = await tool.validateInput?.(
    normalizedInput as never,
    context,
  )
  if (isValidCall?.result === false) {
    yield createUserMessage([
      {
        type: 'tool_result',
        content: isValidCall!.message,
        is_error: true,
        tool_use_id: toolUseID,
      },
    ])
    return
  }

  const hookOutcome = await runPreToolUseHooks({
    toolName: tool.name,
    toolInput: normalizedInput,
    toolUseId: toolUseID,
    permissionMode: context.options?.toolPermissionContext?.mode,
    cwd: getCwd(),
    transcriptPath: getHookTranscriptPath(context),
    safeMode: context.options?.safeMode ?? false,
    signal: context.abortController.signal,
  })
  if (hookOutcome.kind === 'block') {
    yield createUserMessage([
      {
        type: 'tool_result',
        content: hookOutcome.message,
        is_error: true,
        tool_use_id: toolUseID,
      },
    ])
    return
  }
  if (hookOutcome.warnings.length > 0) {
    const warningText = hookOutcome.warnings.join('\n')
    yield createProgressMessage(
      toolUseID,
      siblingToolUseIDs,
      createAssistantMessage(warningText),
      [],
      context.options?.tools ?? [],
    )
  }

  if (hookOutcome.systemMessages && hookOutcome.systemMessages.length > 0) {
    queueHookSystemMessages(context, hookOutcome.systemMessages)
  }
  if (
    hookOutcome.additionalContexts &&
    hookOutcome.additionalContexts.length > 0
  ) {
    queueHookAdditionalContexts(context, hookOutcome.additionalContexts)
  }

  if (hookOutcome.updatedInput) {
    const merged = { ...normalizedInput, ...hookOutcome.updatedInput }
    const parsed = safeParseToolInput(tool, merged)
    if (!parsed.success) {
      const parseError = 'error' in parsed ? parsed.error : null
      yield createUserMessage([
        {
          type: 'tool_result',
          content: `Hook updatedInput failed validation: ${parseError?.message ?? 'Invalid input'}`,
          is_error: true,
          tool_use_id: toolUseID,
        },
      ])
      return
    }
    normalizedInput = normalizeToolInput(tool, parsed.data)
    const isValidUpdate = await tool.validateInput?.(
      normalizedInput as never,
      context,
    )
    if (isValidUpdate?.result === false) {
      yield createUserMessage([
        {
          type: 'tool_result',
          content: isValidUpdate.message,
          is_error: true,
          tool_use_id: toolUseID,
        },
      ])
      return
    }
  }

  const hookPermissionDecision =
    hookOutcome.kind === 'allow' ? hookOutcome.permissionDecision : undefined

  const effectiveShouldSkipPermissionCheck =
    hookPermissionDecision === 'allow'
      ? true
      : hookPermissionDecision === 'ask'
        ? false
        : shouldSkipPermissionCheck

  const permissionContextForCall =
    hookPermissionDecision === 'ask' &&
    context.options?.toolPermissionContext &&
    context.options.toolPermissionContext.mode !== 'default'
      ? ({
          ...context,
          options: {
            ...context.options,
            toolPermissionContext: {
              ...context.options.toolPermissionContext,
              mode: 'default',
            },
          },
        } as const)
      : context

  const permissionResult = effectiveShouldSkipPermissionCheck
    ? ({ result: true } as const)
    : await canUseTool(
        tool,
        normalizedInput,
        { ...permissionContextForCall, toolUseId: toolUseID },
        assistantMessage,
      )
  if (permissionResult.result === false) {
    yield createUserMessage([
      {
        type: 'tool_result',
        content: permissionResult.message,
        is_error: true,
        tool_use_id: toolUseID,
      },
    ])
    return
  }

  const shouldNarratePipelineProgress = shouldEmitPipelineLifecycleProgress(
    tool.name,
    context,
  )
  if (shouldNarratePipelineProgress) {
    const lifecycleStart = buildPipelineToolStartProgress(tool.name, normalizedInput)
    yield createProgressMessage(
      toolUseID,
      siblingToolUseIDs,
      createAssistantMessage(`<tool-progress>${lifecycleStart}</tool-progress>`),
      [],
      context.options?.tools ?? [],
      { persistHistory: true },
    )

    const lifecycleDoing = buildPipelineToolDoingProgress(tool.name)
    yield createProgressMessage(
      toolUseID,
      siblingToolUseIDs,
      createAssistantMessage(`<tool-progress>${lifecycleDoing}</tool-progress>`),
      [],
      context.options?.tools ?? [],
      { persistHistory: true },
    )
  }

  try {
    const generator = tool.call(normalizedInput as never, {
      ...context,
      toolUseId: toolUseID,
    })
    for await (const result of generator) {
      switch (result.type) {
        case 'result':
          {
            const content =
              result.resultForAssistant ??
              tool.renderResultForAssistant(result.data as never)

            const postOutcome = await runPostToolUseHooks({
              toolName: tool.name,
              toolInput: normalizedInput,
              toolResult: result.data,
              toolUseId: toolUseID,
              permissionMode: context.options?.toolPermissionContext?.mode,
              cwd: getCwd(),
              transcriptPath: getHookTranscriptPath(context),
              safeMode: context.options?.safeMode ?? false,
              signal: context.abortController.signal,
            })
            if (postOutcome.systemMessages.length > 0) {
              queueHookSystemMessages(context, postOutcome.systemMessages)
            }
            if (postOutcome.additionalContexts.length > 0) {
              queueHookAdditionalContexts(
                context,
                postOutcome.additionalContexts,
              )
            }
            if (postOutcome.warnings.length > 0) {
              const warningText = postOutcome.warnings.join('\n')
              yield createProgressMessage(
                toolUseID,
                siblingToolUseIDs,
                createAssistantMessage(warningText),
                [],
                context.options?.tools ?? [],
              )
            }

            yield createUserMessage(
              [
                {
                  type: 'tool_result',
                  content: content as any,
                  tool_use_id: toolUseID,
                },
              ],
              {
                data: result.data,
                resultForAssistant: content as any,
                toolName: tool.name,
                stage: inferHypothesisStageFromToolName(tool.name),
                visibility: inferToolResultVisibility(tool.name, context),
                evidence: inferToolResultEvidence(tool.name, result.data),
                ...(Array.isArray(result.newMessages)
                  ? { newMessages: result.newMessages as any }
                  : {}),
                ...(result.contextModifier
                  ? { contextModifier: result.contextModifier as any }
                  : {}),
              },
            )

            if (shouldNarratePipelineProgress) {
              const lifecycleDone = buildPipelineToolCompletionProgress(
                tool.name,
                result.data,
              )
              yield createProgressMessage(
                toolUseID,
                siblingToolUseIDs,
                createAssistantMessage(
                  `<tool-progress>${lifecycleDone}</tool-progress>`,
                ),
                [],
                context.options?.tools ?? [],
                { persistHistory: true },
              )
            }

            if (Array.isArray(result.newMessages)) {
              for (const message of result.newMessages) {
                if (
                  message &&
                  typeof message === 'object' &&
                  'type' in (message as any)
                ) {
                  yield message as any
                }
              }
            }
          }
          return
        case 'progress':
          yield createProgressMessage(
            toolUseID,
            siblingToolUseIDs,
            result.content,
            result.normalizedMessages || [],
            result.tools || [],
            { persistHistory: result.persistHistory === true },
          )
          break
      }
    }
  } catch (error) {
    const content = formatError(error)
    logError(error)

    if (shouldNarratePipelineProgress) {
      const failureText = `Done: ${tool.name} failed during execution. Next: inspect error and auto-repair.`
      yield createProgressMessage(
        toolUseID,
        siblingToolUseIDs,
        createAssistantMessage(`<tool-progress>${failureText}</tool-progress>`),
        [],
        context.options?.tools ?? [],
        { persistHistory: true },
      )
    }

    yield createUserMessage([
      {
        type: 'tool_result',
        content,
        is_error: true,
        tool_use_id: toolUseID,
      },
    ])
  }
}

function formatError(error: unknown): string {
  if (!(error instanceof Error)) {
    return String(error)
  }
  const parts = [error.message]
  if ('stderr' in error && typeof error.stderr === 'string') {
    parts.push(error.stderr)
  }
  if ('stdout' in error && typeof error.stdout === 'string') {
    parts.push(error.stdout)
  }
  const fullMessage = parts.filter(Boolean).join('\n')
  if (fullMessage.length <= 10000) {
    return fullMessage
  }
  const halfLength = 5000
  const start = fullMessage.slice(0, halfLength)
  const end = fullMessage.slice(-halfLength)
  return `${start}\n\n... [${fullMessage.length - 10000} characters truncated] ...\n\n${end}`
}

export const __queryTestOnly = {
  buildHypothesisEvidenceGateInstruction,
  buildHypothesisEvidenceGateHardBlockMessage,
  buildTurnLanguageSystemPrompt,
  detectPreferredTurnResponseLanguage,
  shouldEmitPipelineLifecycleProgress,
  buildPipelineToolStartProgress,
  buildPipelineToolDoingProgress,
  buildPipelineToolFallbackNextAction,
  buildPipelineToolCompletionProgress,
  computeHypothesisEvidenceSnapshot,
  inferHypothesisStageFromToolName,
  inferToolResultVisibility,
  inferToolResultEvidence,
  inferLastCompletedHypothesisStage,
  sanitizeStaleStageRestartNarration,
  isStrictHypothesisEvidenceObligation,
  stripUnknownToolInputKeys,
  safeParseToolInput,
}
