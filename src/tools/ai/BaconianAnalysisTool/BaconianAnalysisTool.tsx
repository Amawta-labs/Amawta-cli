import React from 'react'
import { Box, Text } from 'ink'
import { z } from 'zod'
import { FallbackToolUseRejectedMessage } from '@components/FallbackToolUseRejectedMessage'
import { Tool, ToolUseContext } from '@tool'
import { getModelManager } from '@utils/model'
import { getTheme } from '@utils/theme'
import { createAssistantMessage } from '@utils/messages'
import { runBaconianAgent } from '@services/ai/agents/baconianAgent'
import { DESCRIPTION, PROMPT, TOOL_NAME } from './prompt'

const inputSchema = z.strictObject({
  hypothesis_query: z
    .string()
    .min(8)
    .describe('Original user hypothesis/claim'),
  dialectical_summary: z
    .string()
    .min(3)
    .describe('Dialectical summary from DialecticalAnalysis'),
  dialectical_hypothesis: z
    .string()
    .min(3)
    .describe('Dialectical hypothesis from DialecticalAnalysis'),
  dialectical_antithesis: z
    .string()
    .min(3)
    .describe('Dialectical antithesis from DialecticalAnalysis'),
  dialectical_synthesis: z
    .string()
    .min(3)
    .describe('Dialectical synthesis from DialecticalAnalysis'),
  context: z
    .string()
    .optional()
    .describe('Optional extra context for Baconian analysis'),
})

type Input = z.infer<typeof inputSchema>

type Output = {
  analysis: string
  retriesUsed: number
  model: string
  summary: string
  idols: {
    tribe: string
    cave: string
    market: string
    theater: string
  }
  clearing: {
    tribe: string
    cave: string
    market: string
    theater: string
  }
  truthTables: {
    presence: string
    absence: string
    degrees: string
  }
  formaVeritas: string
}

type CachedBaconianResult = {
  output: Output
  createdAt: number
}

const recentBaconianResultCache = new Map<string, CachedBaconianResult>()
const inFlightBaconianRuns = new Map<string, Promise<Output>>()
const BACONIAN_CACHE_TTL_MS = 30_000

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

function buildBaconianCacheKey(input: Input, context: ToolUseContext): string {
  const conversationKey = buildToolConversationKey(context)
  const normalizedPrompt = normalizeInline(
    [
      input.hypothesis_query,
      input.dialectical_summary,
      input.dialectical_hypothesis,
      input.dialectical_antithesis,
      input.dialectical_synthesis,
      input.context ?? '',
    ].join(' | '),
  )
    .toLowerCase()
    .slice(0, 4000)
  return `${conversationKey}::${normalizedPrompt}`
}

function pruneBaconianCache(now = Date.now()): void {
  for (const [key, value] of recentBaconianResultCache.entries()) {
    if (now - value.createdAt > BACONIAN_CACHE_TTL_MS) {
      recentBaconianResultCache.delete(key)
    }
  }
}

async function runAndBuildBaconianOutput(params: {
  modelName: string
  apiKey?: string
  input: Input
  conversationKey: string
  signal: AbortSignal
}): Promise<Output> {
  const run = await runBaconianAgent({
    modelName: params.modelName,
    apiKey: params.apiKey,
    hypothesisPrompt: params.input.hypothesis_query,
    conversationKey: params.conversationKey,
    dialectic: {
      summary: params.input.dialectical_summary,
      hypothesis: params.input.dialectical_hypothesis,
      antithesis: params.input.dialectical_antithesis,
      synthesis: params.input.dialectical_synthesis,
    },
    signal: params.signal,
    maxRetries: 2,
  })

  if (!run.baconian) {
    throw new Error('Baconian subagent did not return structured output.')
  }

  return {
    analysis: run.text,
    retriesUsed: run.retriesUsed,
    model: params.modelName,
    summary: run.baconian.summary,
    idols: run.baconian.idols,
    clearing: run.baconian.clearing,
    truthTables: run.baconian.truth_tables,
    formaVeritas: run.baconian.forma_veritas,
  }
}

export const BaconianAnalysisTool = {
  name: TOOL_NAME,
  async description() {
    return DESCRIPTION
  },
  userFacingName: () => 'Baconian analysis',
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
    return { result: true }
  },
  renderToolUseMessage(input: Input) {
    const preview = truncateForUi(input.dialectical_synthesis, 110)
    return `I will run the Baconian subagent based on the dialectical synthesis: ${preview}`
  },
  renderToolUseRejectedMessage() {
    return <FallbackToolUseRejectedMessage />
  },
  renderToolResultMessage(output: Output) {
    const mutedColor = getReadableMutedColor()
    return (
      <Box flexDirection="column">
        <Box flexDirection="row">
          <Text color={mutedColor}>&nbsp;&nbsp;⎿ &nbsp;Baconian analysis complete </Text>
          <Text color={mutedColor}>
            ({output.model}
            {output.retriesUsed > 0 ? ` · retries ${output.retriesUsed}` : ''})
          </Text>
        </Box>
        <Text color={mutedColor}>{`     Idols/Tribe: ${truncateForUi(output.idols.tribe, 90)}`}</Text>
        <Text color={mutedColor}>{`     Table/Presence: ${truncateForUi(output.truthTables.presence, 90)}`}</Text>
        <Text color={mutedColor}>{`     Forma veritas: ${truncateForUi(output.formaVeritas, 90)}`}</Text>
      </Box>
    )
  },
  renderResultForAssistant(output: Output) {
    return [
      'Baconian result (brief):',
      `Summary: ${output.summary}`,
      `Idols - Tribe: ${output.idols.tribe}`,
      `Idols - Cave: ${output.idols.cave}`,
      `Idols - Market: ${output.idols.market}`,
      `Idols - Theater: ${output.idols.theater}`,
      `Clearing - Tribe: ${output.clearing.tribe}`,
      `Clearing - Cave: ${output.clearing.cave}`,
      `Clearing - Market: ${output.clearing.market}`,
      `Clearing - Theater: ${output.clearing.theater}`,
      `Presence table: ${output.truthTables.presence}`,
      `Absence table: ${output.truthTables.absence}`,
      `Degrees table: ${output.truthTables.degrees}`,
      `Forma veritas: ${output.formaVeritas}`,
      'Note: do not invoke BaconianAnalysis again for this same hypothesis in this turn; reuse this result.',
      'Mandatory next step: run LiteratureDiscovery before final response (pass the same hypothesis_query and this forma veritas).',
      `Suggested LiteratureDiscovery input: hypothesis_query="<current claim>", baconian_forma_veritas="${output.formaVeritas}"`,
      'If the domain is ambiguous before search (e.g., physics vs neuroscience), use AskUserQuestion (Amawta Selector) so the user chooses the scope, then run LiteratureDiscovery with that decision as domain_hint.',
      'Suggested AskUserQuestion template for domain ambiguity: questions=[{header:"Domain",question:"To focus literature search, which domain should we prioritize?",options:[{label:"Theoretical physics (Recommended)",description:"Prioritize mathematical physics and geometry sources."},{label:"Neuroscience",description:"Prioritize cognitive/neural and neurocomputational literature."},{label:"Both",description:"Search both domains and compare evidence."}],multiSelect:false}]',
      'Under domain ambiguity, do not finalize without AskUserQuestion + LiteratureDiscovery.',
      'Forbidden in this phase (without explicit empirical evidence): "confirms", "demonstrates", "proves".',
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
    const cacheKey = buildBaconianCacheKey(input, context)
    pruneBaconianCache()
    const cached = recentBaconianResultCache.get(cacheKey)
    if (cached && Date.now() - cached.createdAt <= BACONIAN_CACHE_TTL_MS) {
      yield {
        type: 'progress',
        content: createAssistantMessage(
          'Reusing recent Baconian result for this same hypothesis.',
        ),
      }
      yield {
        type: 'result' as const,
        data: cached.output,
        resultForAssistant: this.renderResultForAssistant(cached.output),
      }
      return
    }

    const existingRun = inFlightBaconianRuns.get(cacheKey)
    if (existingRun) {
      yield {
        type: 'progress',
        content: createAssistantMessage(
          'Waiting for result from a Baconian execution already in progress.',
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

    const runPromise = runAndBuildBaconianOutput({
      modelName: modelProfile.modelName,
      apiKey: modelProfile.apiKey?.trim() || undefined,
      input,
      conversationKey,
      signal: context.abortController.signal,
    })
    inFlightBaconianRuns.set(cacheKey, runPromise)

    let output: Output
    try {
      yield {
        type: 'progress',
        content: createAssistantMessage(
          'Running Baconian subagent (idols -> clearing -> truth tables -> forma veritas)...',
        ),
      }
      output = await runPromise
    } finally {
      inFlightBaconianRuns.delete(cacheKey)
    }

    recentBaconianResultCache.set(cacheKey, {
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
  buildBaconianCacheKey,
}
