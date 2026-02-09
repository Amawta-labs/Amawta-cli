import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readdirSync,
  rmSync,
  utimesSync,
} from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  __testOnly,
  buildDeterministicAdkSessionId,
  loadAdkPersistedState,
  saveAdkPersistedState,
} from '@services/ai/adkStateStore'

describe('adkStateStore', () => {
  let configDir = ''
  const originalAmawtaConfigDir = process.env.AMAWTA_CONFIG_DIR

  beforeEach(() => {
    configDir = mkdtempSync(join(tmpdir(), 'amawta-adk-state-'))
    process.env.AMAWTA_CONFIG_DIR = configDir
  })

  afterEach(() => {
    rmSync(configDir, { recursive: true, force: true })

    if (originalAmawtaConfigDir === undefined) {
      delete process.env.AMAWTA_CONFIG_DIR
    } else {
      process.env.AMAWTA_CONFIG_DIR = originalAmawtaConfigDir
    }
  })

  test('returns empty object when state file does not exist', () => {
    const loaded = loadAdkPersistedState({
      namespace: 'adk-dialectical-v1',
      conversationKey: 'chat:1:main',
    })

    expect(loaded).toEqual({})
  })

  test('persists and loads state for same namespace+conversation key', () => {
    saveAdkPersistedState(
      {
        namespace: 'adk-dialectical-v1',
        conversationKey: 'chat:1:main',
      },
      {
        'temp:last_step': 'dialectical',
        dialectical_runs: 2,
      },
    )

    const loaded = loadAdkPersistedState({
      namespace: 'adk-dialectical-v1',
      conversationKey: 'chat:1:main',
    })

    expect(loaded['temp:last_step']).toBe('dialectical')
    expect(loaded.dialectical_runs).toBe(2)
  })

  test('isolates state between different conversation keys', () => {
    saveAdkPersistedState(
      {
        namespace: 'adk-dialectical-v1',
        conversationKey: 'chat:1:main',
      },
      { branch: 'A' },
    )

    saveAdkPersistedState(
      {
        namespace: 'adk-dialectical-v1',
        conversationKey: 'chat:2:main',
      },
      { branch: 'B' },
    )

    const branchA = loadAdkPersistedState({
      namespace: 'adk-dialectical-v1',
      conversationKey: 'chat:1:main',
    })
    const branchB = loadAdkPersistedState({
      namespace: 'adk-dialectical-v1',
      conversationKey: 'chat:2:main',
    })

    expect(branchA.branch).toBe('A')
    expect(branchB.branch).toBe('B')
  })

  test('builds deterministic adk session id from namespace and conversation key', () => {
    const first = buildDeterministicAdkSessionId(
      'adk-dialectical-v1',
      'chat:1:main',
    )
    const second = buildDeterministicAdkSessionId(
      'adk-dialectical-v1',
      'chat:1:main',
    )
    const third = buildDeterministicAdkSessionId(
      'adk-dialectical-v1',
      'chat:2:main',
    )

    expect(first).toBe(second)
    expect(first).not.toBe(third)
    expect(first.startsWith('adk_')).toBe(true)
  })

  test('removes stale lock and persists state successfully', () => {
    const key = {
      namespace: 'adk-dialectical-v1',
      conversationKey: 'chat:stale-lock',
    }
    const stateFilePath = __testOnly.getStateFilePath(key)
    const lockPath = `${stateFilePath}.lock`
    mkdirSync(lockPath, { recursive: true })
    const stale = new Date(Date.now() - 60_000)
    utimesSync(lockPath, stale, stale)

    saveAdkPersistedState(key, { status: 'ok-after-stale-lock' })

    const loaded = loadAdkPersistedState(key)
    expect(loaded.status).toBe('ok-after-stale-lock')
    expect(existsSync(lockPath)).toBe(false)
  })

  test('does not leave temporary files after atomic save', () => {
    const key = {
      namespace: 'adk-dialectical-v1',
      conversationKey: 'chat:atomic-save',
    }
    saveAdkPersistedState(key, { marker: 'atomic' })
    const stateDir = join(configDir, 'adk-state')
    const files = readdirSync(stateDir)

    expect(files.some(name => name.includes('.tmp-'))).toBe(false)
  })
})
