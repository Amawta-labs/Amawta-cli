import React from 'react'
import { Box, Text, useInput } from 'ink'
import TextInput from '@components/TextInput'
import { Select } from '@components/custom-select/select'
import { useTerminalSize } from '@hooks/useTerminalSize'
import { getTheme } from '@utils/theme'
import type { AdkEventTraceSummary } from '@services/ai/adkEventTraceInspector'

type EventTraceSelectorProps = {
  traces: AdkEventTraceSummary[]
  onSelect: (trace: AdkEventTraceSummary) => void | Promise<void>
  onCancel: () => void
}

function formatSavedAt(timestamp: number): string {
  if (!Number.isFinite(timestamp) || timestamp <= 0) return 'unknown'
  try {
    return new Date(timestamp).toISOString()
  } catch {
    return 'unknown'
  }
}

function truncateText(text: string, max: number): string {
  if (text.length <= max) return text
  if (max <= 3) return text.slice(0, max)
  return `${text.slice(0, max - 3)}...`
}

export function EventTraceSelector({
  traces,
  onSelect,
  onCancel,
}: EventTraceSelectorProps): React.ReactNode {
  const { rows, columns } = useTerminalSize()
  const theme = getTheme()
  const [query, setQuery] = React.useState('')
  const [cursorOffset, setCursorOffset] = React.useState(0)

  const normalizedQuery = query.trim().toLowerCase()
  const filteredTraces = React.useMemo(() => {
    if (!normalizedQuery) return traces
    return traces.filter(trace => {
      const haystack = [
        trace.scope,
        trace.appName,
        trace.userId,
        trace.sessionId,
        trace.filename,
        trace.conversationKey ?? '',
        formatSavedAt(trace.savedAt),
      ]
        .join(' ')
        .toLowerCase()
      return haystack.includes(normalizedQuery)
    })
  }, [normalizedQuery, traces])

  const visibleOptionCount = Math.max(5, rows - 11)
  const hiddenCount = Math.max(0, filteredTraces.length - visibleOptionCount)

  const options = filteredTraces.map((trace, filteredIndex) => {
    const updated = formatSavedAt(trace.savedAt).padEnd(26)
    const scope = trace.scope.padEnd(15)
    const conversation = `${trace.conversationKey ?? trace.sessionId} · ${trace.filename}`
    const label = `${String(filteredIndex).padStart(2, '0')}  ${updated}${scope}${truncateText(
      conversation,
      Math.max(20, columns - 50),
    )}`
    return {
      label,
      value: String(filteredIndex),
    }
  })

  useInput((_input, key) => {
    if (key.escape) {
      onCancel()
    }
  })

  return (
    <Box flexDirection="column" width="100%" height="100%">
      <Box flexDirection="column" marginBottom={1}>
        <Text bold color={theme.text}>
          Select a session
        </Text>
        <Text color={theme.secondaryText}>Type to search</Text>
        <TextInput
          placeholder="Type to search"
          value={query}
          onChange={setQuery}
          columns={Math.max(40, columns - 2)}
          cursorOffset={cursorOffset}
          onChangeCursorOffset={setCursorOffset}
          showCursor={true}
          focus={true}
        />
        <Text color={theme.secondaryText}>
          Use arrows and Enter to confirm.
        </Text>
      </Box>

      <Box paddingLeft={5} marginBottom={1}>
        <Text bold color={theme.text}>
          Updated
        </Text>
        <Text>{'                   '}</Text>
        <Text bold color={theme.text}>
          Scope
        </Text>
        <Text>{'        '}</Text>
        <Text bold color={theme.text}>
          Conversation
        </Text>
      </Box>

      {options.length > 0 ? (
        <>
          <Select
            options={options}
            onChange={value => {
              const index = Number.parseInt(value, 10)
              const selected = filteredTraces[index]
              if (!selected) return
              void onSelect(selected)
            }}
            visibleOptionCount={visibleOptionCount}
            highlightText={query.trim().length > 0 ? query.trim() : undefined}
          />
          {hiddenCount > 0 && (
            <Box paddingLeft={2}>
              <Text color={theme.secondaryText}>and {hiddenCount} more…</Text>
            </Box>
          )}
        </>
      ) : (
        <Box paddingLeft={2}>
          <Text color={theme.secondaryText}>No traces match your search.</Text>
        </Box>
      )}
    </Box>
  )
}
