import { Box, Text } from 'ink'
import React, { useMemo } from 'react'
import { Select } from '@components/custom-select/select'
import { getTheme } from '@utils/theme'
import {
  PermissionRequestTitle,
  textColorForRiskScore,
} from './PermissionRequestTitle'
import { logUnaryEvent } from '@utils/log/unaryLogging'
import { env } from '@utils/config/env'
import { getCwd } from '@utils/state'
import { savePermission } from '@permissions'
import {
  type ToolUseConfirm,
  toolUseConfirmGetPrefix,
} from './PermissionRequest'
import chalk from 'chalk'
import {
  UnaryEvent,
  usePermissionRequestLogging,
} from '@hooks/usePermissionRequestLogging'

type Props = {
  toolUseConfirm: ToolUseConfirm
  onDone(): void
  verbose: boolean
}

export function FallbackPermissionRequest({
  toolUseConfirm,
  onDone,
  verbose,
}: Props): React.ReactNode {
  const theme = getTheme()

  const originalUserFacingName = toolUseConfirm.tool.userFacingName()
  const userFacingName = originalUserFacingName.endsWith(' (MCP)')
    ? originalUserFacingName.slice(0, -6)
    : originalUserFacingName

  const unaryEvent = useMemo<UnaryEvent>(
    () => ({
      completion_type: 'tool_use_single',
      language_name: 'none',
    }),
    [],
  )

  usePermissionRequestLogging(toolUseConfirm, unaryEvent)

  const toolInvocation = `${userFacingName}(${toolUseConfirm.tool.renderToolUseMessage(
    toolUseConfirm.input as never,
    { verbose },
  )})`

  const summarize = (value: string, max = 220): string => {
    if (!value) return value
    if (value.length <= max) return value
    const head = Math.ceil(max * 0.65)
    const tail = Math.max(0, max - head - 1)
    return `${value.slice(0, head)}…${value.slice(value.length - tail)}`
  }

  const shortInvocation = summarize(toolInvocation)
  const shortDescription = summarize(toolUseConfirm.description, 240)
  const workspace = getCwd()

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={textColorForRiskScore(toolUseConfirm.riskScore)}
      marginTop={1}
      paddingLeft={1}
      paddingRight={1}
      paddingBottom={1}
    >
      <PermissionRequestTitle
        title="Amawta Tool Gate"
        riskScore={toolUseConfirm.riskScore}
      />
      <Box flexDirection="column" paddingX={2} paddingY={1}>
        <Box
          flexDirection="column"
          borderStyle="round"
          borderColor={theme.secondaryBorder}
          paddingX={1}
          paddingY={0}
        >
          <Text color={theme.secondaryText}>
            Tool: <Text color={theme.text}>{userFacingName}</Text>
            {originalUserFacingName.endsWith(' (MCP)') ? (
              <Text color={theme.secondaryText}> (MCP)</Text>
            ) : (
              ''
            )}
          </Text>
          <Text color={theme.secondaryText}>
            Action: <Text color={theme.text}>{shortInvocation}</Text>
          </Text>
          <Text color={theme.secondaryText}>
            Intent: <Text color={theme.text}>{shortDescription}</Text>
          </Text>
          <Text color={theme.secondaryText}>
            Scope: <Text color={theme.text}>{workspace}</Text>
          </Text>
        </Box>
      </Box>

      <Box flexDirection="column">
        <Text>Approve this action?</Text>
        <Select
          options={[
            {
              label: 'Approve once',
              value: 'yes',
            },
            {
              label: `Always allow ${chalk.bold(userFacingName)} in ${chalk.bold(workspace)}`,
              value: 'yes-dont-ask-again',
            },
            {
              label: `Deny and provide instructions (${chalk.bold.hex(getTheme().warning)('esc')})`,
              value: 'no',
            },
          ]}
          onChange={newValue => {
            switch (newValue) {
              case 'yes':
                logUnaryEvent({
                  completion_type: 'tool_use_single',
                  event: 'accept',
                  metadata: {
                    language_name: 'none',
                    message_id: toolUseConfirm.assistantMessage.message.id,
                    platform: env.platform,
                  },
                })
                toolUseConfirm.onAllow('temporary')
                onDone()
                break
              case 'yes-dont-ask-again':
                logUnaryEvent({
                  completion_type: 'tool_use_single',
                  event: 'accept',
                  metadata: {
                    language_name: 'none',
                    message_id: toolUseConfirm.assistantMessage.message.id,
                    platform: env.platform,
                  },
                })
                savePermission(
                  toolUseConfirm.tool,
                  toolUseConfirm.input,
                  toolUseConfirmGetPrefix(toolUseConfirm),
                  toolUseConfirm.toolUseContext,
                ).then(() => {
                  toolUseConfirm.onAllow('permanent')
                  onDone()
                })
                break
              case 'no':
                logUnaryEvent({
                  completion_type: 'tool_use_single',
                  event: 'reject',
                  metadata: {
                    language_name: 'none',
                    message_id: toolUseConfirm.assistantMessage.message.id,
                    platform: env.platform,
                  },
                })
                toolUseConfirm.onReject()
                onDone()
                break
            }
          }}
        />
      </Box>
    </Box>
  )
}
