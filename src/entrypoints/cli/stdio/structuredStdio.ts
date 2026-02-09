import { AmawtaAgentStructuredStdio } from '@utils/protocol/agentStructuredStdio'

export function createPrintModeStructuredStdio(args: {
  enabled: boolean
  stdin: any
  stdout: any
  onInterrupt: () => void
  onControlRequest: (msg: any) => Promise<any>
}): AmawtaAgentStructuredStdio | null {
  if (!args.enabled) return null

  return new AmawtaAgentStructuredStdio(args.stdin, args.stdout, {
    onInterrupt: args.onInterrupt,
    onControlRequest: args.onControlRequest,
  })
}
