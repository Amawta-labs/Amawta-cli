import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { Part } from '@google/genai'
import { LocalFsArtifactService } from '@services/ai/localFsArtifactService'

function jsonPart(payload: unknown): Part {
  return {
    inlineData: {
      mimeType: 'application/json',
      data: Buffer.from(JSON.stringify(payload), 'utf8').toString('base64'),
    },
  }
}

function findDirectoriesNamed(root: string, targetName: string): string[] {
  if (!existsSync(root)) return []
  const results: string[] = []
  const entries = readdirSync(root)
  for (const entry of entries) {
    const fullPath = join(root, entry)
    const details = statSync(fullPath)
    if (!details.isDirectory()) continue
    if (entry === targetName) {
      results.push(fullPath)
    }
    results.push(...findDirectoriesNamed(fullPath, targetName))
  }
  return results
}

describe('LocalFsArtifactService', () => {
  let rootDir = ''
  let service: LocalFsArtifactService

  beforeEach(() => {
    rootDir = mkdtempSync(join(tmpdir(), 'amawta-adk-artifacts-'))
    service = new LocalFsArtifactService({ rootDir })
  })

  afterEach(() => {
    rmSync(rootDir, { recursive: true, force: true })
  })

  test('saves and loads latest artifact version', async () => {
    const v0 = await service.saveArtifact({
      appName: 'Amawta',
      userId: 'user-1',
      sessionId: 'session-1',
      filename: 'dialectical-result.json',
      artifact: jsonPart({ step: 1 }),
    })

    const v1 = await service.saveArtifact({
      appName: 'Amawta',
      userId: 'user-1',
      sessionId: 'session-1',
      filename: 'dialectical-result.json',
      artifact: jsonPart({ step: 2 }),
    })

    expect(v0).toBe(0)
    expect(v1).toBe(1)

    const latest = await service.loadArtifact({
      appName: 'Amawta',
      userId: 'user-1',
      sessionId: 'session-1',
      filename: 'dialectical-result.json',
    })

    expect(latest?.inlineData?.mimeType).toBe('application/json')
    expect(latest?.inlineData?.data).toBe('eyJzdGVwIjoyfQ==')

    const sessionDirectory = service.getSessionDirectory({
      appName: 'Amawta',
      userId: 'user-1',
      sessionId: 'session-1',
    })
    expect(sessionDirectory.startsWith(rootDir)).toBe(true)
    const versionsDirs = findDirectoriesNamed(sessionDirectory, 'versions')
    expect(versionsDirs.length).toBeGreaterThan(0)
  })

  test('lists versions for an artifact', async () => {
    await service.saveArtifact({
      appName: 'Amawta',
      userId: 'user-1',
      sessionId: 'session-1',
      filename: 'baconian-result.json',
      artifact: jsonPart({ rev: 0 }),
    })
    await service.saveArtifact({
      appName: 'Amawta',
      userId: 'user-1',
      sessionId: 'session-1',
      filename: 'baconian-result.json',
      artifact: jsonPart({ rev: 1 }),
    })

    const versions = await service.listVersions({
      appName: 'Amawta',
      userId: 'user-1',
      sessionId: 'session-1',
      filename: 'baconian-result.json',
    })

    expect(versions).toEqual([0, 1])
  })

  test('lists both session and user namespaced artifact keys', async () => {
    await service.saveArtifact({
      appName: 'Amawta',
      userId: 'user-1',
      sessionId: 'session-A',
      filename: 'orchestrator-result.json',
      artifact: jsonPart({ route: 'dialectic' }),
    })

    await service.saveArtifact({
      appName: 'Amawta',
      userId: 'user-1',
      sessionId: 'session-Z',
      filename: 'user:profile-artifact.json',
      artifact: jsonPart({ theme: 'amawta' }),
    })

    const keys = await service.listArtifactKeys({
      appName: 'Amawta',
      userId: 'user-1',
      sessionId: 'session-A',
    })

    expect(keys).toContain('orchestrator-result.json')
    expect(keys).toContain('user:profile-artifact.json')
  })

  test('deletes artifact and clears versions', async () => {
    await service.saveArtifact({
      appName: 'Amawta',
      userId: 'user-1',
      sessionId: 'session-1',
      filename: 'dialectical-result.json',
      artifact: jsonPart({ value: 'x' }),
    })

    await service.deleteArtifact({
      appName: 'Amawta',
      userId: 'user-1',
      sessionId: 'session-1',
      filename: 'dialectical-result.json',
    })

    const versions = await service.listVersions({
      appName: 'Amawta',
      userId: 'user-1',
      sessionId: 'session-1',
      filename: 'dialectical-result.json',
    })
    const loaded = await service.loadArtifact({
      appName: 'Amawta',
      userId: 'user-1',
      sessionId: 'session-1',
      filename: 'dialectical-result.json',
    })

    expect(versions).toEqual([])
    expect(loaded).toBeUndefined()
  })
})
