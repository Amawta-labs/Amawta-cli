export type RequestStatusKind = 'idle' | 'thinking' | 'streaming' | 'tool'

export type RequestStatus = {
  kind: RequestStatusKind
  detail?: string
  updatedAt: number
  requestStartedAt: number | null
}

let requestStartedAt: number | null = null
let current: RequestStatus = {
  kind: 'idle',
  updatedAt: Date.now(),
  requestStartedAt: null,
}
const listeners = new Set<(status: RequestStatus) => void>()

export function getRequestStatus(): RequestStatus {
  return current
}

export function setRequestStatus(
  status: Omit<RequestStatus, 'updatedAt' | 'requestStartedAt'>,
): void {
  const now = Date.now()
  if (status.kind === 'idle') {
    requestStartedAt = null
  } else if (requestStartedAt === null) {
    requestStartedAt = now
  }
  current = { ...status, updatedAt: now, requestStartedAt }
  for (const listener of listeners) listener(current)
}

export function subscribeRequestStatus(
  listener: (status: RequestStatus) => void,
): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}
