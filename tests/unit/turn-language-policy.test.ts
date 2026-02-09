import { describe, expect, test } from 'bun:test'
import { __queryTestOnly } from '@query'

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

describe('turn language policy', () => {
  test('detects english hypothesis prompt', () => {
    const lang = __queryTestOnly.detectPreferredTurnResponseLanguage(
      'In Palmer Penguins, controlling for species and sex, greater flipper_length_mm implies greater body_mass_g.',
    )
    expect(lang).toBe('en')
  })

  test('detects spanish hypothesis prompt', () => {
    const lang = __queryTestOnly.detectPreferredTurnResponseLanguage(
      'En Palmer Penguins, controlando por especie y sexo, mayor flipper_length_mm implica mayor body_mass_g.',
    )
    expect(lang).toBe('es')
  })

  test('builds english turn-local language policy prompt', () => {
    const prompt = __queryTestOnly.buildTurnLanguageSystemPrompt([
      mkUserPrompt(
        'Let’s test this hypothesis: under a convex functional with explicit costs...',
      ),
    ] as any[])
    expect(prompt).toContain('respond in English for this turn')
  })
})

