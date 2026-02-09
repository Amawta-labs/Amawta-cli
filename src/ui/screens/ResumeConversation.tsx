import React from 'react'
import { render } from 'ink'
import { REPL } from './REPL'
import { SessionSelector } from '@components/SessionSelector'
import type { AmawtaAgentSessionListItem } from '@utils/protocol/agentSessionResume'
import { logError } from '@utils/log'
import type { Tool } from '@tool'
import { Command } from '@commands'
import { isDefaultSlowAndCapableModel } from '@utils/model'
import type { WrappedClient } from '@services/mcpClient'
import { loadAmawtaAgentSessionMessages } from '@utils/protocol/agentSessionLoad'
import { setAmawtaAgentSessionId } from '@utils/protocol/agentSessionId'
import { randomUUID } from 'crypto'
import { dateToFilename } from '@utils/log'

type Props = {
  cwd: string
  commands: Command[]
  context: { unmount?: () => void }
  sessions: AmawtaAgentSessionListItem[]
  tools: Tool[]
  verbose: boolean | undefined
  safeMode?: boolean
  debug?: boolean
  disableSlashCommands?: boolean
  mcpClients?: WrappedClient[]
  initialPrompt?: string
  forkSession?: boolean
  forkSessionId?: string | null
  initialUpdateVersion?: string | null
  initialUpdateCommands?: string[] | null
}

export function ResumeConversation({
  cwd,
  context,
  commands,
  sessions,
  tools,
  verbose,
  safeMode,
  debug,
  disableSlashCommands,
  mcpClients,
  initialPrompt,
  forkSession,
  forkSessionId,
  initialUpdateVersion,
  initialUpdateCommands,
}: Props): React.ReactNode {
  async function onSelect(index: number) {
    try {
      const selected = sessions[index]
      if (!selected) return
      context.unmount?.()

      const resumedFromSessionId = selected.sessionId
      const effectiveSessionId = forkSession
        ? forkSessionId?.trim() || randomUUID()
        : resumedFromSessionId
      setAmawtaAgentSessionId(effectiveSessionId)

      const messages = loadAmawtaAgentSessionMessages({
        cwd,
        sessionId: resumedFromSessionId,
      })
      const isDefaultModel = await isDefaultSlowAndCapableModel()

      render(
        <REPL
          commands={commands}
          debug={debug}
          disableSlashCommands={disableSlashCommands}
          initialPrompt={initialPrompt ?? ''}
          messageLogName={dateToFilename(new Date())}
          shouldShowPromptInput={true}
          verbose={verbose}
          tools={tools}
          safeMode={safeMode}
          mcpClients={mcpClients}
          initialMessages={messages as any}
          isDefaultModel={isDefaultModel}
          initialUpdateVersion={initialUpdateVersion}
          initialUpdateCommands={initialUpdateCommands}
        />,
        {
          exitOnCtrlC: false,
        },
      )
    } catch (e) {
      logError(`Failed to load conversation: ${e}`)
      throw e
    }
  }

  return <SessionSelector sessions={sessions} onSelect={onSelect} />
}
