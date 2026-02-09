import React from 'react'
import { Box, Text } from 'ink'
import { z } from 'zod'
import { FallbackToolUseRejectedMessage } from '@components/FallbackToolUseRejectedMessage'
import { Tool, ToolUseContext } from '@tool'
import { getModelManager } from '@utils/model'
import { getTheme } from '@utils/theme'
import { createAssistantMessage } from '@utils/messages'
import { runDialecticalAgent } from '@services/ai/agents/dialecticalAgent'
import { DESCRIPTION, PROMPT, TOOL_NAME } from './prompt'

const inputSchema = z.strictObject({
  hypothesis_query: z
    .string()
    .min(8)
    .describe('Hypothesis or claim to be analyzed dialectically'),
  context: z
    .string()
    .optional()
    .describe('Optional additional context for the analysis'),
})

type Input = z.infer<typeof inputSchema>

type Output = {
  analysis: string
  retriesUsed: number
  model: string
  summary: string
  hypothesis: string
  antithesis: string
  synthesis: string
}

function buildDialecticalPrompt(input: Input): string {
  if (!input.context || !input.context.trim()) {
    return input.hypothesis_query
  }
  return [
    'Hypothesis to analyze:',
    input.hypothesis_query,
    '',
    'Additional context:',
    input.context.trim(),
  ].join('\n')
}

type CachedDialecticalResult = {
  output: Output
  createdAt: number
}

const recentDialecticalResultCache = new Map<string, CachedDialecticalResult>()
const inFlightDialecticalRuns = new Map<string, Promise<Output>>()
const DIALECTICAL_CACHE_TTL_MS = 30_000

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

function buildDialecticalCacheSourceText(
  input: Input,
  context: ToolUseContext,
): string {
  const lastUserPrompt = context.options?.lastUserPrompt
  if (typeof lastUserPrompt === 'string' && lastUserPrompt.trim().length > 0) {
    return lastUserPrompt
  }
  return buildDialecticalPrompt(input)
}

function buildDialecticalCacheKey(input: Input, context: ToolUseContext): string {
  const conversationKey = buildToolConversationKey(context)
  const normalizedPrompt = normalizeInline(
    buildDialecticalCacheSourceText(input, context),
  )
    .toLowerCase()
    .slice(0, 3000)
  return `${conversationKey}::${normalizedPrompt}`
}

function pruneDialecticalCache(now = Date.now()): void {
  for (const [key, value] of recentDialecticalResultCache.entries()) {
    if (now - value.createdAt > DIALECTICAL_CACHE_TTL_MS) {
      recentDialecticalResultCache.delete(key)
    }
  }
}

async function runAndBuildDialecticalOutput(params: {
  modelName: string
  apiKey?: string
  input: Input
  conversationKey: string
  signal: AbortSignal
}): Promise<Output> {
  const fallbackPrompt = buildDialecticalPrompt(params.input)
  const directResult = await runDialecticalAgent({
    modelName: params.modelName,
    apiKey: params.apiKey,
    prompt: fallbackPrompt,
    conversationKey: params.conversationKey,
    signal: params.signal,
    maxRetries: 2,
  })

  if (!directResult.dialectic) {
    throw new Error('Dialectical subagent did not return structured output.')
  }

  return {
    analysis: directResult.text,
    retriesUsed: directResult.retriesUsed,
    model: params.modelName,
    summary: directResult.dialectic.summary,
    hypothesis: directResult.dialectic.hypothesis,
    antithesis: directResult.dialectic.antithesis,
    synthesis: directResult.dialectic.synthesis,
  }
}

export const DialecticalAnalysisTool = {
  name: TOOL_NAME,
  async description() {
    return DESCRIPTION
  },
  userFacingName: () => 'Dialectical analysis',
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
    const preview = truncateForUi(input.hypothesis_query, 110)
    return `I will run the dialectical subagent for: ${preview}`
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
            &nbsp;&nbsp;⎿ &nbsp;Dialectical analysis complete{' '}
          </Text>
          <Text color={mutedColor}>
            ({output.model}
            {output.retriesUsed > 0 ? ` · retries ${output.retriesUsed}` : ''})
          </Text>
        </Box>
        <Text color={mutedColor}>{`     Hypothesis: ${truncateForUi(output.hypothesis, 90)}`}</Text>
        <Text color={mutedColor}>{`     Antithesis: ${truncateForUi(output.antithesis, 90)}`}</Text>
        <Text color={mutedColor}>{`     Synthesis: ${truncateForUi(output.synthesis, 90)}`}</Text>
      </Box>
    )
  },
  renderResultForAssistant(output: Output) {
    return [
      'Dialectical result (brief):',
      `Hypothesis: ${output.hypothesis}`,
      `Antithesis: ${output.antithesis}`,
      `Synthesis: ${output.synthesis}`,
      `Summary: ${output.summary}`,
      '',
      'Mandatory next step: invoke BaconianAnalysis now, using hypothesis_query and the dialectical fields from this result.',
      'Note: do not invoke DialecticalAnalysis again for this same hypothesis in this turn; reuse this result.',
      'Note: do not use AskExpertModel before completing BaconianAnalysis for this hypothesis.',
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
    const cacheKey = buildDialecticalCacheKey(input, context)
    pruneDialecticalCache()
    const cached = recentDialecticalResultCache.get(cacheKey)
    if (cached && Date.now() - cached.createdAt <= DIALECTICAL_CACHE_TTL_MS) {
      yield {
        type: 'progress',
        content: createAssistantMessage(
          'Reusing recent dialectical result for this same hypothesis.',
        ),
      }
      yield {
        type: 'result' as const,
        data: cached.output,
        resultForAssistant: this.renderResultForAssistant(cached.output),
      }
      return
    }

    const existingRun = inFlightDialecticalRuns.get(cacheKey)
    if (existingRun) {
      yield {
        type: 'progress',
        content: createAssistantMessage(
          'Waiting for result from a dialectical execution already in progress.',
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

    const runPromise = runAndBuildDialecticalOutput({
      modelName: modelProfile.modelName,
      apiKey: modelProfile.apiKey?.trim() || undefined,
      input,
      conversationKey,
      signal: context.abortController.signal,
    })
    inFlightDialecticalRuns.set(cacheKey, runPromise)

    let output: Output
    try {
      yield {
        type: 'progress',
        content: createAssistantMessage(
          'Running dialectical subagent (hypothesis -> antithesis -> synthesis)...',
        ),
      }
      output = await runPromise
    } finally {
      inFlightDialecticalRuns.delete(cacheKey)
    }

    recentDialecticalResultCache.set(cacheKey, {
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
  buildDialecticalCacheKey,
}
