import { describe, expect, test } from 'bun:test'

import {
  createAssistantMessage,
  createProgressMessage,
  reorderMessages,
} from '../../src/utils/messages'

describe('reorderMessages progress persistence', () => {
  test('does not replace persisted progress with transient updates', () => {
    const toolUseId = 'tool-1'

    const toolUseMessage = createAssistantMessage('tool use request')
    ;(toolUseMessage.message.content as any) = [
      {
        type: 'tool_use',
        id: toolUseId,
        name: 'FalsificationPlan',
        input: {},
      },
    ]

    const persistedPlan = createProgressMessage(
      toolUseId,
      new Set([toolUseId]),
      createAssistantMessage('<tool-progress>Plan: ejecutar FalsificationPlan.</tool-progress>'),
      [],
      [],
      { persistHistory: true },
    )

    const transientExecuting = createProgressMessage(
      toolUseId,
      new Set([toolUseId]),
      createAssistantMessage('<tool-progress>Ejecutando...</tool-progress>'),
      [],
      [],
    )

    const normalized = reorderMessages([
      toolUseMessage as any,
      persistedPlan as any,
      transientExecuting as any,
    ])

    const progress = normalized.filter((message: any) => message.type === 'progress')
    expect(progress.length).toBe(2)
    expect(
      (progress[0] as any).content.message.content[0].text.includes('Plan:'),
    ).toBe(true)
    expect(
      (progress[1] as any).content.message.content[0].text.includes('Ejecutando'),
    ).toBe(true)
  })

  test('keeps multiple persisted lifecycle messages in sequence', () => {
    const toolUseId = 'tool-2'

    const toolUseMessage = createAssistantMessage('tool use request')
    ;(toolUseMessage.message.content as any) = [
      {
        type: 'tool_use',
        id: toolUseId,
        name: 'ExperimentRunners',
        input: {},
      },
    ]

    const plan = createProgressMessage(
      toolUseId,
      new Set([toolUseId]),
      createAssistantMessage('<tool-progress>Plan: ejecutar ExperimentRunners.</tool-progress>'),
      [],
      [],
      { persistHistory: true },
    )

    const doing = createProgressMessage(
      toolUseId,
      new Set([toolUseId]),
      createAssistantMessage('<tool-progress>En curso: ejecutando ExperimentRunners.</tool-progress>'),
      [],
      [],
      { persistHistory: true },
    )

    const done = createProgressMessage(
      toolUseId,
      new Set([toolUseId]),
      createAssistantMessage('<tool-progress>Hecho: ExperimentRunners completado. Siguiente: field.</tool-progress>'),
      [],
      [],
      { persistHistory: true },
    )

    const normalized = reorderMessages([
      toolUseMessage as any,
      plan as any,
      doing as any,
      done as any,
    ])

    const progress = normalized.filter((message: any) => message.type === 'progress')
    expect(progress.length).toBe(3)
    expect((progress[0] as any).content.message.content[0].text).toContain('Plan:')
    expect((progress[1] as any).content.message.content[0].text).toContain('En curso:')
    expect((progress[2] as any).content.message.content[0].text).toContain('Hecho:')
  })
})
