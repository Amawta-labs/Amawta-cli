import { describe, expect, test } from 'bun:test'
import { __queryTestOnly } from '@query'

function mkAssistant(content: any[] = []): any {
  return {
    type: 'assistant',
    uuid: 'a-1',
    costUSD: 0,
    durationMs: 0,
    message: {
      id: 'm-1',
      model: '<test>',
      role: 'assistant',
      stop_reason: 'stop_sequence',
      stop_sequence: '',
      type: 'message',
      usage: { input_tokens: 0, output_tokens: 0 },
      content,
    },
  }
}

function mkUserPrompt(text: string): any {
  return {
    type: 'user',
    uuid: 'u-1',
    message: {
      role: 'user',
      content: text,
    },
  }
}

describe('hypothesis evidence gate', () => {
  test('requires FalsificationPlan when pipeline has runners signal but plan is missing', () => {
    const messages = [
      mkUserPrompt('probemos esta hipotesis de control no conmutativo'),
      {
        type: 'user',
        uuid: 'u-tool-r-only',
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'r-1', content: 'ok' }],
        },
        toolUseResult: {
          data: {
            planStatus: 'ready',
            runnersCount: 2,
            executionResults: [{ status: 'success' }],
            gates: { stageDecision: 'NEEDS_FIELD' },
          },
          evidence: {
            status: 'ready',
            stageDecision: 'NEEDS_FIELD',
          },
          resultForAssistant: 'ok',
          stage: 'experiment_runners',
          visibility: 'public',
        },
      },
      mkAssistant(),
    ] as any[]

    const gate = __queryTestOnly.buildHypothesisEvidenceGateInstruction(messages)
    expect(typeof gate).toBe('string')
    expect(gate).toContain('FalsificationPlan')
  })

  test('blocks finalization when falsification is ready but runners are missing', () => {
    const messages = [
      mkUserPrompt('probemos esta hipotesis de control no conmutativo'),
      {
        type: 'user',
        uuid: 'u-tool-f',
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'f-1', content: 'ok' }],
        },
        toolUseResult: {
          data: {
            planStatus: 'ready',
            testsCount: 5,
            variantsCount: 2,
          },
          resultForAssistant: 'ok',
          stage: 'falsification',
          visibility: 'public',
        },
      },
      mkAssistant(),
    ] as any[]

    const gate = __queryTestOnly.buildHypothesisEvidenceGateInstruction(messages)
    expect(typeof gate).toBe('string')
    expect(gate).toContain('ExperimentRunners')
  })

  test('does not block when runners are already ready in the same turn', () => {
    const messages = [
      mkUserPrompt('probemos esta hipotesis de control no conmutativo'),
      {
        type: 'user',
        uuid: 'u-tool-f',
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'f-1', content: 'ok' }],
        },
        toolUseResult: {
          data: {
            planStatus: 'ready',
            testsCount: 5,
            variantsCount: 2,
          },
          resultForAssistant: 'ok',
          stage: 'falsification',
          visibility: 'public',
        },
      },
      {
        type: 'user',
        uuid: 'u-tool-r',
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'r-1', content: 'ok' }],
        },
        toolUseResult: {
          data: {
            planStatus: 'ready',
            runnersCount: 2,
            executionResults: [{ status: 'success' }],
          },
          resultForAssistant: 'ok',
          stage: 'experiment_runners',
          visibility: 'public',
        },
      },
      mkAssistant(),
    ] as any[]

    const gate = __queryTestOnly.buildHypothesisEvidenceGateInstruction(messages)
    expect(gate).toBeNull()
  })

  test('forces autorepair when runners report REJECT_EARLY', () => {
    const messages = [
      mkUserPrompt('probemos esta hipotesis de control no conmutativo'),
      {
        type: 'user',
        uuid: 'u-tool-f',
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'f-1', content: 'ok' }],
        },
        toolUseResult: {
          data: {
            planStatus: 'ready',
            testsCount: 5,
            variantsCount: 2,
          },
          resultForAssistant: 'ok',
          stage: 'falsification',
          visibility: 'public',
        },
      },
      {
        type: 'user',
        uuid: 'u-tool-r',
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'r-1', content: 'ok' }],
        },
        toolUseResult: {
          data: {
            planStatus: 'ready',
            runnersCount: 2,
            executionResults: [{ status: 'failed' }],
            gates: { stageDecision: 'REJECT_EARLY' },
          },
          evidence: {
            status: 'ready',
            stageDecision: 'REJECT_EARLY',
          },
          resultForAssistant: 'ok',
          stage: 'experiment_runners',
          visibility: 'public',
        },
      },
      mkAssistant(),
    ] as any[]

    const gate = __queryTestOnly.buildHypothesisEvidenceGateInstruction(messages)
    expect(typeof gate).toBe('string')
    expect(gate).toContain('auto-repair')
    expect(gate).toContain('FalsificationPlan')
  })

  test('does not force autorepair when REJECT_EARLY is explicitly toy FAIL', () => {
    const messages = [
      mkUserPrompt('test hypothesis'),
      {
        type: 'user',
        uuid: 'u-tool-f',
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'f-1', content: 'ok' }],
        },
        toolUseResult: {
          data: {
            planStatus: 'ready',
            testsCount: 5,
            variantsCount: 2,
          },
          resultForAssistant: 'ok',
          stage: 'falsification',
          visibility: 'public',
        },
      },
      {
        type: 'user',
        uuid: 'u-tool-r',
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'r-1', content: 'ok' }],
        },
        toolUseResult: {
          data: {
            planStatus: 'ready',
            runnersCount: 2,
            executionResults: [{ status: 'success' }],
            gates: {
              stageDecision: 'REJECT_EARLY',
              toy: { truthAssessment: 'FAIL' },
            },
          },
          evidence: {
            status: 'ready',
            stageDecision: 'REJECT_EARLY',
            toyTruth: 'FAIL',
          },
          resultForAssistant: 'ok',
          stage: 'experiment_runners',
          visibility: 'public',
        },
      },
      mkAssistant(),
    ] as any[]

    const gate = __queryTestOnly.buildHypothesisEvidenceGateInstruction(messages)
    const hardBlock = __queryTestOnly.buildHypothesisEvidenceGateHardBlockMessage(
      messages,
    )
    expect(gate).toBeNull()
    expect(hardBlock).toBeNull()
  })

  test('requires AskUserQuestion when NEEDS_FIELD has no real dataset', () => {
    const messages = [
      mkUserPrompt('probemos esta hipotesis de control no conmutativo'),
      {
        type: 'user',
        uuid: 'u-tool-f',
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'f-1', content: 'ok' }],
        },
        toolUseResult: {
          data: {
            planStatus: 'ready',
            testsCount: 5,
            variantsCount: 2,
          },
          resultForAssistant: 'ok',
          stage: 'falsification',
          visibility: 'public',
        },
      },
      {
        type: 'user',
        uuid: 'u-tool-r',
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'r-1', content: 'ok' }],
        },
        toolUseResult: {
          data: {
            planStatus: 'ready',
            runnersCount: 2,
            executionResults: [{ status: 'success' }],
            gates: { stageDecision: 'NEEDS_FIELD' },
          },
          evidence: {
            status: 'ready',
            stageDecision: 'NEEDS_FIELD',
          },
          resultForAssistant: 'ok',
          stage: 'experiment_runners',
          visibility: 'public',
        },
      },
      mkAssistant(),
    ] as any[]

    const gate = __queryTestOnly.buildHypothesisEvidenceGateInstruction(messages)
    expect(typeof gate).toBe('string')
    expect(gate).toContain('AskUserQuestion')
    expect(gate).toContain('dataset')
  })

  test('requires AskUserQuestion when NEEDS_FIELD has real dataset but semantic mismatch', () => {
    const messages = [
      mkUserPrompt('hypothesis about gauge curvature and physical effort'),
      {
        type: 'user',
        uuid: 'u-tool-f',
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'f-1', content: 'ok' }],
        },
        toolUseResult: {
          data: {
            planStatus: 'ready',
            testsCount: 5,
            variantsCount: 2,
          },
          resultForAssistant: 'ok',
          stage: 'falsification',
          visibility: 'public',
        },
      },
      {
        type: 'user',
        uuid: 'u-tool-r',
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'r-1', content: 'ok' }],
        },
        toolUseResult: {
          data: {
            planStatus: 'ready',
            runnersCount: 2,
            executionResults: [{ status: 'success' }],
            gates: {
              stageDecision: 'NEEDS_FIELD',
              evidenceSufficiency: {
                hasRealDataset: true,
                claimDatasetFit: false,
              },
            },
          },
          evidence: {
            status: 'ready',
            stageDecision: 'NEEDS_FIELD',
            hasRealDataset: true,
            claimDatasetFit: false,
          },
          resultForAssistant: 'ok',
          stage: 'experiment_runners',
          visibility: 'public',
        },
      },
      mkAssistant(),
    ] as any[]

    const snapshot = __queryTestOnly.computeHypothesisEvidenceSnapshot(messages)
    expect(snapshot.hasRealDatasetEvidence).toBe(true)
    expect(snapshot.hasDatasetSemanticMismatch).toBe(true)
    expect(snapshot.pendingObligations).toContain('ask_dataset_decision')

    const gate = __queryTestOnly.buildHypothesisEvidenceGateInstruction(messages)
    expect(typeof gate).toBe('string')
    expect(gate).toContain('AskUserQuestion')
    expect(gate).toContain('relevant to the claim')
  })

  test('builds hard block message when NEEDS_FIELD has no real dataset', () => {
    const messages = [
      mkUserPrompt('probemos esta hipotesis de control no conmutativo'),
      {
        type: 'user',
        uuid: 'u-tool-f',
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'f-1', content: 'ok' }],
        },
        toolUseResult: {
          data: {
            planStatus: 'ready',
            testsCount: 5,
            variantsCount: 2,
          },
          resultForAssistant: 'ok',
          stage: 'falsification',
          visibility: 'public',
        },
      },
      {
        type: 'user',
        uuid: 'u-tool-r',
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'r-1', content: 'ok' }],
        },
        toolUseResult: {
          data: {
            planStatus: 'ready',
            runnersCount: 2,
            executionResults: [{ status: 'success' }],
            gates: {
              stageDecision: 'NEEDS_FIELD',
              evidenceSufficiency: {
                datasetUsed: true,
                hasRealDataset: false,
                nRows: 64,
                loboFolds: 4,
              },
            },
          },
          evidence: {
            status: 'ready',
            stageDecision: 'NEEDS_FIELD',
            hasRealDataset: false,
          },
          resultForAssistant: 'ok',
          stage: 'experiment_runners',
          visibility: 'public',
        },
      },
      mkAssistant(),
    ] as any[]

    const message =
      __queryTestOnly.buildHypothesisEvidenceGateHardBlockMessage(messages)
    expect(typeof message).toBe('string')
    expect(message).toContain('I cannot close')
    expect(message).toContain('AskUserQuestion')
  })

  test('does not re-request AskUserQuestion after dataset decision was answered', () => {
    const datasetQuestion =
      'No real dataset was resolved automatically for field phase. How do you want to continue?'
    const messages = [
      mkUserPrompt('En Palmer Penguins, controlando por especie y sexo...'),
      {
        type: 'user',
        uuid: 'u-tool-f',
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'f-1', content: 'ok' }],
        },
        toolUseResult: {
          data: {
            planStatus: 'ready',
            testsCount: 5,
            variantsCount: 2,
          },
          resultForAssistant: 'ok',
          stage: 'falsification',
          visibility: 'public',
        },
      },
      {
        type: 'user',
        uuid: 'u-tool-r',
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'r-1', content: 'ok' }],
        },
        toolUseResult: {
          data: {
            planStatus: 'ready',
            runnersCount: 2,
            executionResults: [{ status: 'success' }],
            gates: { stageDecision: 'NEEDS_FIELD' },
          },
          evidence: {
            status: 'ready',
            stageDecision: 'NEEDS_FIELD',
          },
          resultForAssistant: 'ok',
          stage: 'experiment_runners',
          visibility: 'public',
        },
      },
      {
        type: 'user',
        uuid: 'u-tool-selector',
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'q-1', content: 'ok' }],
        },
        toolUseResult: {
          toolName: 'AskUserQuestion',
          stage: 'other',
          visibility: 'public',
          resultForAssistant: 'selector answered',
          data: {
            questions: [
              {
                header: 'Dataset',
                question: datasetQuestion,
                options: [
                  {
                    label: 'Provide URL/path now (Recommended)',
                    description: 'You provide a real dataset and field is retried.',
                  },
                  {
                    label: 'Authorize extended web search',
                    description:
                      'Try additional web discovery of real datasets.',
                  },
                ],
                multiSelect: false,
              },
            ],
            answers: {
              [datasetQuestion]: 'Authorize extended web search',
            },
          },
        },
      },
      mkAssistant(),
    ] as any[]

    const snapshot = __queryTestOnly.computeHypothesisEvidenceSnapshot(messages)
    expect(snapshot.hasNeedsDatasetDecision).toBe(false)

    const gate = __queryTestOnly.buildHypothesisEvidenceGateInstruction(messages)
    expect(typeof gate).toBe('string')
    expect(gate).not.toContain('AskUserQuestion')
  })

  test('treats "validar con dataset local" as resolved dataset decision', () => {
    const datasetQuestion =
      'No real dataset was resolved automatically for field phase. How do you want to continue?'
    const messages = [
      mkUserPrompt('En Palmer Penguins, controlando por especie y sexo...'),
      {
        type: 'user',
        uuid: 'u-tool-f',
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'f-1', content: 'ok' }],
        },
        toolUseResult: {
          data: {
            planStatus: 'ready',
            testsCount: 5,
            variantsCount: 2,
          },
          resultForAssistant: 'ok',
          stage: 'falsification',
          visibility: 'public',
        },
      },
      {
        type: 'user',
        uuid: 'u-tool-r',
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'r-1', content: 'ok' }],
        },
        toolUseResult: {
          data: {
            planStatus: 'ready',
            runnersCount: 2,
            executionResults: [{ status: 'success' }],
            gates: { stageDecision: 'NEEDS_FIELD' },
          },
          evidence: {
            status: 'ready',
            stageDecision: 'NEEDS_FIELD',
          },
          resultForAssistant: 'ok',
          stage: 'experiment_runners',
          visibility: 'public',
        },
      },
      {
        type: 'user',
        uuid: 'u-tool-selector-local',
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'q-2', content: 'ok' }],
        },
        toolUseResult: {
          toolName: 'AskUserQuestion',
          stage: 'other',
          visibility: 'public',
          resultForAssistant: 'selector answered local dataset',
          data: {
            questions: [
              {
                header: 'Dataset',
                question: datasetQuestion,
                options: [
                  {
                    label: 'Validar con dataset local',
                    description: 'Usa dataset local',
                  },
                ],
                multiSelect: false,
              },
            ],
            answers: {
              [datasetQuestion]: 'Validar con dataset local',
            },
          },
        },
      },
      mkAssistant(),
    ] as any[]

    const snapshot = __queryTestOnly.computeHypothesisEvidenceSnapshot(messages)
    expect(snapshot.hasNeedsDatasetDecision).toBe(false)
    expect(snapshot.datasetDecisionAction).toBe('validate_local')
  })

  test('treats "Use local .csv files" as resolved local dataset decision', () => {
    const datasetQuestion =
      'No real dataset was resolved automatically for field phase. How do you want to continue?'
    const messages = [
      mkUserPrompt('under a convex functional with explicit costs...'),
      {
        type: 'user',
        uuid: 'u-tool-f',
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'f-1', content: 'ok' }],
        },
        toolUseResult: {
          data: {
            planStatus: 'ready',
            testsCount: 5,
            variantsCount: 2,
          },
          resultForAssistant: 'ok',
          stage: 'falsification',
          visibility: 'public',
        },
      },
      {
        type: 'user',
        uuid: 'u-tool-r',
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'r-1', content: 'ok' }],
        },
        toolUseResult: {
          data: {
            planStatus: 'ready',
            runnersCount: 2,
            executionResults: [{ status: 'success' }],
            gates: { stageDecision: 'NEEDS_FIELD' },
          },
          evidence: {
            status: 'ready',
            stageDecision: 'NEEDS_FIELD',
          },
          resultForAssistant: 'ok',
          stage: 'experiment_runners',
          visibility: 'public',
        },
      },
      {
        type: 'user',
        uuid: 'u-tool-selector-local-csv',
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'q-local-csv', content: 'ok' }],
        },
        toolUseResult: {
          toolName: 'AskUserQuestion',
          stage: 'other',
          visibility: 'public',
          resultForAssistant: 'selector answered use local csv files',
          data: {
            questions: [
              {
                header: 'Dataset',
                question: datasetQuestion,
                options: [
                  {
                    label: 'Use local .csv files',
                    description: 'Use local tabular files already present in the workspace.',
                  },
                ],
                multiSelect: false,
              },
            ],
            answers: {
              [datasetQuestion]: 'Use local .csv files',
            },
          },
        },
      },
      mkAssistant(),
    ] as any[]

    const snapshot = __queryTestOnly.computeHypothesisEvidenceSnapshot(messages)
    expect(snapshot.hasNeedsDatasetDecision).toBe(false)
    expect(snapshot.datasetDecisionAction).toBe('validate_local')
  })

  test('allows closure after synthetic provisional decision on PROVISIONAL_PASS', () => {
    const datasetQuestion =
      'No real dataset was resolved automatically for field phase. How do you want to continue?'
    const messages = [
      mkUserPrompt('In Palmer Penguins, controlling for species and sex...'),
      {
        type: 'user',
        uuid: 'u-tool-f',
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'f-1', content: 'ok' }],
        },
        toolUseResult: {
          data: {
            planStatus: 'ready',
            testsCount: 5,
            variantsCount: 2,
          },
          resultForAssistant: 'ok',
          stage: 'falsification',
          visibility: 'public',
        },
      },
      {
        type: 'user',
        uuid: 'u-tool-r',
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'r-1', content: 'ok' }],
        },
        toolUseResult: {
          data: {
            planStatus: 'ready',
            runnersCount: 2,
            executionResults: [{ status: 'success' }],
            gates: { stageDecision: 'PROVISIONAL_PASS' },
          },
          evidence: {
            status: 'ready',
            stageDecision: 'PROVISIONAL_PASS',
            hasRealDataset: false,
          },
          resultForAssistant: 'ok',
          stage: 'experiment_runners',
          visibility: 'public',
        },
      },
      {
        type: 'user',
        uuid: 'u-tool-selector-synth',
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'q-synth', content: 'ok' }],
        },
        toolUseResult: {
          toolName: 'AskUserQuestion',
          stage: 'other',
          visibility: 'public',
          resultForAssistant: 'selector answered synthetic provisional',
          data: {
            questions: [
              {
                header: 'Dataset',
                question: datasetQuestion,
                options: [
                  {
                    label: 'Usar sintetico provisional',
                    description: 'Permite avance provisional sin cierre definitivo.',
                  },
                ],
                multiSelect: false,
              },
            ],
            answers: {
              [datasetQuestion]: 'Usar sintetico provisional',
            },
          },
        },
      },
      mkAssistant(),
    ] as any[]

    const snapshot = __queryTestOnly.computeHypothesisEvidenceSnapshot(messages)
    expect(snapshot.datasetDecisionAction).toBe('synthetic_provisional')
    expect(snapshot.syntheticProvisionalAccepted).toBe(true)
    expect(snapshot.pendingObligations).toEqual([])

    const gate = __queryTestOnly.buildHypothesisEvidenceGateInstruction(messages)
    expect(gate).toBeNull()
  })

  test('keeps dataset decision unresolved when selector has no answers', () => {
    const datasetQuestion =
      'No real dataset was resolved automatically for field phase. How do you want to continue?'
    const messages = [
      mkUserPrompt('En Palmer Penguins, controlando por especie y sexo...'),
      {
        type: 'user',
        uuid: 'u-tool-f',
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'f-1', content: 'ok' }],
        },
        toolUseResult: {
          data: {
            planStatus: 'ready',
            testsCount: 5,
            variantsCount: 2,
          },
          resultForAssistant: 'ok',
          stage: 'falsification',
          visibility: 'public',
        },
      },
      {
        type: 'user',
        uuid: 'u-tool-r',
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'r-1', content: 'ok' }],
        },
        toolUseResult: {
          data: {
            planStatus: 'ready',
            runnersCount: 2,
            executionResults: [{ status: 'success' }],
            gates: { stageDecision: 'NEEDS_FIELD' },
          },
          evidence: {
            status: 'ready',
            stageDecision: 'NEEDS_FIELD',
          },
          resultForAssistant: 'ok',
          stage: 'experiment_runners',
          visibility: 'public',
        },
      },
      {
        type: 'user',
        uuid: 'u-tool-selector-empty',
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'q-empty', content: 'ok' }],
        },
        toolUseResult: {
          toolName: 'AskUserQuestion',
          stage: 'other',
          visibility: 'public',
          resultForAssistant: 'selector invoked but unanswered',
          data: {
            questions: [
              {
                header: 'Dataset',
                question: datasetQuestion,
                options: [
                  {
                    label: 'Proveer URL/ruta ahora (Recommended)',
                    description: 'Entregas un dataset real y se reintenta field.',
                  },
                  {
                    label: 'Autorizar busqueda web ampliada',
                    description:
                      'Intentamos discovery web adicional de datasets reales.',
                  },
                ],
                multiSelect: false,
              },
            ],
            answers: {},
          },
        },
      },
      mkAssistant(),
    ] as any[]

    const snapshot = __queryTestOnly.computeHypothesisEvidenceSnapshot(messages)
    expect(snapshot.hasNeedsDatasetDecision).toBe(true)

    const gate = __queryTestOnly.buildHypothesisEvidenceGateInstruction(messages)
    expect(typeof gate).toBe('string')
    expect(gate).toContain('AskUserQuestion')
  })

  test('builds hard block message when REJECT_EARLY requires autorepair', () => {
    const messages = [
      mkUserPrompt('probemos esta hipotesis de control no conmutativo'),
      {
        type: 'user',
        uuid: 'u-tool-f',
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'f-1', content: 'ok' }],
        },
        toolUseResult: {
          data: {
            planStatus: 'ready',
            testsCount: 5,
            variantsCount: 2,
          },
          resultForAssistant: 'ok',
          stage: 'falsification',
          visibility: 'public',
        },
      },
      {
        type: 'user',
        uuid: 'u-tool-r',
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'r-1', content: 'ok' }],
        },
        toolUseResult: {
          data: {
            planStatus: 'ready',
            runnersCount: 2,
            executionResults: [{ status: 'failed' }],
            gates: { stageDecision: 'REJECT_EARLY' },
          },
          evidence: {
            status: 'ready',
            stageDecision: 'REJECT_EARLY',
          },
          resultForAssistant: 'ok',
          stage: 'experiment_runners',
          visibility: 'public',
        },
      },
      mkAssistant(),
    ] as any[]

    const message =
      __queryTestOnly.buildHypothesisEvidenceGateHardBlockMessage(messages)
    expect(typeof message).toBe('string')
    expect(message).toContain('I cannot close')
    expect(message).toContain('auto-repair')
  })

  test('blocks positive closure when critical runner verdict is FAIL even with definitive pass', () => {
    const messages = [
      mkUserPrompt('probemos esta hipotesis de control no conmutativo'),
      {
        type: 'user',
        uuid: 'u-tool-f',
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'f-1', content: 'ok' }],
        },
        toolUseResult: {
          data: {
            planStatus: 'ready',
            testsCount: 5,
            variantsCount: 2,
          },
          resultForAssistant: 'ok',
          stage: 'falsification',
          visibility: 'public',
        },
      },
      {
        type: 'user',
        uuid: 'u-tool-r',
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'r-1', content: 'ok' }],
        },
        toolUseResult: {
          data: {
            planStatus: 'ready',
            runnersCount: 2,
            executionResults: [{ status: 'success' }],
            gates: { stageDecision: 'DEFINITIVE_PASS' },
            criticalVerdicts: { overall: 'FAIL' },
          },
          evidence: {
            status: 'ready',
            stageDecision: 'DEFINITIVE_PASS',
            criticalOverall: 'FAIL',
          },
          resultForAssistant: 'ok',
          stage: 'experiment_runners',
          visibility: 'public',
        },
      },
      mkAssistant(),
    ] as any[]

    const gate = __queryTestOnly.buildHypothesisEvidenceGateInstruction(messages)
    expect(typeof gate).toBe('string')
    expect(gate).toContain('FAIL was detected in at least one critical')
    expect(gate).toContain('Do not finalize')
  })

  test('uses latest experiment runners snapshot and does not keep stale critical fail', () => {
    const messages = [
      mkUserPrompt('probemos esta hipotesis de control no conmutativo'),
      {
        type: 'user',
        uuid: 'u-tool-f',
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'f-1', content: 'ok' }],
        },
        toolUseResult: {
          data: {
            planStatus: 'ready',
            testsCount: 5,
            variantsCount: 2,
          },
          resultForAssistant: 'ok',
          stage: 'falsification',
          visibility: 'public',
        },
      },
      {
        type: 'user',
        uuid: 'u-tool-r-old',
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'r-old', content: 'old fail' }],
        },
        toolUseResult: {
          data: {
            planStatus: 'ready',
            runnersCount: 2,
            executionResults: [{ status: 'success' }],
            gates: { stageDecision: 'DEFINITIVE_FAIL' },
            criticalVerdicts: { overall: 'FAIL' },
          },
          evidence: {
            status: 'ready',
            stageDecision: 'DEFINITIVE_FAIL',
            criticalOverall: 'FAIL',
          },
          resultForAssistant: 'old fail',
          stage: 'experiment_runners',
          visibility: 'public',
        },
      },
      {
        type: 'user',
        uuid: 'u-tool-r-new',
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'r-new', content: 'new needs field' }],
        },
        toolUseResult: {
          data: {
            planStatus: 'ready',
            runnersCount: 2,
            executionResults: [{ status: 'success' }],
            gates: {
              stageDecision: 'NEEDS_FIELD',
              evidenceSufficiency: {
                datasetUsed: true,
                hasRealDataset: false,
                nRows: 64,
                loboFolds: 4,
              },
            },
            criticalVerdicts: { overall: 'INCONCLUSIVE' },
          },
          evidence: {
            status: 'ready',
            stageDecision: 'NEEDS_FIELD',
            hasRealDataset: false,
            criticalOverall: 'INCONCLUSIVE',
          },
          resultForAssistant: 'new needs field',
          stage: 'experiment_runners',
          visibility: 'public',
        },
      },
      mkAssistant(),
    ] as any[]

    const gate = __queryTestOnly.buildHypothesisEvidenceGateInstruction(messages)
    const hardBlock =
      __queryTestOnly.buildHypothesisEvidenceGateHardBlockMessage(messages)

    expect(typeof gate).toBe('string')
    expect(gate).toContain('AskUserQuestion')
    expect(gate).not.toContain('FAIL was detected in at least one critical')
    expect(typeof hardBlock).toBe('string')
    expect(hardBlock).toContain('AskUserQuestion')
  })

  test('does not block non-hypothesis turns with no pipeline signals', () => {
    const messages = [mkUserPrompt('hola como estas'), mkAssistant()] as any[]
    const gate = __queryTestOnly.buildHypothesisEvidenceGateInstruction(messages)
    expect(gate).toBeNull()
  })

  test('uses textual tool_result fallback when structured toolUseResult is missing', () => {
    const messages = [
      mkUserPrompt('probemos esta hipotesis de control no conmutativo'),
      {
        type: 'user',
        uuid: 'u-text-f',
        message: {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'f-raw',
              content:
                'Resultado de falsificacion (breve)\nEstado plan: ready\nTests: 5\nVariantes: 2',
            },
          ],
        },
      },
      {
        type: 'user',
        uuid: 'u-text-r',
        message: {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'r-raw',
              content:
                'Resultado de runners experimentales (breve)\nGate decision: NEEDS_FIELD\nEvidence sufficiency: FAIL (dataset_used=true, real_dataset=false, n_rows=64, lobo_folds=4).',
            },
          ],
        },
      },
      mkAssistant(),
    ] as any[]

    const gate = __queryTestOnly.buildHypothesisEvidenceGateInstruction(messages)
    const hardBlock =
      __queryTestOnly.buildHypothesisEvidenceGateHardBlockMessage(messages)
    expect(typeof gate).toBe('string')
    expect(gate).toContain('AskUserQuestion')
    expect(typeof hardBlock).toBe('string')
    expect(hardBlock).toContain('I cannot close')
  })
})
