import { ToolResultBlockParam } from '@anthropic-ai/sdk/resources/index.mjs'
import { Box } from 'ink'
import { Text } from 'ink'
import * as React from 'react'
import { Tool } from '@tool'
import { Message, UserMessage } from '@query'
import { getTheme } from '@utils/theme'
import { useGetToolFromMessages } from './utils'

type Props = {
  param: ToolResultBlockParam
  message: UserMessage
  messages: Message[]
  verbose: boolean
  tools: Tool[]
  width: number | string
}

export function UserToolSuccessMessage({
  param,
  message,
  messages,
  tools,
  verbose,
  width,
}: Props): React.ReactNode {
  const { tool } = useGetToolFromMessages(param.tool_use_id, tools, messages)
  const theme = getTheme()
  const isInternal = message.toolUseResult?.visibility === 'internal'

  if (isInternal) {
    const toolLabel = tool?.userFacingName?.() || tool?.name || 'tool'
    const evidence = message.toolUseResult?.evidence
    const evidenceLabel =
      evidence && typeof evidence.status === 'string'
        ? ` · status ${evidence.status}`
        : ''
    return (
      <Box flexDirection="column" width={width}>
        <Text color={theme.secondaryText}>
          {`Internal result captured (${toolLabel}${evidenceLabel})`}
        </Text>
      </Box>
    )
  }

  return (
    <Box flexDirection="column" width={width}>
      {tool.renderToolResultMessage?.(message.toolUseResult!.data as never, {
        verbose,
      })}
    </Box>
  )
}
