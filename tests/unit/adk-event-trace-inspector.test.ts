import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { Part } from '@google/genai'
import {
  formatPathForDisplay,
  getAdkEventTraceDetailFromSummary,
  getLatestAdkEventTraceDetail,
  listAdkEventTraceSummaries,
} from '@services/ai/adkEventTraceInspector'
import { LocalFsArtifactService } from '@services/ai/localFsArtifactService'

function jsonPart(payload: unknown): Part {
  return {
    inlineData: {
      mimeType: 'application/json',
      data: Buffer.from(JSON.stringify(payload), 'utf8').toString('base64'),
    },
  }
}

describe('adkEventTraceInspector', () => {
  let rootDir = ''
  let artifactService: LocalFsArtifactService

  beforeEach(() => {
    rootDir = mkdtempSync(join(tmpdir(), 'amawta-adk-event-inspector-'))
    artifactService = new LocalFsArtifactService({ rootDir })
  })

  afterEach(() => {
    rmSync(rootDir, { recursive: true, force: true })
  })

  test('lists summaries for event trace artifacts and returns latest detail', async () => {
    const base = {
      appName: 'AmawtaAdkOrchestratorV1',
      userId: 'amawta-main-user',
      sessionId: 'adk_session_1',
    }

    const orchestratorPayloadV1 = {
      scope: 'orchestrator',
      conversationKey: 'chat-main',
      capturedCount: 3,
      droppedCount: 0,
      events: [{ id: 'e1', author: 'AmawtaOrchestrator' }],
    }
    const orchestratorPayloadV2 = {
      scope: 'orchestrator',
      conversationKey: 'chat-main',
      capturedCount: 5,
      droppedCount: 1,
      events: [{ id: 'e2', author: 'AmawtaOrchestrator' }],
    }

    await artifactService.saveArtifact({
      ...base,
      filename: 'orchestrator-events.json',
      artifact: jsonPart(orchestratorPayloadV1),
    })
    await artifactService.saveArtifact({
      ...base,
      filename: 'orchestrator-events.json',
      artifact: jsonPart(orchestratorPayloadV2),
    })

    await artifactService.saveArtifact({
      ...base,
      filename: 'dialectical-events.json',
      artifact: jsonPart({
        scope: 'dialectical',
        conversationKey: 'chat-main',
        capturedCount: 2,
        droppedCount: 0,
        events: [{ id: 'd1', author: 'DialecticalAnalyzer' }],
      }),
    })

    const summaries = await listAdkEventTraceSummaries({ rootDir })
    expect(summaries.length).toBe(2)
    expect(summaries[0]?.filename.endsWith('-events.json')).toBe(true)

    const orchestratorOnly = await listAdkEventTraceSummaries({
      rootDir,
      scope: 'orchestrator',
    })
    expect(orchestratorOnly.length).toBe(1)
    expect(orchestratorOnly[0]?.latestVersion).toBe(1)
    expect(orchestratorOnly[0]?.versionCount).toBe(2)
    expect(orchestratorOnly[0]?.capturedCount).toBe(5)

    const latestOrchestrator = await getLatestAdkEventTraceDetail({
      rootDir,
      scope: 'orchestrator',
    })
    expect(latestOrchestrator).not.toBeNull()
    expect(latestOrchestrator?.events.length).toBe(1)
    expect(latestOrchestrator?.conversationKey).toBe('chat-main')
  })

  test('formats home path with tilde when applicable', () => {
    const rendered = formatPathForDisplay(rootDir)
    expect(typeof rendered).toBe('string')
    expect(rendered.length).toBeGreaterThan(0)
  })

  test('supports normalization/falsification scopes and detail from summary', async () => {
    const base = {
      appName: 'AmawtaAdkOrchestratorV1',
      userId: 'amawta-main-user',
      sessionId: 'adk_session_nf',
    }

    await artifactService.saveArtifact({
      ...base,
      filename: 'normalization-events.json',
      artifact: jsonPart({
        scope: 'normalization',
        conversationKey: 'conv-normalization',
        capturedCount: 1,
        droppedCount: 0,
        events: [{ id: 'n1', author: 'NormalizationAgent' }],
      }),
    })
    await artifactService.saveArtifact({
      ...base,
      filename: 'falsification-events.json',
      artifact: jsonPart({
        scope: 'falsification',
        conversationKey: 'conv-falsification',
        capturedCount: 1,
        droppedCount: 0,
        events: [{ id: 'f1', author: 'FalsificationAgent' }],
      }),
    })
    await artifactService.saveArtifact({
      ...base,
      filename: 'runners-events.json',
      artifact: jsonPart({
        scope: 'runners',
        conversationKey: 'conv-runners',
        capturedCount: 2,
        droppedCount: 0,
        events: [{ id: 'r1', author: 'ExperimentRunnersBuilder' }],
      }),
    })

    const normalizationOnly = await listAdkEventTraceSummaries({
      rootDir,
      scope: 'normalization',
    })
    expect(normalizationOnly.length).toBe(1)
    expect(normalizationOnly[0]?.scope).toBe('normalization')

    const detail = await getAdkEventTraceDetailFromSummary(
      normalizationOnly[0]!,
    )
    expect(detail).not.toBeNull()
    expect(detail?.events.length).toBe(1)
    expect(detail?.events[0]?.author).toBe('NormalizationAgent')

    const runnersOnly = await listAdkEventTraceSummaries({
      rootDir,
      scope: 'runners',
    })
    expect(runnersOnly.length).toBe(1)
    expect(runnersOnly[0]?.scope).toBe('runners')
  })

  test('falls back to payload scope when filename scope is unknown', async () => {
    const base = {
      appName: 'AmawtaAdkOrchestratorV1',
      userId: 'amawta-main-user',
      sessionId: 'adk_session_payload_scope',
    }

    await artifactService.saveArtifact({
      ...base,
      filename: 'custom-events.json',
      artifact: jsonPart({
        scope: 'falsification',
        conversationKey: 'conv-custom',
        capturedCount: 1,
        droppedCount: 0,
        events: [{ id: 'cf1', author: 'FalsificationAgent' }],
      }),
    })

    const falsificationOnly = await listAdkEventTraceSummaries({
      rootDir,
      scope: 'falsification',
    })

    expect(falsificationOnly.length).toBe(1)
    expect(falsificationOnly[0]?.scope).toBe('falsification')
    expect(falsificationOnly[0]?.filename).toBe('custom-events.json')
  })
})
