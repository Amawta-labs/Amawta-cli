import React from 'react'
import { Box, Text } from 'ink'
import { z } from 'zod'
import { FallbackToolUseRejectedMessage } from '@components/FallbackToolUseRejectedMessage'
import { Tool, ToolUseContext } from '@tool'
import { getModelManager } from '@utils/model'
import { getTheme } from '@utils/theme'
import { createAssistantMessage } from '@utils/messages'
import {
  runNormalizationAgent,
} from '@services/ai/agents'
import type { HypothesisNormalizationResult } from '@services/ai/types/adkDialectic'
import { DESCRIPTION, PROMPT, TOOL_NAME } from './prompt'

const inputSchema = z.strictObject({
  hypothesis_query: z
    .string()
    .min(8)
    .describe('Hypothesis to normalize into structured claim fields'),
  dialectical_synthesis: z
    .string()
    .optional()
    .describe('Dialectical synthesis (recommended)'),
  baconian_forma_veritas: z
    .string()
    .optional()
    .describe('Baconian forma veritas (recommended)'),
  literature_summary: z
    .string()
    .optional()
    .describe('Optional literature summary to ground normalization'),
})

type Input = z.infer<typeof inputSchema>

type Output = {
  analysis: string
  model: string
  retriesUsed: number
  strictRetriesUsed: number
  autoRetriesUsed: number
  modeUsed: 'strict' | 'autocorrect'
  autoCorrectionAttempted: boolean
  autoCorrectionImproved: boolean
  normalizationOk: boolean
  criticalMissingFields: string[]
  normalization: HypothesisNormalizationResult['hypothesis_normalization']
}

type CachedNormalizationResult = {
  output: Output
  createdAt: number
}

const recentNormalizationCache = new Map<string, CachedNormalizationResult>()
const inFlightNormalizationRuns = new Map<string, Promise<Output>>()

function buildNormalizationContextModifier(output: Output) {
  const normalizationPayload = {
    meta: {
      normalization_version: 'normalization-v1',
      mode: output.modeUsed,
    },
    hypothesis_normalization: output.normalization,
  }
  const normalizationJson = JSON.stringify(normalizationPayload)
  return {
    modifyContext: (ctx: ToolUseContext): ToolUseContext => ({
      ...ctx,
      options: {
        ...(ctx.options || {}),
        latestNormalizationJson: normalizationJson,
      },
    }),
  }
}
const NORMALIZATION_CACHE_TTL_MS = 30_000

const CORE_FIELD_TOKEN_MAP: Record<string, string> = {
  claim: 'claim',
  hipotesis: 'claim',
  hipótesis: 'claim',
  tesis: 'claim',
  tésis: 'claim',
  domain: 'domain',
  dominio: 'domain',
  entities: 'entities',
  entidades: 'entities',
  relation: 'relation',
  relacion: 'relation',
  relación: 'relation',
  observables: 'observables',
  observable: 'observables',
}

function normalizeInline(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

function truncateForUi(text: string, max = 120): string {
  const normalized = normalizeInline(text)
  if (normalized.length <= max) return normalized
  return `${normalized.slice(0, max - 3)}...`
}

function normalizeFieldToken(token: string): string {
  return token
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim()
    .replace(/\s+/g, '_')
    .replace(/^_+|_+$/g, '')
}

function uniqueList(values: string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const value of values) {
    if (!value || seen.has(value)) continue
    seen.add(value)
    out.push(value)
  }
  return out
}

function collectCriticalMissingFields(
  normalization: HypothesisNormalizationResult['hypothesis_normalization'],
): string[] {
  const isActuallyMissing = (field: string): boolean => {
    switch (field) {
      case 'claim':
        return !normalization.claim.trim()
      case 'domain':
        return !normalization.domain.trim()
      case 'entities':
        return normalization.entities.length === 0
      case 'relation':
        return !normalization.relation.trim()
      case 'observables':
        return normalization.observables.length === 0
      default:
        return false
    }
  }

  const mappedFromMissing = normalization.missing_fields
    .map(field => CORE_FIELD_TOKEN_MAP[normalizeFieldToken(field)] ?? '')
    .filter(Boolean)
    .filter(field => isActuallyMissing(field))

  const inferred: string[] = []
  if (!normalization.claim.trim()) inferred.push('claim')
  if (!normalization.domain.trim()) inferred.push('domain')
  if (!normalization.relation.trim()) inferred.push('relation')
  if (normalization.entities.length === 0) inferred.push('entities')
  if (normalization.observables.length === 0) inferred.push('observables')

  return uniqueList([...mappedFromMissing, ...inferred])
}

function getReadableMutedColor(): string {
  const theme = getTheme()
  return theme.text === '#fff' ? '#b8b8b8' : '#555'
}

function buildToolConversationKey(context: ToolUseContext): string {
  return `${context.options?.messageLogName ?? 'default'}:${context.options?.forkNumber ?? 0}:${context.agentId ?? 'main'}`
}

function buildNormalizationCacheKey(input: Input, context: ToolUseContext): string {
  const conversationKey = buildToolConversationKey(context)
  const normalizedPrompt = normalizeInline(
    [
      input.hypothesis_query,
      input.dialectical_synthesis ?? '',
      input.baconian_forma_veritas ?? '',
      input.literature_summary ?? '',
    ].join(' | '),
  )
    .toLowerCase()
    .slice(0, 4000)

  return `${conversationKey}::${normalizedPrompt}`
}

function pruneNormalizationCache(now = Date.now()): void {
  for (const [key, value] of recentNormalizationCache.entries()) {
    if (now - value.createdAt > NORMALIZATION_CACHE_TTL_MS) {
      recentNormalizationCache.delete(key)
    }
  }
}

function buildClarificationTemplate(criticalMissingFields: string[]): string {
  const fieldLabel: Record<string, string> = {
    claim: 'Hypothesis',
    domain: 'Domain',
    entities: 'Entities',
    relation: 'Relation',
    observables: 'Observables',
    expected_direction: 'Direction',
    conditions: 'Conditions',
  }

  const questions = criticalMissingFields.slice(0, 4).map(field => ({
    header: fieldLabel[field] ?? 'Field',
    question: `Missing ${fieldLabel[field] ?? field}. How do you want to close it so falsification can continue?`,
    options: [
      {
        label: 'Define now (Recommended)',
        description:
          'Select this option and provide the exact value in Other.',
      },
      {
        label: 'Use minimal assumption',
        description:
          'Allows an explicit and traceable assumption to continue.',
      },
      {
        label: 'Keep pending',
        description:
          'Do not complete now; falsification may remain skipped.',
      },
    ],
    multiSelect: false,
  }))

  return JSON.stringify({ questions }, null, 2)
}

async function runAndBuildNormalizationOutput(params: {
  modelName: string
  apiKey?: string
  input: Input
  conversationKey: string
  signal: AbortSignal
}): Promise<Output> {
  const strictRun = await runNormalizationAgent({
    modelName: params.modelName,
    apiKey: params.apiKey,
    hypothesisInput: params.input.hypothesis_query,
    dialecticalSynthesis: params.input.dialectical_synthesis,
    baconianFormaVeritas: params.input.baconian_forma_veritas,
    literatureSummary: params.input.literature_summary,
    mode: 'strict',
    conversationKey: params.conversationKey,
    signal: params.signal,
    maxRetries: 2,
  })

  if (!strictRun.normalization) {
    throw new Error('Normalization subagent did not return structured output.')
  }

  let chosen = strictRun.normalization
  let chosenText = strictRun.text
  let autoRetriesUsed = 0
  let autoCorrectionAttempted = false
  let autoCorrectionImproved = false

  const strictMissing = collectCriticalMissingFields(
    strictRun.normalization.hypothesis_normalization,
  )

  if (strictMissing.length > 0) {
    autoCorrectionAttempted = true
    const autoRun = await runNormalizationAgent({
      modelName: params.modelName,
      apiKey: params.apiKey,
      hypothesisInput: params.input.hypothesis_query,
      dialecticalSynthesis: params.input.dialectical_synthesis,
      baconianFormaVeritas: params.input.baconian_forma_veritas,
      literatureSummary: params.input.literature_summary,
      previousNormalizationRaw: JSON.stringify(strictRun.normalization),
      mode: 'autocorrect',
      conversationKey: params.conversationKey,
      signal: params.signal,
      maxRetries: 2,
    })

    autoRetriesUsed = autoRun.retriesUsed
    if (autoRun.normalization) {
      const autoMissing = collectCriticalMissingFields(
        autoRun.normalization.hypothesis_normalization,
      )
      autoCorrectionImproved = autoMissing.length < strictMissing.length

      if (autoMissing.length <= strictMissing.length) {
        chosen = autoRun.normalization
        chosenText = autoRun.text
      }
    }
  }

  const criticalMissingFields = collectCriticalMissingFields(
    chosen.hypothesis_normalization,
  )

  return {
    analysis: chosenText,
    model: params.modelName,
    retriesUsed: strictRun.retriesUsed + autoRetriesUsed,
    strictRetriesUsed: strictRun.retriesUsed,
    autoRetriesUsed,
    modeUsed: chosen.meta.mode,
    autoCorrectionAttempted,
    autoCorrectionImproved,
    normalizationOk: criticalMissingFields.length === 0,
    criticalMissingFields,
    normalization: chosen.hypothesis_normalization,
  }
}

export const HypothesisNormalizationTool = {
  name: TOOL_NAME,
  async description() {
    return DESCRIPTION
  },
  userFacingName: () => 'Hypothesis normalization',
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
    return `I will normalize the hypothesis to prepare the falsification phase: ${preview}`
  },
  renderToolUseRejectedMessage() {
    return <FallbackToolUseRejectedMessage />
  },
  renderToolResultMessage(output: Output) {
    const mutedColor = getReadableMutedColor()
    const missingPreview =
      output.criticalMissingFields.length > 0
        ? output.criticalMissingFields.join(', ')
        : '(none)'

    return (
      <Box flexDirection="column">
        <Box flexDirection="row">
          <Text color={mutedColor}>
            &nbsp;&nbsp;⎿ &nbsp;Hypothesis normalization complete{' '}
          </Text>
          <Text color={mutedColor}>
            ({output.model}
            {output.retriesUsed > 0 ? ` · retries ${output.retriesUsed}` : ''})
          </Text>
        </Box>
        <Text color={mutedColor}>{`     Mode used: ${output.modeUsed}`}</Text>
        <Text color={mutedColor}>{`     Auto-correction: ${output.autoCorrectionAttempted ? (output.autoCorrectionImproved ? 'applied (improved)' : 'attempted (no improvement)') : 'not needed'}`}</Text>
        <Text color={mutedColor}>{`     Missing core: ${missingPreview}`}</Text>
        <Text color={mutedColor}>{`     Claim: ${truncateForUi(output.normalization.claim, 90)}`}</Text>
      </Box>
    )
  },
  renderResultForAssistant(output: Output) {
    const normalized = output.normalization
    const normalizationPayload = {
      meta: {
        normalization_version: 'normalization-v1',
        mode: output.modeUsed,
      },
      hypothesis_normalization: normalized,
    }
    const normalizationJson = JSON.stringify(normalizationPayload)

    const base = [
      'Normalization result (brief):',
      `Claim: ${normalized.claim}`,
      `Domain: ${normalized.domain}`,
      `Entities: ${normalized.entities.join(', ')}`,
      `Relation: ${normalized.relation}`,
      `Observables: ${normalized.observables.join(', ')}`,
      `Expected direction: ${normalized.expected_direction}`,
      `Conditions: ${normalized.conditions}`,
      `Time scope: ${normalized.time_scope}`,
      `Clarification required: ${normalized.clarification_required ? 'yes' : 'no'}`,
      `Missing core fields: ${output.criticalMissingFields.join(', ') || '(none)'}`,
      `Autocorrection attempted: ${output.autoCorrectionAttempted ? 'yes' : 'no'}`,
      `Autocorrection improved: ${output.autoCorrectionImproved ? 'yes' : 'no'}`,
    ]

    if (!output.normalizationOk) {
      const selectorTemplate = buildClarificationTemplate(
        output.criticalMissingFields,
      )
      return [
        ...base,
        '',
        'Mandatory next step: use AskUserQuestion (Amawta Selector) to close these missing fields.',
        'Suggested AskUserQuestion template:',
        selectorTemplate,
        '',
        'After receiving selector answers, invoke HypothesisNormalization again with the same hypothesis and the answer context.',
        'Do not run FalsificationPlan until Missing core fields is (none).',
        `normalization_json=${normalizationJson}`,
      ].join('\n')
    }

    return [
      ...base,
      '',
      'Mandatory next step: invoke FalsificationPlan using this normalization as normalization_json and normalization_ok=true.',
      'Do not invoke HypothesisNormalization again for this same hypothesis in this turn.',
      `normalization_json=${normalizationJson}`,
    ].join('\n')
  },
  async *call(input: Input, context: ToolUseContext) {
    const modelManager = getModelManager()
    const modelProfile = modelManager.getModel('main')

    if (!modelProfile || !modelProfile.modelName) {
      throw new Error(
        'No model configured. Configure a model first with /model command.',
      )
    }

    const conversationKey = buildToolConversationKey(context)
    const cacheKey = buildNormalizationCacheKey(input, context)
    pruneNormalizationCache()
    const cached = recentNormalizationCache.get(cacheKey)
    if (cached && Date.now() - cached.createdAt <= NORMALIZATION_CACHE_TTL_MS) {
      yield {
        type: 'progress',
        content: createAssistantMessage(
          'Reusing recent normalization for this same hypothesis.',
        ),
      }
      yield {
        type: 'result' as const,
        data: cached.output,
        resultForAssistant: this.renderResultForAssistant(cached.output),
        contextModifier: buildNormalizationContextModifier(cached.output),
      }
      return
    }

    const existingRun = inFlightNormalizationRuns.get(cacheKey)
    if (existingRun) {
      yield {
        type: 'progress',
        content: createAssistantMessage(
          'Waiting for result from a normalization already in progress.',
        ),
      }
      const output = await existingRun
      yield {
        type: 'result' as const,
        data: output,
        resultForAssistant: this.renderResultForAssistant(output),
        contextModifier: buildNormalizationContextModifier(output),
      }
      return
    }

    const runPromise = runAndBuildNormalizationOutput({
      modelName: modelProfile.modelName,
      apiKey: modelProfile.apiKey?.trim() || undefined,
      input,
      conversationKey,
      signal: context.abortController.signal,
    })
    inFlightNormalizationRuns.set(cacheKey, runPromise)

    let output: Output
    try {
      yield {
        type: 'progress',
        content: createAssistantMessage(
          'Running strict claim normalization (without inventing missing fields)...',
        ),
      }
      output = await runPromise
      if (output.autoCorrectionAttempted) {
        yield {
          type: 'progress',
          content: createAssistantMessage(
            output.autoCorrectionImproved
              ? 'Auto-correction applied: reduced missing fields using explicit minimal assumptions.'
              : 'Auto-correction attempted: missing fields remain and require human decision.',
          ),
        }
      }
    } finally {
      inFlightNormalizationRuns.delete(cacheKey)
    }

    recentNormalizationCache.set(cacheKey, {
      output,
      createdAt: Date.now(),
    })

    yield {
      type: 'result' as const,
      data: output,
      resultForAssistant: this.renderResultForAssistant(output),
      contextModifier: buildNormalizationContextModifier(output),
    }
  },
} satisfies Tool<typeof inputSchema, Output>

export const __testOnly = {
  truncateForUi,
  normalizeFieldToken,
  collectCriticalMissingFields,
  buildNormalizationCacheKey,
  buildClarificationTemplate,
}
