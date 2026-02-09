import { randomUUID } from 'crypto'

let currentSessionId: string = randomUUID()

export function setAmawtaAgentSessionId(nextSessionId: string): void {
  currentSessionId = nextSessionId
}

export function resetAmawtaAgentSessionIdForTests(): void {
  currentSessionId = randomUUID()
}

export function getAmawtaAgentSessionId(): string {
  return currentSessionId
}
