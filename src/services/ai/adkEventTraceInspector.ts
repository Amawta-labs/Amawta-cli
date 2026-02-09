import { Dirent, existsSync } from 'fs'
import { readdir, readFile } from 'fs/promises'
import { homedir } from 'os'
import { join } from 'path'
import { LocalFsArtifactService } from './localFsArtifactService'

const VERSION_FILE_PATTERN = /^v(\d+)\.json$/

type TraceScope =
  | 'orchestrator'
  | 'dialectical'
  | 'baconian'
  | 'normalization'
  | 'falsification'
  | 'runners'
  | 'unknown'

type ArtifactMetadata = {
  filename: string
  appName: string
  userId: string
  sessionId: string
}

type ArtifactEnvelope = {
  version: number
  savedAt: number
  artifact?: {
    inlineData?: {
      data?: string
    }
  }
}

type EventTracePayload = {
  scope?: string
  conversationKey?: string
  capturedCount?: number
  droppedCount?: number
  events?: Record<string, unknown>[]
}

export type AdkEventTraceSummary = {
  scope: TraceScope
  appName: string
  userId: string
  sessionId: string
  filename: string
  conversationKey?: string
  capturedCount?: number
  droppedCount?: number
  latestVersion: number
  versionCount: number
  savedAt: number
  artifactDirectory: string
  versionFilePath: string
}

export type AdkEventTraceDetail = AdkEventTraceSummary & {
  events: Record<string, unknown>[]
}

function parseScopeFromFilename(filename: string): TraceScope {
  if (filename.startsWith('orchestrator-')) return 'orchestrator'
  if (filename.startsWith('dialectical-')) return 'dialectical'
  if (filename.startsWith('baconian-')) return 'baconian'
  if (filename.startsWith('normalization-')) return 'normalization'
  if (filename.startsWith('falsification-')) return 'falsification'
  if (filename.startsWith('runners-')) return 'runners'
  return 'unknown'
}

function parseScopeFromPayloadValue(value: unknown): TraceScope {
  if (typeof value !== 'string') return 'unknown'
  const normalized = value.trim().toLowerCase()
  if (
    normalized === 'orchestrator' ||
    normalized === 'dialectical' ||
    normalized === 'baconian' ||
    normalized === 'normalization' ||
    normalized === 'falsification' ||
    normalized === 'runners'
  ) {
    return normalized
  }
  return 'unknown'
}

function toObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  return value as Record<string, unknown>
}

function toOptionalString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

function toOptionalNumber(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined
  return value
}

function decodePayloadFromEnvelope(
  envelope: ArtifactEnvelope,
): EventTracePayload | null {
  const data = envelope?.artifact?.inlineData?.data
  if (typeof data !== 'string' || data.length === 0) return null

  try {
    const raw = Buffer.from(data, 'base64').toString('utf8')
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null
    }
    return parsed as EventTracePayload
  } catch {
    return null
  }
}

async function readJsonFile<T>(path: string): Promise<T | null> {
  try {
    const raw = await readFile(path, 'utf8')
    return JSON.parse(raw) as T
  } catch {
    return null
  }
}

async function findArtifactDirectoriesWithMeta(rootDir: string): Promise<string[]> {
  if (!existsSync(rootDir)) return []

  const pending = [rootDir]
  const found: string[] = []

  while (pending.length > 0) {
    const current = pending.pop() as string
    let entries: Dirent[]
    try {
      entries = await readdir(current, {
        withFileTypes: true,
        encoding: 'utf8',
      })
    } catch {
      continue
    }

    let hasMeta = false
    for (const entry of entries) {
      if (entry.isFile() && entry.name === 'meta.json') {
        hasMeta = true
      }
      if (entry.isDirectory()) {
        pending.push(join(current, entry.name))
      }
    }

    if (hasMeta) {
      found.push(current)
    }
  }

  return found
}

async function listAvailableVersions(artifactDirectory: string): Promise<number[]> {
  const versionsDir = join(artifactDirectory, 'versions')
  let entries: Dirent[]
  try {
    entries = await readdir(versionsDir, {
      withFileTypes: true,
      encoding: 'utf8',
    })
  } catch {
    return []
  }

  return entries
    .filter(entry => entry.isFile())
    .map(entry => VERSION_FILE_PATTERN.exec(entry.name))
    .filter((match): match is RegExpExecArray => Boolean(match))
    .map(match => Number.parseInt(match[1] ?? '', 10))
    .filter(Number.isFinite)
    .sort((a, b) => a - b)
}

function resolveArtifactsRootDir(rootDir?: string): string {
  if (rootDir && rootDir.trim().length > 0) return rootDir
  const service = new LocalFsArtifactService()
  return service.getRootDir()
}

function normalizeScope(scope?: string): TraceScope | undefined {
  const normalized = (scope || '').trim().toLowerCase()
  if (!normalized || normalized === 'all') return undefined
  if (
    normalized === 'orchestrator' ||
    normalized === 'dialectical' ||
    normalized === 'baconian' ||
    normalized === 'normalization' ||
    normalized === 'falsification' ||
    normalized === 'runners'
  ) {
    return normalized
  }
  return 'unknown'
}

function matchesRequestedScope(
  candidate: TraceScope,
  requested: TraceScope | undefined,
): boolean {
  if (!requested) return true
  return candidate === requested
}

function toEventsArray(payload: EventTracePayload | null): Record<string, unknown>[] {
  if (!payload || !Array.isArray(payload.events)) return []
  return payload.events.filter(
    event => event && typeof event === 'object' && !Array.isArray(event),
  ) as Record<string, unknown>[]
}

async function buildSummaryFromArtifactDirectory(params: {
  artifactDirectory: string
  requestedScope?: TraceScope
}): Promise<AdkEventTraceDetail | null> {
  const metadata = await readJsonFile<ArtifactMetadata>(
    join(params.artifactDirectory, 'meta.json'),
  )
  if (!metadata || typeof metadata.filename !== 'string') return null
  if (!metadata.filename.endsWith('-events.json')) return null

  const versions = await listAvailableVersions(params.artifactDirectory)
  if (versions.length === 0) return null

  const latestVersion = versions[versions.length - 1]
  const versionFilePath = join(
    params.artifactDirectory,
    'versions',
    `v${latestVersion}.json`,
  )
  const envelope = await readJsonFile<ArtifactEnvelope>(versionFilePath)
  if (!envelope) return null

  const payload = decodePayloadFromEnvelope(envelope)
  const payloadObject = toObject(payload)
  const filenameScope = parseScopeFromFilename(metadata.filename)
  const payloadScope = parseScopeFromPayloadValue(payloadObject.scope)
  const scope = filenameScope !== 'unknown' ? filenameScope : payloadScope
  if (!matchesRequestedScope(scope, params.requestedScope)) return null
  const events = toEventsArray(payload)

  return {
    scope,
    appName: metadata.appName,
    userId: metadata.userId,
    sessionId: metadata.sessionId,
    filename: metadata.filename,
    conversationKey: toOptionalString(payloadObject.conversationKey),
    capturedCount: toOptionalNumber(payloadObject.capturedCount),
    droppedCount: toOptionalNumber(payloadObject.droppedCount),
    latestVersion,
    versionCount: versions.length,
    savedAt:
      toOptionalNumber(envelope.savedAt) ??
      toOptionalNumber(payloadObject.capturedAt) ??
      0,
    artifactDirectory: params.artifactDirectory,
    versionFilePath,
    events,
  }
}

export async function listAdkEventTraceSummaries(options?: {
  scope?: string
  limit?: number
  rootDir?: string
}): Promise<AdkEventTraceSummary[]> {
  const rootDir = resolveArtifactsRootDir(options?.rootDir)
  const requestedScope = normalizeScope(options?.scope)

  const artifactDirectories = await findArtifactDirectoriesWithMeta(rootDir)
  const details = await Promise.all(
    artifactDirectories.map(artifactDirectory =>
      buildSummaryFromArtifactDirectory({
        artifactDirectory,
        requestedScope,
      }),
    ),
  )

  const summaries = details
    .filter((detail): detail is AdkEventTraceDetail => Boolean(detail))
    .sort((a, b) => b.savedAt - a.savedAt)
    .map(detail => ({
      scope: detail.scope,
      appName: detail.appName,
      userId: detail.userId,
      sessionId: detail.sessionId,
      filename: detail.filename,
      conversationKey: detail.conversationKey,
      capturedCount: detail.capturedCount,
      droppedCount: detail.droppedCount,
      latestVersion: detail.latestVersion,
      versionCount: detail.versionCount,
      savedAt: detail.savedAt,
      artifactDirectory: detail.artifactDirectory,
      versionFilePath: detail.versionFilePath,
    }))

  const limit =
    typeof options?.limit === 'number' && Number.isFinite(options.limit)
      ? Math.max(1, Math.floor(options.limit))
      : summaries.length

  return summaries.slice(0, limit)
}

export async function getLatestAdkEventTraceDetail(options?: {
  scope?: string
  rootDir?: string
}): Promise<AdkEventTraceDetail | null> {
  const rootDir = resolveArtifactsRootDir(options?.rootDir)
  const requestedScope = normalizeScope(options?.scope)
  const artifactDirectories = await findArtifactDirectoriesWithMeta(rootDir)

  const details = await Promise.all(
    artifactDirectories.map(artifactDirectory =>
      buildSummaryFromArtifactDirectory({
        artifactDirectory,
        requestedScope,
      }),
    ),
  )

  const filtered = details.filter(
    (detail): detail is AdkEventTraceDetail => Boolean(detail),
  )
  if (filtered.length === 0) return null

  filtered.sort((a, b) => b.savedAt - a.savedAt)
  return filtered[0]
}

export async function getAdkEventTraceDetailFromSummary(
  summary: AdkEventTraceSummary,
): Promise<AdkEventTraceDetail | null> {
  const requestedScope = normalizeScope(summary.scope)
  return buildSummaryFromArtifactDirectory({
    artifactDirectory: summary.artifactDirectory,
    requestedScope,
  })
}

export function formatPathForDisplay(path: string): string {
  const home = homedir()
  if (path.startsWith(home)) {
    return `~${path.slice(home.length)}`
  }
  return path
}

export function getAdkEventArtifactsRootDir(rootDir?: string): string {
  return resolveArtifactsRootDir(rootDir)
}

export const __testOnly = {
  parseScopeFromFilename,
  parseScopeFromPayloadValue,
  normalizeScope,
  decodePayloadFromEnvelope,
  toObject,
  toOptionalNumber,
  toOptionalString,
}
