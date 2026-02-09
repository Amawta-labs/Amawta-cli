import { createHash } from 'crypto'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'fs'
import { homedir } from 'os'
import { dirname, join } from 'path'
import { debug as debugLogger } from '@utils/log/debugLogger'
import { logError } from '@utils/log'

type PersistedAdkStateRecord = {
  version: 1
  namespace: string
  conversationKey: string
  updatedAt: number
  state: Record<string, unknown>
}

type AdkPersistedStateKey = {
  namespace: string
  conversationKey?: string
}

const FALLBACK_CONVERSATION_KEY = 'default'
const STATE_LOCK_TIMEOUT_MS = 2_000
const STATE_LOCK_STALE_MS = 45_000
const STATE_LOCK_RETRY_MS = 15

function getConfigDir(): string {
  return (
    process.env.AMAWTA_CONFIG_DIR ??
    process.env.CLAUDE_CONFIG_DIR ??
    join(homedir(), '.amawta')
  )
}

function getAdkStateDir(): string {
  const dir = join(getConfigDir(), 'adk-state')
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }
  return dir
}

function normalizeConversationKey(conversationKey?: string): string {
  const trimmed = conversationKey?.trim()
  if (!trimmed) return FALLBACK_CONVERSATION_KEY
  return trimmed
}

function normalizeNamespace(namespace: string): string {
  const trimmed = String(namespace ?? '').trim()
  if (!trimmed) return 'default'

  const safe = trimmed.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64)
  return safe || 'default'
}

function buildStateFilename(namespace: string, conversationKey: string): string {
  const safeNamespace = normalizeNamespace(namespace)
  const digest = createHash('sha1')
    .update(`${safeNamespace}::${conversationKey}`)
    .digest('hex')
    .slice(0, 20)

  return `${safeNamespace}-${digest}.json`
}

function getStateFilePath(key: AdkPersistedStateKey): string {
  const namespace = normalizeNamespace(key.namespace)
  const conversationKey = normalizeConversationKey(key.conversationKey)
  return join(getAdkStateDir(), buildStateFilename(namespace, conversationKey))
}

function sleepSync(ms: number): void {
  if (ms <= 0) return
  try {
    const lock = new Int32Array(new SharedArrayBuffer(4))
    Atomics.wait(lock, 0, 0, ms)
  } catch {
    const until = Date.now() + ms
    while (Date.now() < until) {
      // fallback spin loop when Atomics.wait is unavailable
    }
  }
}

function isLockStale(lockPath: string): boolean {
  try {
    const details = statSync(lockPath)
    return Date.now() - details.mtimeMs > STATE_LOCK_STALE_MS
  } catch {
    return false
  }
}

function acquireStateFileLock(filePath: string): () => void {
  const lockPath = `${filePath}.lock`
  const deadline = Date.now() + STATE_LOCK_TIMEOUT_MS

  while (true) {
    try {
      mkdirSync(lockPath)
      return () => {
        try {
          rmSync(lockPath, { recursive: true, force: true })
        } catch {
          // no-op release best effort
        }
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException)?.code
      if (code !== 'EEXIST') {
        throw error
      }

      if (isLockStale(lockPath)) {
        try {
          rmSync(lockPath, { recursive: true, force: true })
        } catch {
          // ignore; next loop iteration will retry
        }
        continue
      }

      if (Date.now() >= deadline) {
        throw new Error(`Timed out acquiring ADK state lock: ${lockPath}`)
      }
      sleepSync(STATE_LOCK_RETRY_MS)
    }
  }
}

function writeJsonAtomically(filePath: string, payload: string): void {
  const parentDir = dirname(filePath)
  if (!existsSync(parentDir)) {
    mkdirSync(parentDir, { recursive: true })
  }

  const tempPath = `${filePath}.tmp-${process.pid}-${Date.now()}-${Math.random()
    .toString(16)
    .slice(2)}`

  try {
    writeFileSync(tempPath, payload, 'utf8')
    renameSync(tempPath, filePath)
  } finally {
    if (existsSync(tempPath)) {
      try {
        rmSync(tempPath, { force: true })
      } catch {
        // no-op cleanup best effort
      }
    }
  }
}

function ensureSerializableState(
  state: Record<string, unknown> | undefined,
): Record<string, unknown> {
  try {
    const normalized = JSON.parse(
      JSON.stringify(state ?? {}),
    ) as Record<string, unknown>

    if (!normalized || typeof normalized !== 'object') {
      return {}
    }

    return normalized
  } catch (error) {
    logError(error)
    debugLogger.warn('ADK_STATE_SERIALIZE_FAILED', {
      error: error instanceof Error ? error.message : String(error),
    })
    return {}
  }
}

export function loadAdkPersistedState(
  key: AdkPersistedStateKey,
): Record<string, unknown> {
  const filePath = getStateFilePath(key)
  if (!existsSync(filePath)) {
    return {}
  }

  try {
    const raw = readFileSync(filePath, 'utf8')
    const parsed = JSON.parse(raw) as Partial<PersistedAdkStateRecord>

    if (!parsed || typeof parsed !== 'object') {
      return {}
    }

    if (!parsed.state || typeof parsed.state !== 'object') {
      return {}
    }

    return ensureSerializableState(parsed.state as Record<string, unknown>)
  } catch (error) {
    logError(error)
    debugLogger.warn('ADK_STATE_LOAD_FAILED', {
      namespace: key.namespace,
      conversationKey: normalizeConversationKey(key.conversationKey),
      error: error instanceof Error ? error.message : String(error),
    })
    return {}
  }
}

export function saveAdkPersistedState(
  key: AdkPersistedStateKey,
  state: Record<string, unknown> | undefined,
): void {
  const namespace = normalizeNamespace(key.namespace)
  const conversationKey = normalizeConversationKey(key.conversationKey)
  const filePath = getStateFilePath({ namespace, conversationKey })

  const envelope: PersistedAdkStateRecord = {
    version: 1,
    namespace,
    conversationKey,
    updatedAt: Date.now(),
    state: ensureSerializableState(state),
  }

  let releaseLock: (() => void) | undefined
  try {
    releaseLock = acquireStateFileLock(filePath)
    writeJsonAtomically(filePath, JSON.stringify(envelope, null, 2))
  } catch (error) {
    logError(error)
    debugLogger.warn('ADK_STATE_SAVE_FAILED', {
      namespace,
      conversationKey,
      error: error instanceof Error ? error.message : String(error),
    })
  } finally {
    releaseLock?.()
  }
}

export function buildDeterministicAdkSessionId(
  namespace: string,
  conversationKey?: string,
): string {
  const safeNamespace = normalizeNamespace(namespace)
  const normalizedConversation = normalizeConversationKey(conversationKey)
  const digest = createHash('sha1')
    .update(`${safeNamespace}::${normalizedConversation}`)
    .digest('hex')
    .slice(0, 28)

  return `adk_${digest}`
}

export const __testOnly = {
  normalizeConversationKey,
  normalizeNamespace,
  buildStateFilename,
  getStateFilePath,
}
