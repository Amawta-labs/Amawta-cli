import { createHash } from 'crypto'
import { existsSync, mkdirSync } from 'fs'
import { readdir, readFile, rm, stat, writeFile } from 'fs/promises'
import { homedir, tmpdir } from 'os'
import { join } from 'path'
import type {
  BaseArtifactService,
  DeleteArtifactRequest,
  ListArtifactKeysRequest,
  ListVersionsRequest,
  LoadArtifactRequest,
  SaveArtifactRequest,
} from '@google/adk'
import type { Part } from '@google/genai'

type ArtifactEnvelope = {
  version: number
  savedAt: number
  artifact: Part
}

type ArtifactMetadata = {
  filename: string
  appName: string
  userId: string
  sessionId: string
  userScoped: boolean
}

const VERSION_FILE_PATTERN = /^v(\d+)\.json$/

function getConfigDir(): string {
  return (
    process.env.AMAWTA_CONFIG_DIR ??
    process.env.AMAWTA_CONFIG_DIR ??
    join(homedir(), '.amawta')
  )
}

function getArtifactsRootDir(): string {
  const primaryDir = join(getConfigDir(), 'adk-artifacts')
  try {
    if (!existsSync(primaryDir)) {
      mkdirSync(primaryDir, { recursive: true })
    }
    return primaryDir
  } catch {
    const fallbackDir = join(tmpdir(), 'amawta', 'adk-artifacts')
    if (!existsSync(fallbackDir)) {
      mkdirSync(fallbackDir, { recursive: true })
    }
    return fallbackDir
  }
}

function hasUserNamespace(filename: string): boolean {
  return filename.startsWith('user:')
}

function sanitizeForPath(raw: string): string {
  const normalized = String(raw ?? '').trim() || 'default'
  const safeLabel = normalized
    .replace(/[^a-zA-Z0-9._-]/g, '_')
    .replace(/_+/g, '_')
    .slice(0, 60)
  const digest = createHash('sha1').update(normalized).digest('hex').slice(0, 12)
  return `${safeLabel || 'default'}-${digest}`
}

function toArtifactDirectory(params: {
  rootDir: string
  appName: string
  userId: string
  sessionId: string
  filename: string
}): string {
  const appSegment = sanitizeForPath(params.appName)
  const userSegment = sanitizeForPath(params.userId)
  const fileSegment = sanitizeForPath(params.filename)

  if (hasUserNamespace(params.filename)) {
    return join(params.rootDir, appSegment, userSegment, 'user', fileSegment)
  }

  const sessionSegment = sanitizeForPath(params.sessionId)
  return join(
    params.rootDir,
    appSegment,
    userSegment,
    sessionSegment,
    fileSegment,
  )
}

function toArtifactVersionsDirectory(artifactDir: string): string {
  return join(artifactDir, 'versions')
}

function toNamespaceDirectory(params: {
  rootDir: string
  appName: string
  userId: string
  sessionId: string
}): string {
  const appSegment = sanitizeForPath(params.appName)
  const userSegment = sanitizeForPath(params.userId)
  const sessionSegment = sanitizeForPath(params.sessionId)
  return join(params.rootDir, appSegment, userSegment, sessionSegment)
}

function toUserNamespaceDirectory(params: {
  rootDir: string
  appName: string
  userId: string
}): string {
  const appSegment = sanitizeForPath(params.appName)
  const userSegment = sanitizeForPath(params.userId)
  return join(params.rootDir, appSegment, userSegment, 'user')
}

async function readJsonFile<T>(filePath: string): Promise<T | null> {
  try {
    const raw = await readFile(filePath, 'utf8')
    return JSON.parse(raw) as T
  } catch {
    return null
  }
}

async function listArtifactDirectories(root: string): Promise<string[]> {
  try {
    const entries = await readdir(root, { withFileTypes: true })
    return entries.filter(entry => entry.isDirectory()).map(entry => entry.name)
  } catch {
    return []
  }
}

async function listVersionsInDirectory(artifactDir: string): Promise<number[]> {
  const versionsDir = toArtifactVersionsDirectory(artifactDir)
  try {
    const entries = await readdir(versionsDir, { withFileTypes: true })
    return entries
      .filter(entry => entry.isFile())
      .map(entry => VERSION_FILE_PATTERN.exec(entry.name))
      .filter((match): match is RegExpExecArray => Boolean(match))
      .map(match => Number.parseInt(match[1] ?? '', 10))
      .filter(Number.isFinite)
      .sort((a, b) => a - b)
  } catch {
    return []
  }
}

async function ensureDirectory(path: string): Promise<void> {
  if (!existsSync(path)) {
    mkdirSync(path, { recursive: true })
    return
  }

  const details = await stat(path)
  if (!details.isDirectory()) {
    throw new Error(`Artifact path exists but is not a directory: ${path}`)
  }
}

export class LocalFsArtifactService implements BaseArtifactService {
  private readonly rootDir: string

  constructor(options?: { rootDir?: string }) {
    this.rootDir = options?.rootDir || getArtifactsRootDir()
    if (!existsSync(this.rootDir)) {
      mkdirSync(this.rootDir, { recursive: true })
    }
  }

  getRootDir(): string {
    return this.rootDir
  }

  getSessionDirectory(params: {
    appName: string
    userId: string
    sessionId: string
  }): string {
    return toNamespaceDirectory({
      rootDir: this.rootDir,
      appName: params.appName,
      userId: params.userId,
      sessionId: params.sessionId,
    })
  }

  async saveArtifact({
    appName,
    userId,
    sessionId,
    filename,
    artifact,
  }: SaveArtifactRequest): Promise<number> {
    const artifactDir = toArtifactDirectory({
      rootDir: this.rootDir,
      appName,
      userId,
      sessionId,
      filename,
    })
    const versionsDir = toArtifactVersionsDirectory(artifactDir)

    await ensureDirectory(artifactDir)
    await ensureDirectory(versionsDir)

    const existingVersions = await listVersionsInDirectory(artifactDir)
    const version =
      existingVersions.length > 0
        ? existingVersions[existingVersions.length - 1] + 1
        : 0

    const envelope: ArtifactEnvelope = {
      version,
      savedAt: Date.now(),
      artifact: JSON.parse(JSON.stringify(artifact)) as Part,
    }

    const metadata: ArtifactMetadata = {
      filename,
      appName,
      userId,
      sessionId,
      userScoped: hasUserNamespace(filename),
    }

    const versionFile = join(versionsDir, `v${version}.json`)
    const metadataFile = join(artifactDir, 'meta.json')
    await writeFile(versionFile, JSON.stringify(envelope, null, 2), 'utf8')
    await writeFile(metadataFile, JSON.stringify(metadata, null, 2), 'utf8')

    return version
  }

  async loadArtifact({
    appName,
    userId,
    sessionId,
    filename,
    version,
  }: LoadArtifactRequest): Promise<Part | undefined> {
    const artifactDir = toArtifactDirectory({
      rootDir: this.rootDir,
      appName,
      userId,
      sessionId,
      filename,
    })

    const versions = await listVersionsInDirectory(artifactDir)
    if (versions.length === 0) {
      return undefined
    }

    const selectedVersion =
      typeof version === 'number' ? version : versions[versions.length - 1]
    if (!versions.includes(selectedVersion)) {
      return undefined
    }

    const versionFile = join(
      toArtifactVersionsDirectory(artifactDir),
      `v${selectedVersion}.json`,
    )
    const envelope = await readJsonFile<ArtifactEnvelope>(versionFile)
    if (!envelope || typeof envelope !== 'object') {
      return undefined
    }

    return envelope.artifact
  }

  async listArtifactKeys({
    appName,
    userId,
    sessionId,
  }: ListArtifactKeysRequest): Promise<string[]> {
    const sessionDir = toNamespaceDirectory({
      rootDir: this.rootDir,
      appName,
      userId,
      sessionId,
    })
    const userDir = toUserNamespaceDirectory({
      rootDir: this.rootDir,
      appName,
      userId,
    })

    const sessionArtifactDirs = await listArtifactDirectories(sessionDir)
    const userArtifactDirs = await listArtifactDirectories(userDir)

    const keys = new Set<string>()
    const allDirs = [
      ...sessionArtifactDirs.map(dir => join(sessionDir, dir)),
      ...userArtifactDirs.map(dir => join(userDir, dir)),
    ]

    for (const dir of allDirs) {
      const metadata = await readJsonFile<ArtifactMetadata>(join(dir, 'meta.json'))
      const filename = metadata?.filename
      if (typeof filename === 'string' && filename.trim().length > 0) {
        keys.add(filename)
      }
    }

    return Array.from(keys).sort()
  }

  async deleteArtifact({
    appName,
    userId,
    sessionId,
    filename,
  }: DeleteArtifactRequest): Promise<void> {
    const artifactDir = toArtifactDirectory({
      rootDir: this.rootDir,
      appName,
      userId,
      sessionId,
      filename,
    })
    await rm(artifactDir, { recursive: true, force: true })
  }

  async listVersions({
    appName,
    userId,
    sessionId,
    filename,
  }: ListVersionsRequest): Promise<number[]> {
    const artifactDir = toArtifactDirectory({
      rootDir: this.rootDir,
      appName,
      userId,
      sessionId,
      filename,
    })
    return listVersionsInDirectory(artifactDir)
  }
}

export const __testOnly = {
  sanitizeForPath,
  toArtifactDirectory,
  toArtifactVersionsDirectory,
  toNamespaceDirectory,
  toUserNamespaceDirectory,
  hasUserNamespace,
}
