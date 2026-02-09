import React from 'react'
import { Box, Text } from 'ink'
import { z } from 'zod'
import { FallbackToolUseRejectedMessage } from '@components/FallbackToolUseRejectedMessage'
import { Tool, ToolUseContext } from '@tool'
import { runLiteratureDiscoveryAgent } from '@services/ai/agents/literatureDiscoveryAgent'
import { getModelManager } from '@utils/model'
import { createAssistantMessage } from '@utils/messages'
import { getTheme } from '@utils/theme'
import { DESCRIPTION, PROMPT, TOOL_NAME } from './prompt'

const inputSchema = z.strictObject({
  hypothesis_query: z
    .string()
    .min(8)
    .describe('Main hypothesis or claim to evaluate against existing literature'),
  baconian_forma_veritas: z
    .string()
    .min(3)
    .describe('Forma veritas produced by BaconianAnalysis'),
  dialectical_synthesis: z
    .string()
    .optional()
    .describe('Optional synthesis from DialecticalAnalysis'),
  domain_hint: z
    .string()
    .optional()
    .describe('Optional domain hint (e.g., theoretical physics, neuroscience)'),
  context: z
    .string()
    .optional()
    .describe('Optional extra constraints or validation context'),
})

type Input = z.infer<typeof inputSchema>

type Output = {
  analysis: string
  retriesUsed: number
  model: string
  summary: string
  noveltyAssessment:
    | 'likely_novel'
    | 'partial_overlap'
    | 'well_established'
    | 'insufficient_evidence'
  confidence?: 'low' | 'medium' | 'high'
  searchQueries: string[]
  findings: Array<{
    title: string
    url: string
    evidenceType:
      | 'paper'
      | 'preprint'
      | 'survey'
      | 'technical_report'
      | 'repository'
      | 'other'
    relationToClaim: string
  }>
  overlapSignals: string[]
  noveltySignals: string[]
  gaps: string[]
  recommendedNextSteps: string[]
}

type CachedLiteratureResult = {
  output: Output
  createdAt: number
}

const recentLiteratureResultCache = new Map<string, CachedLiteratureResult>()
const inFlightLiteratureRuns = new Map<string, Promise<Output>>()
const LITERATURE_CACHE_TTL_MS = 45_000

function normalizeInline(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

function truncateForUi(text: string, max = 120): string {
  const normalized = normalizeInline(text)
  if (normalized.length <= max) return normalized
  return `${normalized.slice(0, max - 3)}...`
}

function getReadableMutedColor(): string {
  const theme = getTheme()
  return theme.text === '#fff' ? '#b8b8b8' : '#555'
}

function buildToolConversationKey(context: ToolUseContext): string {
  return `${context.options?.messageLogName ?? 'default'}:${context.options?.forkNumber ?? 0}:${context.agentId ?? 'main'}`
}

function buildLiteratureCacheKey(input: Input, context: ToolUseContext): string {
  const conversationKey = buildToolConversationKey(context)
  const normalizedPrompt = normalizeInline(
    [
      input.hypothesis_query,
      input.baconian_forma_veritas,
      input.dialectical_synthesis ?? '',
      input.domain_hint ?? '',
      input.context ?? '',
    ].join(' | '),
  )
    .toLowerCase()
    .slice(0, 5000)
  return `${conversationKey}::${normalizedPrompt}`
}

function pruneLiteratureCache(now = Date.now()): void {
  for (const [key, value] of recentLiteratureResultCache.entries()) {
    if (now - value.createdAt > LITERATURE_CACHE_TTL_MS) {
      recentLiteratureResultCache.delete(key)
    }
  }
}

async function runAndBuildLiteratureOutput(params: {
  modelName: string
  apiKey?: string
  input: Input
  conversationKey: string
  signal: AbortSignal
}): Promise<Output> {
  const run = await runLiteratureDiscoveryAgent({
    modelName: params.modelName,
    apiKey: params.apiKey,
    hypothesisInput: params.input.hypothesis_query,
    baconianFormaVeritas: params.input.baconian_forma_veritas,
    dialecticalSynthesis: params.input.dialectical_synthesis,
    domainHint: params.input.domain_hint,
    conversationKey: params.conversationKey,
    signal: params.signal,
    maxRetries: 3,
  })

  if (!run.literature) {
    throw new Error('Literature subagent did not return structured output.')
  }

  return {
    analysis: run.text,
    retriesUsed: run.retriesUsed,
    model: params.modelName,
    summary: run.literature.summary,
    noveltyAssessment: run.literature.novelty_assessment,
    confidence: run.literature.confidence,
    searchQueries: run.literature.search_queries,
    findings: run.literature.findings.map(item => ({
      title: item.title,
      url: item.url,
      evidenceType: item.evidence_type,
      relationToClaim: item.relation_to_claim,
    })),
    overlapSignals: run.literature.overlap_signals,
    noveltySignals: run.literature.novelty_signals,
    gaps: run.literature.gaps,
    recommendedNextSteps: run.literature.recommended_next_steps,
  }
}

export const LiteratureDiscoveryTool = {
  name: TOOL_NAME,
  async description() {
    return DESCRIPTION
  },
  userFacingName: () => 'Literature discovery',
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
    return true
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
    if (
      !input.baconian_forma_veritas ||
      input.baconian_forma_veritas.trim().length < 3
    ) {
      return {
        result: false,
        message:
          'baconian_forma_veritas is required (pass it from BaconianAnalysis output).',
      }
    }
    return { result: true }
  },
  renderToolUseMessage(input: Input) {
    const preview = truncateForUi(input.hypothesis_query, 110)
    return `I will run the literature-discovery subagent for: ${preview}`
  },
  renderToolUseRejectedMessage() {
    return <FallbackToolUseRejectedMessage />
  },
  renderToolResultMessage(output: Output) {
    const mutedColor = getReadableMutedColor()
    return (
      <Box flexDirection="column">
        <Box flexDirection="row">
          <Text color={mutedColor}>
            &nbsp;&nbsp;⎿ &nbsp;Literature discovery complete{' '}
          </Text>
          <Text color={mutedColor}>
            ({output.model}
            {output.retriesUsed > 0 ? ` · retries ${output.retriesUsed}` : ''})
          </Text>
        </Box>
        <Text color={mutedColor}>{`     Novelty: ${output.noveltyAssessment}`}</Text>
        <Text color={mutedColor}>{`     Queries: ${output.searchQueries.length}`}</Text>
        <Text color={mutedColor}>{`     Findings: ${output.findings.length}`}</Text>
        <Text color={mutedColor}>{`     Summary: ${truncateForUi(output.summary, 90)}`}</Text>
      </Box>
    )
  },
  renderResultForAssistant(output: Output) {
    const topFindings = output.findings
      .slice(0, 5)
      .map(item => `- ${item.title} | ${item.url} | ${item.relationToClaim}`)
      .join('\n')

    return [
      'Literature discovery result (brief):',
      `Summary: ${output.summary}`,
      `Novelty assessment: ${output.noveltyAssessment}`,
      `Confidence: ${output.confidence ?? 'unknown'}`,
      `Search queries used: ${output.searchQueries.join(' | ')}`,
      topFindings ? `Top findings:\n${topFindings}` : 'Top findings: (none)',
      `Overlap signals: ${output.overlapSignals.join(' | ') || '(none)'}`,
      `Novelty signals: ${output.noveltySignals.join(' | ') || '(none)'}`,
      `Gaps: ${output.gaps.join(' | ') || '(none)'}`,
      `Recommended next steps: ${output.recommendedNextSteps.join(' | ') || '(none)'}`,
      '',
      'Use this output as literature_summary input for HypothesisNormalization, FalsificationPlan, and ExperimentRunners.',
      'Do not repeat manual WebSearch for the same claim in this turn unless the user explicitly asks for extended search.',
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
    const cacheKey = buildLiteratureCacheKey(input, context)
    pruneLiteratureCache()
    const cached = recentLiteratureResultCache.get(cacheKey)
    if (cached && Date.now() - cached.createdAt <= LITERATURE_CACHE_TTL_MS) {
      yield {
        type: 'progress',
        content: createAssistantMessage(
          'Reusing recent literature-discovery result for this same claim.',
        ),
      }
      yield {
        type: 'result' as const,
        data: cached.output,
        resultForAssistant: this.renderResultForAssistant(cached.output),
      }
      return
    }

    const existingRun = inFlightLiteratureRuns.get(cacheKey)
    if (existingRun) {
      yield {
        type: 'progress',
        content: createAssistantMessage(
          'Waiting for result from a literature-discovery execution already in progress.',
        ),
      }
      const output = await existingRun
      yield {
        type: 'result' as const,
        data: output,
        resultForAssistant: this.renderResultForAssistant(output),
      }
      return
    }

    const runPromise = runAndBuildLiteratureOutput({
      modelName: modelProfile.modelName,
      apiKey: modelProfile.apiKey?.trim() || undefined,
      input,
      conversationKey,
      signal: context.abortController.signal,
    })
    inFlightLiteratureRuns.set(cacheKey, runPromise)

    let output: Output
    try {
      yield {
        type: 'progress',
        content: createAssistantMessage(
          'Running literature subagent (web search -> fetch -> overlap/novelty synthesis)...',
        ),
      }
      output = await runPromise
    } finally {
      inFlightLiteratureRuns.delete(cacheKey)
    }

    recentLiteratureResultCache.set(cacheKey, {
      output,
      createdAt: Date.now(),
    })

    yield {
      type: 'result' as const,
      data: output,
      resultForAssistant: this.renderResultForAssistant(output),
    }
  },
} satisfies Tool<typeof inputSchema, Output>

export const __testOnly = {
  truncateForUi,
  buildLiteratureCacheKey,
}
