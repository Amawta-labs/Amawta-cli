import React from 'react'
import type { Command } from '@commands'
import {
  formatPathForDisplay,
  getAdkEventArtifactsRootDir,
  getAdkEventTraceDetailFromSummary,
  getLatestAdkEventTraceDetail,
  listAdkEventTraceSummaries,
} from '@services/ai/adkEventTraceInspector'
import { EventTraceSelector } from '@screens/EventTraceSelector'
import { EventTraceLiveView } from '@screens/EventTraceLiveView'

const VALID_SCOPES = new Set([
  'orchestrator',
  'dialectical',
  'baconian',
  'normalization',
  'falsification',
  'runners',
  'all',
])

function parseCount(
  raw: string | undefined,
  fallback: number,
  max = 500,
): number {
  if (!raw) return fallback
  const parsed = Number.parseInt(raw, 10)
  if (!Number.isFinite(parsed)) return fallback
  return Math.max(1, Math.min(max, parsed))
}

function parseScope(raw: string | undefined): string | undefined | null {
  if (!raw || raw.trim().length === 0) return undefined
  const normalized = raw.trim().toLowerCase()
  if (!VALID_SCOPES.has(normalized)) return null
  return normalized === 'all' ? undefined : normalized
}

function formatSavedAt(timestamp: number): string {
  if (!Number.isFinite(timestamp) || timestamp <= 0) return 'unknown'
  try {
    return new Date(timestamp).toISOString()
  } catch {
    return 'unknown'
  }
}

function formatSavedAtShort(timestamp: number): string {
  if (!Number.isFinite(timestamp) || timestamp <= 0) return 'unknown'
  try {
    return new Date(timestamp).toISOString().slice(11, 19)
  } catch {
    return 'unknown'
  }
}

function formatEventTraceLine(
  event: Record<string, unknown>,
  index: number,
): string {
  const kind =
    typeof event.kind === 'string' && event.kind.trim().length > 0
      ? event.kind.trim()
      : 'event'
  const author =
    typeof event.author === 'string' && event.author.trim().length > 0
      ? event.author
      : 'unknown'
  const partial = event.partial === true ? 'partial' : ''
  const final = event.finalResponse === true ? 'final' : ''
  const callCount = Array.isArray(event.functionCalls)
    ? event.functionCalls.length
    : 0
  const responseCount = Array.isArray(event.functionResponses)
    ? event.functionResponses.length
    : 0
  const transfer = (() => {
    const actions =
      event.actions && typeof event.actions === 'object'
        ? (event.actions as Record<string, unknown>)
        : {}
    const transferToAgent = actions.transferToAgent
    if (typeof transferToAgent !== 'string' || transferToAgent.length === 0) {
      return ''
    }
    return ` -> ${transferToAgent}`
  })()

  const preview =
    typeof event.textPreview === 'string' && event.textPreview.trim().length > 0
      ? ` | ${event.textPreview}`
      : ''

  const flags = [partial, final].filter(Boolean).join(',')
  const flagLabel = flags.length > 0 ? ` [${flags}]` : ''

  return `⎿    ${index}. ${kind} ${author}${flagLabel} calls:${callCount} responses:${responseCount}${transfer}${preview}`
}

function buildUsage(): string {
  return [
    '⎿  Usage:',
    '⎿  • /events',
    '⎿  • /events [scope] [limit]',
    '⎿  • /events --all [scope] [limit]',
    '⎿  • /events select [scope] [limit]',
    '⎿  • /events list [scope] [limit]',
    '⎿  • /events show [scope] [--tail N]',
    '⎿  • /events --live [scope] [--tail N] [--interval ms]',
    '⎿  • /events live [scope] [--tail N] [--interval ms]',
    '⎿  • /events latest [scope] [count] (alias of show)',
    '⎿  • /events paths [scope] [limit]',
    '⎿  scopes: orchestrator | dialectical | baconian | normalization | falsification | runners | all',
  ].join('\n')
}

function getConversationKey(trace: {
  conversationKey?: string
  sessionId: string
}): string {
  const key = trace.conversationKey?.trim()
  if (key && key.length > 0) return key
  return trace.sessionId
}

async function listMode(
  scope?: string,
  limit = 20,
  options?: { flat?: boolean },
): Promise<string> {
  const rootDir = getAdkEventArtifactsRootDir()
  const traces = await listAdkEventTraceSummaries({
    scope,
    limit: options?.flat ? limit : Math.max(limit * 8, limit),
  })
  if (traces.length === 0) {
    return [
      '⎿  No ADK event traces found.',
      `⎿  Root: ${formatPathForDisplay(rootDir)}`,
      '⎿  Run a dialectical/baconian query first to generate traces.',
    ].join('\n')
  }

  if (options?.flat) {
    const header = [
      '⎿  ADK Event Traces',
      `⎿  Root: ${formatPathForDisplay(rootDir)}`,
    ]
    const lines = traces.slice(0, limit).map(trace => {
      const parts = [
        `scope:${trace.scope}`,
        `app:${trace.appName}`,
        `session:${trace.sessionId}`,
        `artifact:${trace.filename}`,
        `latest:v${trace.latestVersion}`,
        `versions:${trace.versionCount}`,
      ]
      if (trace.conversationKey) {
        parts.push(`conv:${trace.conversationKey}`)
      }
      if (typeof trace.capturedCount === 'number') {
        parts.push(`events:${trace.capturedCount}`)
      }
      if (typeof trace.droppedCount === 'number') {
        parts.push(`dropped:${trace.droppedCount}`)
      }
      parts.push(`saved:${formatSavedAt(trace.savedAt)}`)
      return `⎿  • ${parts.join(' | ')}`
    })
    return [...header, ...lines].join('\n')
  }

  const tracesByConversation = new Map<string, typeof traces>()
  for (const trace of traces) {
    const key = getConversationKey(trace)
    if (!tracesByConversation.has(key)) {
      tracesByConversation.set(key, [])
    }
    tracesByConversation.get(key)!.push(trace)
  }

  const orderedConversations = Array.from(tracesByConversation.entries())
    .map(([conversationKey, convTraces]) => ({
      conversationKey,
      traces: convTraces.sort((a, b) => b.savedAt - a.savedAt),
      latestSavedAt: Math.max(...convTraces.map(trace => trace.savedAt)),
    }))
    .sort((a, b) => b.latestSavedAt - a.latestSavedAt)
    .slice(0, limit)

  const lines = [
    `ADK Event Traces  (root: ${formatPathForDisplay(rootDir)})`,
  ]

  for (const conversation of orderedConversations) {
    lines.push(`Conversation: ${conversation.conversationKey}`)
    const byScope = new Map<string, (typeof conversation.traces)[number]>()
    for (const trace of conversation.traces) {
      if (!byScope.has(trace.scope)) {
        byScope.set(trace.scope, trace)
      }
    }

    const selected = Array.from(byScope.values()).sort((a, b) =>
      a.scope.localeCompare(b.scope),
    )
    for (const trace of selected) {
      const scope = trace.scope.padEnd(13)
      const version = `v${trace.latestVersion} (${trace.versionCount})`.padEnd(9)
      const events = `events:${trace.capturedCount ?? 0}`.padEnd(11)
      const dropped = `dropped:${trace.droppedCount ?? 0}`.padEnd(11)
      const saved = `saved:${formatSavedAtShort(trace.savedAt)}`
      lines.push(`  ${scope} ${version} ${events} ${dropped} ${saved}`)
    }
  }

  return lines.map(line => `⎿  ${line}`).join('\n')
}

async function pathsMode(scope?: string, limit = 20): Promise<string> {
  const traces = await listAdkEventTraceSummaries({ scope, limit })
  if (traces.length === 0) {
    return '⎿  No trace paths found.'
  }
  return [
    '⎿  ADK Trace Paths',
    ...traces.map(
      trace =>
        `⎿  • ${trace.scope} v${trace.latestVersion}: ${formatPathForDisplay(
          trace.versionFilePath,
        )}`,
    ),
  ].join('\n')
}

async function latestMode(scope?: string, count = 8): Promise<string> {
  const detail = await getLatestAdkEventTraceDetail({ scope })
  if (!detail) {
    return '⎿  No latest ADK trace available for that scope.'
  }

  const events = Array.isArray(detail.events) ? detail.events : []
  const slice = events.slice(Math.max(0, events.length - count))
  const startIndex = Math.max(0, events.length - slice.length)

  const header = [
    '⎿  Latest ADK Event Trace',
    `⎿  Scope: ${detail.scope}`,
    `⎿  App: ${detail.appName}`,
    `⎿  Session: ${detail.sessionId}`,
    `⎿  Artifact: ${detail.filename} (v${detail.latestVersion}, versions:${detail.versionCount})`,
    `⎿  Path: ${formatPathForDisplay(detail.versionFilePath)}`,
    `⎿  Captured: ${detail.capturedCount ?? events.length} | Dropped: ${detail.droppedCount ?? 0}`,
    `⎿  Saved: ${formatSavedAt(detail.savedAt)}`,
  ]
  if (detail.conversationKey) {
    header.splice(4, 0, `⎿  Conversation: ${detail.conversationKey}`)
  }

  if (slice.length === 0) {
    return [...header, '⎿  No events inside this trace payload.'].join('\n')
  }

  const lines = slice.map((event, index) =>
    formatEventTraceLine(event, startIndex + index + 1),
  )
  return [...header, ...lines].join('\n')
}

function parseTailArg(tokens: string[], fallback: number): number {
  const tailFlagIndex = tokens.findIndex(token => token === '--tail')
  if (tailFlagIndex === -1) return fallback
  return parseCount(tokens[tailFlagIndex + 1], fallback, 1000)
}

function removeTailArg(tokens: string[]): string[] {
  const tailFlagIndex = tokens.findIndex(token => token === '--tail')
  if (tailFlagIndex === -1) return tokens
  return tokens.filter((_, index) => index !== tailFlagIndex && index !== tailFlagIndex + 1)
}

function parseIntervalArg(tokens: string[], fallback: number): number {
  const intervalFlagIndex = tokens.findIndex(token => token === '--interval')
  if (intervalFlagIndex === -1) return fallback
  return parseCount(tokens[intervalFlagIndex + 1], fallback, 10_000)
}

function removeIntervalArg(tokens: string[]): string[] {
  const intervalFlagIndex = tokens.findIndex(token => token === '--interval')
  if (intervalFlagIndex === -1) return tokens
  return tokens.filter(
    (_, index) => index !== intervalFlagIndex && index !== intervalFlagIndex + 1,
  )
}

async function showMode(scope?: string, tail = 40): Promise<string> {
  return latestMode(scope, tail)
}

const events = {
  type: 'local-jsx',
  name: 'events',
  description: 'Inspect ADK event traces saved as artifacts',
  argumentHint: '[select|list|show|latest|paths|--all|--live] [scope] [limit]',
  aliases: ['ev'],
  isEnabled: true,
  isHidden: false,
  async call(onDone, _context, args = '') {
    const tokens = args.trim().split(/\s+/).filter(Boolean)
    if (tokens.length === 1 && tokens[0] === '--all') {
      onDone(await listMode(undefined, 120, { flat: true }))
      return null
    }

    const firstToken = tokens[0]?.toLowerCase()
    const shorthandScope = parseScope(firstToken)
    if (tokens.length > 0 && shorthandScope !== null && VALID_SCOPES.has(firstToken || '')) {
      const limit = parseCount(tokens[1], 20, 200)
      onDone(await listMode(shorthandScope, limit))
      return null
    }

    const mode = (tokens[0] || 'list').toLowerCase()

    if (mode === 'help' || mode === '--help' || mode === '-h') {
      onDone(buildUsage())
      return null
    }

    if (mode === '--live' || mode === 'live') {
      const tail = parseTailArg(tokens, 80)
      const intervalMs = Math.max(200, parseIntervalArg(tokens, 1000))
      const stripped = removeIntervalArg(removeTailArg(tokens))
      const parsedScope = parseScope(stripped[1])
      if (parsedScope === null) {
        onDone(buildUsage())
        return null
      }

      return React.createElement(EventTraceLiveView, {
        scope: parsedScope,
        tail,
        intervalMs,
        onStop: (message: string) => onDone(message),
      })
    }

    if (mode === 'select') {
      const parsedScope = parseScope(tokens[1])
      if (parsedScope === null) {
        onDone(buildUsage())
        return null
      }
      const limit = parseCount(tokens[2], 200, 500)
      const traces = await listAdkEventTraceSummaries({
        scope: parsedScope,
        limit,
      })
      if (traces.length === 0) {
        onDone('⎿  No ADK event traces found for selector mode.')
        return null
      }

      return React.createElement(EventTraceSelector, {
        traces,
        onCancel: () => onDone('⎿  Selector cancelled.'),
        onSelect: async trace => {
          const detail = await getAdkEventTraceDetailFromSummary(trace)
          if (!detail) {
            onDone(
              `⎿  Could not load detail for trace: ${formatPathForDisplay(trace.versionFilePath)}`,
            )
            return
          }

          const eventsLines = detail.events
            .slice(Math.max(0, detail.events.length - 12))
            .map((event, index) =>
              formatEventTraceLine(
                event,
                detail.events.length -
                  Math.min(12, detail.events.length) +
                  index +
                  1,
              ),
            )

          const output = [
            '⎿  Selected ADK Event Trace',
            `⎿  Scope: ${detail.scope}`,
            `⎿  App: ${detail.appName}`,
            `⎿  Session: ${detail.sessionId}`,
            `⎿  Artifact: ${detail.filename} (v${detail.latestVersion}, versions:${detail.versionCount})`,
            `⎿  Path: ${formatPathForDisplay(detail.versionFilePath)}`,
            `⎿  Captured: ${detail.capturedCount ?? detail.events.length} | Dropped: ${detail.droppedCount ?? 0}`,
            `⎿  Saved: ${formatSavedAt(detail.savedAt)}`,
            ...(detail.conversationKey
              ? [`⎿  Conversation: ${detail.conversationKey}`]
              : []),
            ...(eventsLines.length > 0
              ? eventsLines
              : ['⎿  No events inside this trace payload.']),
          ].join('\n')

          onDone(output)
        },
      })
    }

    if (mode === 'list' || mode === 'ls') {
      const allMode = tokens[1] === '--all'
      const scopeToken = allMode ? tokens[2] : tokens[1]
      const parsedScope = parseScope(tokens[1])
      if (allMode) {
        const parsedAllScope = parseScope(scopeToken)
        if (parsedAllScope === null) {
          onDone(buildUsage())
          return null
        }
        const limit = parseCount(tokens[3], 120, 1000)
        onDone(await listMode(parsedAllScope, limit, { flat: true }))
        return null
      }

      if (parsedScope === null) {
        onDone(buildUsage())
        return null
      }
      const limit = parseCount(tokens[2], 20, 200)
      onDone(await listMode(parsedScope, limit))
      return null
    }

    if (mode === '--all') {
      const parsedScope = parseScope(tokens[1])
      if (parsedScope === null) {
        onDone(buildUsage())
        return null
      }
      const limit = parseCount(tokens[2], 120, 1000)
      onDone(await listMode(parsedScope, limit, { flat: true }))
      return null
    }

    if (mode === 'paths') {
      const parsedScope = parseScope(tokens[1])
      if (parsedScope === null) {
        onDone(buildUsage())
        return null
      }
      const limit = parseCount(tokens[2], 20)
      onDone(await pathsMode(parsedScope, limit))
      return null
    }

    if (mode === 'show' || mode === 'latest') {
      const stripped = removeTailArg(tokens)
      const parsedScope = parseScope(stripped[1])
      if (parsedScope === null) {
        onDone(buildUsage())
        return null
      }
      const fallbackTail =
        mode === 'latest'
          ? parseCount(stripped[2], 8, 200)
          : parseCount(stripped[2], 40, 200)
      const tail = parseTailArg(tokens, fallbackTail)
      onDone(await showMode(parsedScope, tail))
      return null
    }

    onDone(buildUsage())
    return null
  },
  userFacingName() {
    return 'events'
  },
} satisfies Command

export default events
