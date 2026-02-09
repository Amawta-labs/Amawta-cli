import React from 'react'
import { Box, Text } from 'ink'
import { Select } from './custom-select/select'
import { getTheme } from '@utils/theme'
import { useTerminalSize } from '@hooks/useTerminalSize'
import { formatDate } from '@utils/log'
import type { AmawtaAgentSessionListItem } from '@utils/protocol/agentSessionResume'
import TextInput from './TextInput'

type SessionSelectorProps = {
  sessions: AmawtaAgentSessionListItem[]
  onSelect: (index: number) => void
}

export function SessionSelector({
  sessions,
  onSelect,
}: SessionSelectorProps): React.ReactNode {
  const { rows, columns } = useTerminalSize()
  const [query, setQuery] = React.useState('')
  const [cursorOffset, setCursorOffset] = React.useState(0)
  if (sessions.length === 0) return null

  const normalizedQuery = query.trim().toLowerCase()
  const filteredSessions = sessions.filter(session => {
    if (!normalizedQuery) return true
    const haystack = [
      session.sessionId,
      session.slug ?? '',
      session.customTitle ?? '',
      session.summary ?? '',
      session.tag ?? '',
      session.cwd ?? '',
      session.branch ?? '',
    ]
      .join(' ')
      .toLowerCase()
    return haystack.includes(normalizedQuery)
  })

  const visibleCount = Math.max(5, rows - 11)
  const hiddenCount = Math.max(0, filteredSessions.length - visibleCount)

  const indexWidth = 7
  const modifiedWidth = 22
  const branchWidth = 14

  const options = filteredSessions.map((s, filteredIndex) => {
    const originalIndex = sessions.indexOf(s)
    const index = `[${filteredIndex}]`.padEnd(indexWidth)
    const modified = formatDate(
      s.modifiedAt ?? s.createdAt ?? new Date(0),
    ).padEnd(modifiedWidth + 1)
    const branch = (s.branch ?? '-').padEnd(branchWidth)

    const name = s.customTitle ?? s.slug ?? s.sessionId
    const summary = s.summary ? s.summary.split('\n')[0] : ''

    const labelTxt = `${index}${modified}${branch}${name}${summary ? ` · ${summary}` : ''}`
    const truncated =
      labelTxt.length > columns - 2
        ? `${labelTxt.slice(0, columns - 5)}...`
        : labelTxt

    return { label: truncated, value: String(originalIndex) }
  })

  return (
    <Box flexDirection="column" height="100%" width="100%">
      <Box flexDirection="column" marginBottom={1}>
        <Text bold color={getTheme().text}>
          Select a session
        </Text>
        <Text color={getTheme().secondaryText}>Type to search</Text>
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
        <Text color={getTheme().secondaryText}>
          Use arrows and Enter to confirm.
        </Text>
      </Box>
      <Box paddingLeft={9} marginBottom={1}>
        <Text bold color={getTheme().text}>
          Updated
        </Text>
        <Text>{'             '}</Text>
        <Text bold color={getTheme().text}>
          Branch
        </Text>
        <Text>{'      '}</Text>
        <Text bold color={getTheme().text}>
          Conversation
        </Text>
      </Box>
      {options.length > 0 ? (
        <>
          <Select
            options={options}
            onChange={value => onSelect(parseInt(value, 10))}
            visibleOptionCount={visibleCount}
            highlightText={query.trim().length > 0 ? query.trim() : undefined}
          />
          {hiddenCount > 0 && (
            <Box paddingLeft={2}>
              <Text color={getTheme().secondaryText}>
                and {hiddenCount} more…
              </Text>
            </Box>
          )}
        </>
      ) : (
        <Box paddingLeft={2}>
          <Text color={getTheme().secondaryText}>
            No sessions match your search.
          </Text>
        </Box>
      )}
    </Box>
  )
}
