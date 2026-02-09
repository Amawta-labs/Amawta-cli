import { describe, expect, test } from 'bun:test'

import { DEFAULT_GLOBAL_CONFIG } from '../../src/core/config/defaults'
import { migrateGeminiLegacyContextLength } from '../../src/core/config/migrations'

describe('config migrations', () => {
  test('upgrades legacy 128k context for gemini profiles when model supports larger window', () => {
    const config = {
      ...DEFAULT_GLOBAL_CONFIG,
      modelProfiles: [
        {
          name: 'Gemini Legacy',
          provider: 'gemini',
          modelName: 'gemini-3-flash-preview',
          apiKey: 'test-key',
          maxTokens: 65536,
          contextLength: 128000,
          isActive: true,
          createdAt: Date.now(),
        },
      ],
    }

    const migrated = migrateGeminiLegacyContextLength(config)
    expect(migrated.modelProfiles?.[0]?.contextLength).toBe(1048576)
  })

  test('does not override non-legacy custom context length', () => {
    const config = {
      ...DEFAULT_GLOBAL_CONFIG,
      modelProfiles: [
        {
          name: 'Gemini Custom',
          provider: 'gemini',
          modelName: 'gemini-3-flash-preview',
          apiKey: 'test-key',
          maxTokens: 65536,
          contextLength: 64000,
          isActive: true,
          createdAt: Date.now(),
        },
      ],
    }

    const migrated = migrateGeminiLegacyContextLength(config)
    expect(migrated.modelProfiles?.[0]?.contextLength).toBe(64000)
  })

  test('does not change non-gemini providers', () => {
    const config = {
      ...DEFAULT_GLOBAL_CONFIG,
      modelProfiles: [
        {
          name: 'OpenAI Profile',
          provider: 'openai',
          modelName: 'gpt-4.1',
          apiKey: 'test-key',
          maxTokens: 8192,
          contextLength: 128000,
          isActive: true,
          createdAt: Date.now(),
        },
      ],
    }

    const migrated = migrateGeminiLegacyContextLength(config)
    expect(migrated.modelProfiles?.[0]?.contextLength).toBe(128000)
  })
})

