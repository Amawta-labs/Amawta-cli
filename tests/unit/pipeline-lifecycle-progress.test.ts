import { describe, expect, test } from 'bun:test'

import { __queryTestOnly } from '../../src/app/query'
import { createAssistantMessage } from '@utils/messages'

describe('pipeline lifecycle progress', () => {
  test('emits start progress text for experiment runners', () => {
    const text = __queryTestOnly.buildPipelineToolStartProgress(
      'ExperimentRunners',
      { hypothesis_query: 'test claim' },
    )

    expect(text).toContain('Plan:')
    expect(text).toContain('ExperimentRunners')
  })

  test('emits completion text with next action when present', () => {
    const text = __queryTestOnly.buildPipelineToolCompletionProgress(
      'FalsificationPlan',
      {
        planStatus: 'ready',
        overallMatch: 'moderate',
        nextAction: 'Run runners',
      },
    )

    expect(text).toContain('Done:')
    expect(text).toContain('status=ready')
    expect(text).toContain('Next: Run runners')
  })

  test('emits doing progress text for pipeline tools', () => {
    const text = __queryTestOnly.buildPipelineToolDoingProgress('FalsificationPlan')
    expect(text).toContain('In progress:')
    expect(text).toContain('FalsificationPlan')
  })

  test('uses fallback next action for experiment runners when missing explicit nextAction', () => {
    const text = __queryTestOnly.buildPipelineToolCompletionProgress(
      'ExperimentRunners',
      {
        gates: {
          stageDecision: 'NEEDS_FIELD',
        },
      },
    )

    expect(text).toContain('Done:')
    expect(text).toContain('Next:')
    expect(text).toContain('field')
  })

  test('uses stop fallback when REJECT_EARLY is driven by toy FAIL', () => {
    const text = __queryTestOnly.buildPipelineToolCompletionProgress(
      'ExperimentRunners',
      {
        gates: {
          stageDecision: 'REJECT_EARLY',
          toy: { truthAssessment: 'FAIL' },
        },
      },
    )

    expect(text).toContain('Done:')
    expect(text).toContain('Stop: toy falsified the claim')
  })

  test('emits lifecycle narration for pipeline tools regardless of agent scope', () => {
    expect(
      __queryTestOnly.shouldEmitPipelineLifecycleProgress('WebSearch', {
        agentId: 'main',
      }),
    ).toBe(true)
    expect(
      __queryTestOnly.shouldEmitPipelineLifecycleProgress('WebSearch', {
        agentId: 'worker-1',
      }),
    ).toBe(true)
  })

  test('removes stale restart line when previous stage already completed', () => {
    const priorMessages = [
      {
        type: 'user',
        uuid: 'u-claim',
        message: { role: 'user', content: 'probemos esta hipotesis' },
      },
      {
        type: 'user',
        uuid: 'u-result',
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'd-1', content: 'ok' }],
        },
        toolUseResult: {
          stage: 'dialectical',
          resultForAssistant: 'ok',
          data: {},
          visibility: 'public',
        },
      },
    ] as any

    const candidate = createAssistantMessage(
      'Comenzaré con el análisis dialéctico de tu hipótesis.\nAhora procederé con el análisis baconiano.',
    )
    const sanitized = __queryTestOnly.sanitizeStaleStageRestartNarration(
      candidate as any,
      priorMessages,
    )
    const text = ((sanitized as any).message.content[0] as any).text as string

    expect(text).not.toContain('Comenzaré con el análisis dialéctico')
    expect(text).toContain('Ahora procederé con el análisis baconiano')
  })

  test('keeps non-restart analytical line for the same completed stage', () => {
    const priorMessages = [
      {
        type: 'user',
        uuid: 'u-result',
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'd-1', content: 'ok' }],
        },
        toolUseResult: {
          stage: 'dialectical',
          resultForAssistant: 'ok',
          data: {},
          visibility: 'public',
        },
      },
    ] as any

    const candidate = createAssistantMessage(
      'El análisis dialéctico sugiere una síntesis robusta y ahora toca validar con Baconian.',
    )
    const sanitized = __queryTestOnly.sanitizeStaleStageRestartNarration(
      candidate as any,
      priorMessages,
    )
    const text = ((sanitized as any).message.content[0] as any).text as string

    expect(text).toContain('El análisis dialéctico sugiere una síntesis robusta')
  })

  test('drops single-line accented restart narration after same stage completion', () => {
    const priorMessages = [
      {
        type: 'user',
        uuid: 'u-result',
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'd-1', content: 'ok' }],
        },
        toolUseResult: {
          stage: 'dialectical',
          resultForAssistant: 'ok',
          data: {},
          visibility: 'public',
        },
      },
    ] as any

    const candidate = createAssistantMessage(
      'Comenzaré con el análisis dialéctico de tu hipótesis.',
    )
    const sanitized = __queryTestOnly.sanitizeStaleStageRestartNarration(
      candidate as any,
      priorMessages,
    )
    const text = ((sanitized as any).message.content[0] as any).text as string

    expect(text).toBe('')
  })

  test('collapses duplicated auto-repair boilerplate in narration', () => {
    const priorMessages = [
      {
        type: 'user',
        uuid: 'u-result',
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'd-1', content: 'ok' }],
        },
        toolUseResult: {
          stage: 'falsification',
          resultForAssistant: 'ok',
          data: {},
          visibility: 'public',
        },
      },
    ] as any

    const candidate = createAssistantMessage(
      'Auto-repair: executing mandatory evidence-pipeline steps.Auto-repair: executing mandatory evidence-pipeline steps.',
    )
    const sanitized = __queryTestOnly.sanitizeStaleStageRestartNarration(
      candidate as any,
      priorMessages,
    )
    const text = ((sanitized as any).message.content[0] as any).text as string

    expect(text).toBe('Auto-repair: executing mandatory evidence-pipeline steps.')
  })

  test('marks strict obligations for forced autoloop safety window', () => {
    expect(
      __queryTestOnly.isStrictHypothesisEvidenceObligation(
        'run_falsification_plan',
      ),
    ).toBe(true)
    expect(
      __queryTestOnly.isStrictHypothesisEvidenceObligation(
        'run_experiment_runners',
      ),
    ).toBe(true)
    expect(
      __queryTestOnly.isStrictHypothesisEvidenceObligation(
        'autorepair_failed_critical_tests',
      ),
    ).toBe(true)
  })

  test('does not mark non-strict obligations as forced autoloop', () => {
    expect(
      __queryTestOnly.isStrictHypothesisEvidenceObligation(
        'ask_dataset_decision',
      ),
    ).toBe(true)
    expect(
      __queryTestOnly.isStrictHypothesisEvidenceObligation(
        'collect_field_evidence',
      ),
    ).toBe(false)
    expect(__queryTestOnly.isStrictHypothesisEvidenceObligation(undefined)).toBe(
      false,
    )
  })
})
