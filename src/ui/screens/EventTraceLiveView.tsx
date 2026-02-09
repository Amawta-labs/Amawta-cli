import React from 'react'
import { Box, Text, useInput } from 'ink'
import { getTheme } from '@utils/theme'
import { getLatestAdkEventTraceDetail } from '@services/ai/adkEventTraceInspector'

type EventTraceLiveViewProps = {
  scope?: string
  tail: number
  intervalMs: number
  onStop: (message: string) => void
}

type LiveMeta = {
  scope: string
  sessionId: string
  filename: string
  version: number
  savedAt: number
}

function formatSavedAt(timestamp: number): string {
  if (!Number.isFinite(timestamp) || timestamp <= 0) return 'unknown'
  try {
    return new Date(timestamp).toISOString()
  } catch {
    return 'unknown'
  }
}

function formatTime(timestamp: unknown): string {
  if (typeof timestamp !== 'number' || !Number.isFinite(timestamp) || timestamp <= 0) {
    return '--:--:--'
  }
  try {
    return new Date(timestamp).toISOString().slice(11, 19)
  } catch {
    return '--:--:--'
  }
}

function normalizeInline(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

function truncateForUi(text: string, max = 140): string {
  const normalized = normalizeInline(text)
  if (normalized.length <= max) return normalized
  return `${normalized.slice(0, max - 3)}...`
}

function formatLiveEventLine(event: Record<string, unknown>): string {
  const kind =
    typeof event.kind === 'string' && event.kind.trim().length > 0
      ? event.kind.trim()
      : 'event'
  const author =
    typeof event.author === 'string' && event.author.trim().length > 0
      ? event.author.trim()
      : 'unknown'
  const textPreview =
    typeof event.textPreview === 'string' ? truncateForUi(event.textPreview, 150) : ''
  const callCount = Array.isArray(event.functionCalls) ? event.functionCalls.length : 0
  const responseCount = Array.isArray(event.functionResponses)
    ? event.functionResponses.length
    : 0
  const suffix = textPreview
    ? ` | ${textPreview}`
    : callCount > 0 || responseCount > 0
      ? ` | calls:${callCount} responses:${responseCount}`
      : ''

  return `${formatTime(event.timestamp)} ${kind} ${author}${suffix}`
}

function buildEventIdentity(
  event: Record<string, unknown>,
  fallbackIndex: number,
): string {
  const id = typeof event.id === 'string' ? event.id.trim() : ''
  if (id.length > 0) return id
  const author = typeof event.author === 'string' ? event.author : 'unknown'
  const ts = typeof event.timestamp === 'number' ? event.timestamp : 0
  const kind = typeof event.kind === 'string' ? event.kind : 'event'
  return `${kind}:${author}:${ts}:${fallbackIndex}`
}

export function EventTraceLiveView({
  scope,
  tail,
  intervalMs,
  onStop,
}: EventTraceLiveViewProps): React.ReactNode {
  const theme = getTheme()
  const [status, setStatus] = React.useState('Waiting for traces...')
  const [lines, setLines] = React.useState<string[]>([])
  const [meta, setMeta] = React.useState<LiveMeta | null>(null)
  const [savedAt, setSavedAt] = React.useState<number>(0)
  const [pollCount, setPollCount] = React.useState(0)
  const seenRef = React.useRef<Set<string>>(new Set())
  const accumulatedRef = React.useRef<string[]>([])

  useInput((input, key) => {
    if (key.escape || input.toLowerCase() === 'q') {
      onStop(
        `⎿  Live trace stopped. events:${accumulatedRef.current.length} polls:${pollCount}`,
      )
    }
  })

  React.useEffect(() => {
    let disposed = false

    const poll = async () => {
      try {
        const detail = await getLatestAdkEventTraceDetail({ scope })
        if (disposed) return
        setPollCount(current => current + 1)

        if (!detail) {
          setStatus('No traces yet for current filter.')
          return
        }

        setMeta({
          scope: detail.scope,
          sessionId: detail.sessionId,
          filename: detail.filename,
          version: detail.latestVersion,
          savedAt: detail.savedAt,
        })
        setSavedAt(detail.savedAt)

        const events = Array.isArray(detail.events) ? detail.events : []
        let appended = 0
        for (let index = 0; index < events.length; index += 1) {
          const event = events[index] as Record<string, unknown>
          const identity = buildEventIdentity(event, index)
          if (seenRef.current.has(identity)) continue
          seenRef.current.add(identity)
          accumulatedRef.current.push(formatLiveEventLine(event))
          appended += 1
        }

        if (appended > 0) {
          setStatus(`Live update: +${appended} event(s)`)
        } else {
          setStatus('Live update: no new events')
        }

        const tailSafe = Math.max(10, Math.min(1000, tail))
        setLines(accumulatedRef.current.slice(Math.max(0, accumulatedRef.current.length - tailSafe)))
      } catch (error) {
        if (disposed) return
        const message =
          error instanceof Error ? error.message : 'unknown_error'
        setStatus(`Live poll error: ${truncateForUi(message, 120)}`)
      }
    }

    void poll()
    const timer = setInterval(() => {
      void poll()
    }, intervalMs)

    return () => {
      disposed = true
      clearInterval(timer)
    }
  }, [scope, tail, intervalMs])

  return (
    <Box flexDirection="column" width="100%">
      <Text bold color={theme.text}>
        ADK Event Traces Live
      </Text>
      <Text color={theme.secondaryText}>
        {`scope=${scope ?? 'all'} · interval=${intervalMs}ms · tail=${tail} · press Esc/q to stop`}
      </Text>
      <Text color={theme.secondaryText}>{`status=${status}`}</Text>
      {meta ? (
        <Text color={theme.secondaryText}>
          {`trace=${meta.scope} session=${meta.sessionId} file=${meta.filename} v${meta.version} saved=${formatSavedAt(savedAt)}`}
        </Text>
      ) : null}
      <Box flexDirection="column" marginTop={1}>
        {lines.length > 0 ? (
          lines.map((line, index) => (
            <Box key={`live-line-${index}`}>
              <Text color={theme.secondaryText}>{`⎿  ${line}`}</Text>
            </Box>
          ))
        ) : (
          <Text color={theme.secondaryText}>⎿  No events streamed yet.</Text>
        )}
      </Box>
    </Box>
  )
}
