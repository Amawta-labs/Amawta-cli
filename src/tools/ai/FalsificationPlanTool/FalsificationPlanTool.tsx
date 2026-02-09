import React from 'react'
import { Box, Text } from 'ink'
import { z } from 'zod'
import { createHash } from 'crypto'
import { existsSync, readFileSync } from 'fs'
import { resolve } from 'path'
import { FallbackToolUseRejectedMessage } from '@components/FallbackToolUseRejectedMessage'
import { Tool, ToolUseContext } from '@tool'
import { getModelManager } from '@utils/model'
import { getTheme } from '@utils/theme'
import { createAssistantMessage } from '@utils/messages'
import {
  runFalsificationAgent,
} from '@services/ai/agents'
import type { FalsificationPlanResult } from '@services/ai/types/adkDialectic'
import { DESCRIPTION, PROMPT, TOOL_NAME } from './prompt'

const inputSchema = z.strictObject({
  hypothesis_query: z
    .string()
    .min(8)
    .describe('Current hypothesis to falsify'),
  dialectical_synthesis: z
    .string()
    .optional()
    .describe('Dialectical synthesis (alias fallback for hypothesis_cleaned)'),
  hypothesis_cleaned: z
    .string()
    .optional()
    .describe('Cleaned/normalized hypothesis'),
  veritas_form_json: z
    .string()
    .optional()
    .describe('Veritas form JSON or text'),
  baconian_forma_veritas: z
    .string()
    .optional()
    .describe('Alias fallback for veritas form text'),
  normalization_json: z
    .string()
    .optional()
    .describe('Normalization JSON or text'),
  literature_search_json: z
    .string()
    .optional()
    .describe('Literature search JSON or text'),
  literature_extract_json: z
    .string()
    .optional()
    .describe('Literature extract JSON or text'),
  invariants_catalog_md: z
    .string()
    .optional()
    .describe('Invariants catalog markdown'),
  catalog_sha256: z
    .string()
    .optional()
    .describe('Catalog checksum sha256'),
  normalization_ok: z
    .boolean()
    .optional()
    .describe('True if core normalization is complete'),
  missing_fields: z
    .array(z.string())
    .optional()
    .describe('Missing core fields list'),
})

type Input = z.infer<typeof inputSchema>

type Output = {
  analysis: string
  retriesUsed: number
  model: string
  planStatus: 'ready' | 'skipped'
  testsCount: number
  variantsCount: number
  matchStatus: 'ready' | 'skipped'
  overallMatch: 'none' | 'weak' | 'moderate' | 'strong'
  nextAction: string
  normalizedClaim: string
  plan: FalsificationPlanResult
}

type CachedFalsificationResult = {
  output: Output
  createdAt: number
}

const recentFalsificationResultCache = new Map<string, CachedFalsificationResult>()
const inFlightFalsificationRuns = new Map<string, Promise<Output>>()
const inFlightFalsificationRunsByTurn = new Map<string, Promise<Output>>()
const turnScopedFalsificationResultCache = new Map<
  string,
  CachedFalsificationResult
>()
const FALSIFICATION_CACHE_TTL_MS = 30_000
const FALSIFICATION_TURN_CACHE_TTL_MS = 5 * 60_000
const DEFAULT_INVARIANTS_CATALOG_PATH = 'docs/science/INVARIANTS_TABLE.md'

function normalizeInline(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

function truncateForUi(text: string, max = 120): string {
  const normalized = normalizeInline(text)
  if (normalized.length <= max) return normalized
  return `${normalized.slice(0, max - 3)}...`
}

function buildFalsificationContextModifier(output: Output) {
  const falsificationPlanJson = JSON.stringify(output.plan)
  return {
    modifyContext: (ctx: ToolUseContext): ToolUseContext => ({
      ...ctx,
      options: {
        ...(ctx.options || {}),
        latestFalsificationPlanJson: falsificationPlanJson,
      },
    }),
  }
}

function getReadableMutedColor(): string {
  const theme = getTheme()
  return theme.text === '#fff' ? '#b8b8b8' : '#555'
}

function buildToolConversationKey(context: ToolUseContext): string {
  return `${context.options?.messageLogName ?? 'default'}:${context.options?.forkNumber ?? 0}:${context.agentId ?? 'main'}`
}

function resolveToolTurnKey(context: ToolUseContext): string {
  const messageTurn = context.messageId?.trim()
  if (messageTurn) return `msg:${messageTurn}`
  const lastUserPrompt = context.options?.lastUserPrompt?.trim()
  if (lastUserPrompt) {
    const fingerprint = createHash('sha1')
      .update(normalizeInline(lastUserPrompt).toLowerCase())
      .digest('hex')
      .slice(0, 12)
    return `prompt:${fingerprint}`
  }
  const requestTurn = (context as any)?.requestId
  if (typeof requestTurn === 'string' && requestTurn.trim().length > 0) {
    return `req:${requestTurn.trim()}`
  }
  return 'conversation-turn-fallback'
}

function buildFalsificationCacheKey(
  input: Input,
  context: ToolUseContext,
  options?: { modelName?: string; catalogShaOverride?: string },
): string {
  const conversationKey = buildToolConversationKey(context)
  const catalogSha =
    options?.catalogShaOverride?.trim() || input.catalog_sha256 || ''
  const modelName =
    options?.modelName?.trim() || context.options?.model?.trim() || ''
  const normalizedPrompt = normalizeInline(
    [
      input.hypothesis_query,
      input.dialectical_synthesis ?? '',
      input.hypothesis_cleaned ?? '',
      input.veritas_form_json ?? '',
      input.baconian_forma_veritas ?? '',
      input.normalization_json ?? '',
      input.literature_search_json ?? '',
      input.literature_extract_json ?? '',
      input.invariants_catalog_md ?? '',
      catalogSha,
      modelName,
      input.normalization_ok === true ? 'true' : 'false',
      (input.missing_fields ?? []).join(','),
    ].join(' | '),
  )
    .toLowerCase()
    .slice(0, 5000)

  return `${conversationKey}::${normalizedPrompt}`
}

function pruneFalsificationCache(now = Date.now()): void {
  for (const [key, value] of recentFalsificationResultCache.entries()) {
    if (now - value.createdAt > FALSIFICATION_CACHE_TTL_MS) {
      recentFalsificationResultCache.delete(key)
    }
  }
}

function buildTurnScopedFalsificationKey(
  input: Input,
  context: ToolUseContext,
): string {
  const conversationKey = buildToolConversationKey(context)
  const turnKey = resolveToolTurnKey(context)
  return `${conversationKey}::${turnKey}`
}

function pruneTurnScopedFalsificationCache(now = Date.now()): void {
  for (const [key, value] of turnScopedFalsificationResultCache.entries()) {
    if (now - value.createdAt > FALSIFICATION_TURN_CACHE_TTL_MS) {
      turnScopedFalsificationResultCache.delete(key)
    }
  }
}

function isNormalizationReadyInput(input: Input): boolean {
  const missingFields = Array.isArray(input.missing_fields)
    ? input.missing_fields
    : []
  return input.normalization_ok === true && missingFields.length === 0
}

function shouldReuseFalsificationCachedOutput(
  output: Output,
  input: Input,
): boolean {
  if (output.planStatus === 'ready') return true
  return !isNormalizationReadyInput(input)
}

function choosePreferredFalsificationCachedOutput(params: {
  cachedOutput: Output
  input: Input
}): Output | null {
  const { cachedOutput, input } = params
  if (shouldReuseFalsificationCachedOutput(cachedOutput, input)) return cachedOutput
  return null
}

export function getReadyFalsificationResultForTurn(params: {
  context: ToolUseContext
  hypothesisQuery: string
}): Output | null {
  const input = {
    hypothesis_query: params.hypothesisQuery,
  } as Input
  const now = Date.now()
  pruneTurnScopedFalsificationCache(now)
  const key = buildTurnScopedFalsificationKey(input, params.context)
  const cached = turnScopedFalsificationResultCache.get(key)
  if (!cached) return null
  if (now - cached.createdAt > FALSIFICATION_TURN_CACHE_TTL_MS) {
    turnScopedFalsificationResultCache.delete(key)
    return null
  }
  return cached.output.planStatus === 'ready' ? cached.output : null
}

export async function waitForReadyFalsificationResultForTurn(params: {
  context: ToolUseContext
  hypothesisQuery: string
  signal?: AbortSignal
  timeoutMs?: number
}): Promise<Output | null> {
  const immediate = getReadyFalsificationResultForTurn({
    context: params.context,
    hypothesisQuery: params.hypothesisQuery,
  })
  if (immediate) return immediate

  const input = {
    hypothesis_query: params.hypothesisQuery,
  } as Input
  const turnKey = buildTurnScopedFalsificationKey(input, params.context)
  const inFlight = inFlightFalsificationRunsByTurn.get(turnKey)
  if (!inFlight) return null

  const timeoutMs = Number.isFinite(params.timeoutMs)
    ? Math.max(250, Number(params.timeoutMs))
    : 20_000

  const timeoutPromise = new Promise<null>(resolve => {
    setTimeout(() => resolve(null), timeoutMs)
  })
  const abortPromise = params.signal
    ? new Promise<null>(resolve => {
        if (params.signal?.aborted) {
          resolve(null)
          return
        }
        params.signal?.addEventListener('abort', () => resolve(null), {
          once: true,
        })
      })
    : null

  const settled = await Promise.race([
    inFlight
      .then(output => output)
      .catch(() => null as Output | null),
    timeoutPromise,
    ...(abortPromise ? [abortPromise] : []),
  ])

  if (settled && settled.planStatus === 'ready') {
    return settled
  }

  return getReadyFalsificationResultForTurn({
    context: params.context,
    hypothesisQuery: params.hypothesisQuery,
  })
}

type LoadedInvariantsCatalog = {
  markdown: string
  sha256: string
  path: string
}

function loadDefaultInvariantsCatalog(): LoadedInvariantsCatalog | null {
  const absolutePath = resolve(process.cwd(), DEFAULT_INVARIANTS_CATALOG_PATH)
  if (!existsSync(absolutePath)) {
    return null
  }

  const markdown = readFileSync(absolutePath, 'utf8').trim()
  if (!markdown) return null

  const sha256 = createHash('sha256').update(markdown).digest('hex')
  return {
    markdown,
    sha256,
    path: absolutePath,
  }
}

async function runAndBuildFalsificationOutput(params: {
  modelName: string
  apiKey?: string
  input: Input
  conversationKey: string
  signal: AbortSignal
}): Promise<Output> {
  const fallbackCatalog = loadDefaultInvariantsCatalog()
  const explicitCatalogMd = params.input.invariants_catalog_md?.trim()
  const explicitCatalogSha = params.input.catalog_sha256?.trim()
  const catalogMd =
    explicitCatalogMd && explicitCatalogMd.length > 0
      ? explicitCatalogMd
      : fallbackCatalog?.markdown
  const catalogSha =
    explicitCatalogSha && explicitCatalogSha.length > 0
      ? explicitCatalogSha
      : fallbackCatalog?.sha256
  const cleanedHypothesis =
    params.input.hypothesis_cleaned?.trim() ||
    params.input.dialectical_synthesis?.trim() ||
    undefined
  const veritasForm =
    params.input.veritas_form_json?.trim() ||
    params.input.baconian_forma_veritas?.trim() ||
    undefined

  const run = await runFalsificationAgent({
    modelName: params.modelName,
    apiKey: params.apiKey,
    conversationKey: params.conversationKey,
    signal: params.signal,
    maxRetries: 2,
    hypothesisInput: params.input.hypothesis_query,
    hypothesisCleaned: cleanedHypothesis,
    veritasFormRaw: veritasForm,
    normalizationRaw: params.input.normalization_json,
    literatureSearchRaw: params.input.literature_search_json,
    literatureExtractRaw: params.input.literature_extract_json,
    invariantsCatalogMd: catalogMd,
    catalogSha256: catalogSha,
    normalizationOk: params.input.normalization_ok,
    missingFields: params.input.missing_fields,
  })

  if (!run.falsification) {
    throw new Error('Falsification subagent did not return structured output.')
  }

  const plan = run.falsification.falsification_plan
  const invariantSummary = run.falsification.invariants_match

  return {
    analysis: run.text,
    retriesUsed: run.retriesUsed,
    model: params.modelName,
    planStatus: plan.meta.status,
    testsCount: plan.tests.length,
    variantsCount: plan.test_matrix.variants.length,
    matchStatus: invariantSummary.meta.status,
    overallMatch: invariantSummary.overall.match_strength,
    nextAction: invariantSummary.overall.next_action,
    normalizedClaim: plan.normalized_claim.claim,
    plan: run.falsification,
  }
}

export const FalsificationPlanTool = {
  name: TOOL_NAME,
  async description() {
    return DESCRIPTION
  },
  userFacingName: () => 'Falsification plan',
  inputSchema,
  async prompt() {
    return PROMPT
  },
  async isEnabled() {
    return true
  },
  isReadOnly() {
    return true
  },
  isConcurrencySafe() {
    return false
  },
  needsPermissions() {
    return false
  },
  async validateInput(input: Input) {
    if (!input.hypothesis_query || input.hypothesis_query.trim().length < 8) {
      return {
        result: false,
        message: 'hypothesis_query is required and must be at least 8 chars',
      }
    }
    return { result: true }
  },
  renderToolUseMessage(input: Input) {
    const preview = truncateForUi(input.hypothesis_query, 110)
    return `I will run the falsification subagent for: ${preview}`
  },
  renderToolUseRejectedMessage() {
    return <FallbackToolUseRejectedMessage />
  },
  renderToolResultMessage(output: Output) {
    const mutedColor = getReadableMutedColor()
    return (
      <Box flexDirection="column">
        <Box flexDirection="row">
          <Text color={mutedColor}>&nbsp;&nbsp;⎿ &nbsp;Falsification plan complete </Text>
          <Text color={mutedColor}>
            ({output.model}
            {output.retriesUsed > 0 ? ` · retries ${output.retriesUsed}` : ''})
          </Text>
        </Box>
        <Text color={mutedColor}>{`     Status plan/match: ${output.planStatus} / ${output.matchStatus}`}</Text>
        <Text color={mutedColor}>{`     Tests/variants: ${output.testsCount} / ${output.variantsCount}`}</Text>
        <Text color={mutedColor}>{`     Overall match: ${output.overallMatch}`}</Text>
        <Text color={mutedColor}>{`     Next action: ${truncateForUi(output.nextAction, 90)}`}</Text>
      </Box>
    )
  },
  renderResultForAssistant(output: Output) {
    const plan = output.plan.falsification_plan
    const invariants = output.plan.invariants_match
    const falsificationPlanJson = JSON.stringify(output.plan)
    const testsPreview = plan.tests.slice(0, 5).map(test => `${test.id}: ${test.goal}`)
    const skippedByNormalization =
      plan.meta.status === 'skipped' &&
      normalizeInline(plan.meta.reason ?? '') === 'normalization_incomplete'

    const lines = [
      'Falsification result (brief):',
      `Normalized claim: ${output.normalizedClaim}`,
      `Plan status: ${output.planStatus}`,
      `Invariants status: ${output.matchStatus}`,
      `Tests: ${output.testsCount}`,
      `Variants: ${output.variantsCount}`,
      `Overall match: ${output.overallMatch}`,
      `Next action: ${output.nextAction}`,
      'Key tests:',
      ...(testsPreview.length > 0 ? testsPreview.map(t => `- ${t}`) : ['- (no tests)']),
      `Data requests: ${plan.data_requests.length}`,
      `Invariants matches: ${invariants.matches.length}`,
      'Do not invoke FalsificationPlan again for this same hypothesis in this turn; reuse this result.',
    ]

    if (skippedByNormalization) {
      lines.push(
        'FalsificationPlan was skipped due to incomplete normalization.',
        'Mandatory next step: invoke HypothesisNormalization, close missing fields with AskUserQuestion when applicable, then retry FalsificationPlan.',
        `falsification_plan_json=${falsificationPlanJson}`,
      )
    } else {
      lines.push(
        'Immediate mandatory step: call ExperimentRunners now (once) using this plan; do not close the final response yet.',
        'Do not replace this action with narrative like "I will proceed/generate runners": you must invoke the ExperimentRunners tool.',
        'When calling ExperimentRunners, pass the JSON payloads exactly as input fields:',
        '- input.falsification_plan_json = the value after "falsification_plan_json="',
        '- input.normalization_json = the latest value after "normalization_json=" from HypothesisNormalization result',
        'User response: summarize current plausibility and clarify that this plan defines refutation routes (not definitive confirmation).',
        'Calibrated wording: use "suggests", "makes plausible", "requires evidence".',
        `falsification_plan_json=${falsificationPlanJson}`,
      )
    }

    return lines.join('\n')
  },
  async *call(input: Input, context: ToolUseContext) {
    const modelManager = getModelManager()
    const modelProfile = modelManager.getModel('main')

    if (!modelProfile || !modelProfile.modelName) {
      throw new Error(
        'No model configured. Configure a model first with /model command.',
      )
    }

    const fallbackCatalog = loadDefaultInvariantsCatalog()
    const effectiveCatalogSha =
      input.catalog_sha256?.trim() || fallbackCatalog?.sha256 || ''
    const conversationKey = buildToolConversationKey(context)
    const cacheKey = buildFalsificationCacheKey(input, context, {
      modelName: modelProfile.modelName,
      catalogShaOverride: effectiveCatalogSha,
    })
    const turnScopedKey = buildTurnScopedFalsificationKey(input, context)
    pruneFalsificationCache()
    pruneTurnScopedFalsificationCache()

    const turnScopedCached = turnScopedFalsificationResultCache.get(turnScopedKey)
    if (
      turnScopedCached &&
      Date.now() - turnScopedCached.createdAt <= FALSIFICATION_TURN_CACHE_TTL_MS
    ) {
      const preferred = choosePreferredFalsificationCachedOutput({
        cachedOutput: turnScopedCached.output,
        input,
      })
      if (preferred) {
        yield {
          type: 'progress',
          content: createAssistantMessage(
            'FalsificationPlan was already executed in this turn for this same hypothesis; reusing result.',
          ),
        }
        yield {
          type: 'result' as const,
          data: preferred,
          resultForAssistant: this.renderResultForAssistant(preferred),
          contextModifier: buildFalsificationContextModifier(preferred),
        }
        return
      }
    }

    const cached = recentFalsificationResultCache.get(cacheKey)
    if (cached && Date.now() - cached.createdAt <= FALSIFICATION_CACHE_TTL_MS) {
      const preferred = choosePreferredFalsificationCachedOutput({
        cachedOutput: cached.output,
        input,
      })
      if (preferred) {
        yield {
          type: 'progress',
          content: createAssistantMessage(
            'Reusing recent falsification plan for this same hypothesis.',
          ),
        }
        yield {
          type: 'result' as const,
          data: preferred,
          resultForAssistant: this.renderResultForAssistant(preferred),
          contextModifier: buildFalsificationContextModifier(preferred),
        }
        return
      }
    }

    const existingRun = inFlightFalsificationRuns.get(cacheKey)
    if (existingRun) {
      yield {
        type: 'progress',
        content: createAssistantMessage(
          'Waiting for result from a falsification run already in progress.',
        ),
      }
      const output = await existingRun
      yield {
        type: 'result' as const,
        data: output,
        resultForAssistant: this.renderResultForAssistant(output),
        contextModifier: buildFalsificationContextModifier(output),
      }
      return
    }

    const existingRunByTurn = inFlightFalsificationRunsByTurn.get(turnScopedKey)
    if (existingRunByTurn) {
      yield {
        type: 'progress',
        content: createAssistantMessage(
          'Waiting for falsification result already in progress for this same turn.',
        ),
      }
      const output = await existingRunByTurn
      yield {
        type: 'result' as const,
        data: output,
        resultForAssistant: this.renderResultForAssistant(output),
        contextModifier: buildFalsificationContextModifier(output),
      }
      return
    }

    const runPromise = runAndBuildFalsificationOutput({
      modelName: modelProfile.modelName,
      apiKey: modelProfile.apiKey?.trim() || undefined,
      input,
      conversationKey,
      signal: context.abortController.signal,
    })
    inFlightFalsificationRuns.set(cacheKey, runPromise)
    inFlightFalsificationRunsByTurn.set(turnScopedKey, runPromise)

    let output: Output
    try {
      yield {
        type: 'progress',
        content: createAssistantMessage(
          'Running falsification subagent (tests -> variants -> invariants)...',
        ),
      }
      output = await runPromise
    } finally {
      if (inFlightFalsificationRuns.get(cacheKey) === runPromise) {
        inFlightFalsificationRuns.delete(cacheKey)
      }
      if (inFlightFalsificationRunsByTurn.get(turnScopedKey) === runPromise) {
        inFlightFalsificationRunsByTurn.delete(turnScopedKey)
      }
    }

    const existingTurnReady =
      turnScopedFalsificationResultCache.get(turnScopedKey)?.output
    if (
      existingTurnReady?.planStatus === 'ready' &&
      output.planStatus !== 'ready'
    ) {
      output = existingTurnReady
      yield {
        type: 'progress',
        content: createAssistantMessage(
          'Auto-correction: preserving ready falsification result for this turn; ignoring non-ready regression.',
        ),
      }
    }

    recentFalsificationResultCache.set(cacheKey, {
      output,
      createdAt: Date.now(),
    })
    turnScopedFalsificationResultCache.set(turnScopedKey, {
      output,
      createdAt: Date.now(),
    })

    yield {
      type: 'result' as const,
      data: output,
      resultForAssistant: this.renderResultForAssistant(output),
      contextModifier: buildFalsificationContextModifier(output),
    }
  },
} satisfies Tool<typeof inputSchema, Output>

export const __testOnly = {
  truncateForUi,
  buildFalsificationCacheKey,
  buildTurnScopedFalsificationKey,
  clearCachesForTest: () => {
    recentFalsificationResultCache.clear()
    inFlightFalsificationRuns.clear()
    inFlightFalsificationRunsByTurn.clear()
    turnScopedFalsificationResultCache.clear()
  },
  setTurnScopedResultForTest: (
    input: Input,
    context: ToolUseContext,
    output: Output,
    createdAt = Date.now(),
  ) => {
    const key = buildTurnScopedFalsificationKey(input, context)
    turnScopedFalsificationResultCache.set(key, { output, createdAt })
  },
  setConversationScopedResultForTest: (
    cacheKey: string,
    output: Output,
    createdAt = Date.now(),
  ) => {
    recentFalsificationResultCache.set(cacheKey, { output, createdAt })
  },
  isNormalizationReadyInput,
  shouldReuseFalsificationCachedOutput,
  choosePreferredFalsificationCachedOutput,
}
