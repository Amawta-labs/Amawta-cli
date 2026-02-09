import { describe, expect, test } from 'bun:test'

import { getRequestStatus, setRequestStatus } from '../../src/utils/session/requestStatus'

describe('request status', () => {
  test('keeps requestStartedAt across non-idle transitions', () => {
    setRequestStatus({ kind: 'idle' })
    setRequestStatus({ kind: 'thinking' })
    const start = getRequestStatus().requestStartedAt

    setRequestStatus({ kind: 'tool', detail: 'ExperimentRunners' })
    const afterTool = getRequestStatus().requestStartedAt

    expect(start).not.toBeNull()
    expect(afterTool).toBe(start)
  })

  test('clears requestStartedAt on idle', () => {
    setRequestStatus({ kind: 'thinking' })
    expect(getRequestStatus().requestStartedAt).not.toBeNull()

    setRequestStatus({ kind: 'idle' })
    expect(getRequestStatus().requestStartedAt).toBeNull()
  })
})

