import { Command } from '@commands'
import { getAmawtaAgentSessionId } from '@utils/protocol/agentSessionId'
import { appendSessionCustomTitleRecord } from '@utils/protocol/agentSessionLog'

const rename = {
  type: 'local',
  name: 'rename',
  description: 'Set a custom title for the current session',
  isEnabled: true,
  isHidden: false,
  userFacingName() {
    return 'rename'
  },
  async call(args, _context) {
    const customTitle = args.trim()
    if (!customTitle) return 'Usage: /rename <title>'

    appendSessionCustomTitleRecord({
      sessionId: getAmawtaAgentSessionId(),
      customTitle,
    })

    return `Session renamed to: ${customTitle}`
  },
} satisfies Command

export default rename
