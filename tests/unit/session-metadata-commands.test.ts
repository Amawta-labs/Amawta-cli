import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import rename from '@commands/rename'
import tag from '@commands/tag'
import {
  getAmawtaAgentSessionId,
  resetAmawtaAgentSessionIdForTests,
  setAmawtaAgentSessionId,
} from '@utils/protocol/agentSessionId'
import {
  getCurrentSessionCustomTitle,
  getCurrentSessionTag,
  getSessionLogFilePath,
  resetSessionJsonlStateForTests,
} from '@utils/protocol/agentSessionLog'
import { loadAmawtaAgentSessionLogData } from '@utils/protocol/agentSessionLoad'
import { setCwd } from '@utils/state'

describe('/rename + /tag (session metadata records)', () => {
  const originalConfigDir = process.env.AMAWTA_CONFIG_DIR
  const runnerCwd = process.cwd()

  let configDir: string
  let projectDir: string

  beforeEach(async () => {
    resetSessionJsonlStateForTests()
    setAmawtaAgentSessionId('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa')
    configDir = mkdtempSync(join(tmpdir(), 'amawta-session-metadata-config-'))
    projectDir = mkdtempSync(join(tmpdir(), 'amawta-session-metadata-project-'))
    process.env.AMAWTA_CONFIG_DIR = configDir
    await setCwd(projectDir)
  })

  afterEach(async () => {
    await setCwd(runnerCwd)
    resetSessionJsonlStateForTests()
    resetAmawtaAgentSessionIdForTests()
    if (originalConfigDir === undefined) {
      delete process.env.AMAWTA_CONFIG_DIR
    } else {
      process.env.AMAWTA_CONFIG_DIR = originalConfigDir
    }
    rmSync(configDir, { recursive: true, force: true })
    rmSync(projectDir, { recursive: true, force: true })
  })

  test('persists custom-title and tag records for current session', async () => {
    const ctx = {} as any

    const renameOut = await rename.call('My Session', ctx)
    expect(renameOut).toContain('Session renamed to:')
    expect(getCurrentSessionCustomTitle()).toBe('My Session')

    const tagOut = await tag.call('pr', ctx)
    expect(tagOut).toContain('Session tagged as:')
    expect(getCurrentSessionTag()).toBe('pr')

    const logPath = getSessionLogFilePath({
      cwd: projectDir,
      sessionId: getAmawtaAgentSessionId(),
    })
    const lines = readFileSync(logPath, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map(l => JSON.parse(l))

    expect(
      lines.some(
        l => l.type === 'custom-title' && l.customTitle === 'My Session',
      ),
    ).toBe(true)
    expect(lines.some(l => l.type === 'tag' && l.tag === 'pr')).toBe(true)

    const data = loadAmawtaAgentSessionLogData({
      cwd: projectDir,
      sessionId: getAmawtaAgentSessionId(),
    })
    expect(data.customTitles.get(getAmawtaAgentSessionId())).toBe('My Session')
    expect(data.tags.get(getAmawtaAgentSessionId())).toBe('pr')
  })
})
