import { describe, expect, test, beforeAll, afterAll } from 'bun:test'
import { ModelManager } from '@utils/model'
import type { ModelProfile } from '@utils/config'

function makeProfile(
  profile: Partial<ModelProfile> & {
    name: string
    modelName: string
    contextLength: number
    createdAt: number
  },
): ModelProfile {
  return {
    name: profile.name,
    provider: profile.provider ?? 'openai',
    modelName: profile.modelName,
    baseURL: profile.baseURL,
    apiKey: profile.apiKey ?? '',
    maxTokens: profile.maxTokens ?? 1024,
    contextLength: profile.contextLength,
    reasoningEffort: profile.reasoningEffort,
    isActive: profile.isActive ?? true,
    createdAt: profile.createdAt,
    lastUsed: profile.lastUsed,
    isGPT5: profile.isGPT5,
    validationStatus: profile.validationStatus,
    lastValidation: profile.lastValidation,
  }
}

describe('ModelManager model switching', () => {
  const originalNodeEnv = process.env.NODE_ENV

  beforeAll(() => {
    process.env.NODE_ENV = 'test'
  })

  afterAll(() => {
    if (originalNodeEnv === undefined) {
      delete process.env.NODE_ENV
      return
    }
    process.env.NODE_ENV = originalNodeEnv
  })

  test('switchToNextModel updates main pointer and affects resolution', () => {
    const modelA = makeProfile({
      name: 'Model A',
      modelName: 'model-a',
      contextLength: 128_000,
      createdAt: 1,
    })
    const modelB = makeProfile({
      name: 'Model B',
      modelName: 'model-b',
      contextLength: 64_000,
      createdAt: 2,
    })

    const config: any = {
      modelProfiles: [modelA, modelB],
      modelPointers: {
        main: modelA.modelName,
        task: modelA.modelName,
        compact: modelA.modelName,
        quick: modelA.modelName,
      },
      defaultModelName: modelA.modelName,
    }

    const manager = new ModelManager(config)
    const result = manager.switchToNextModel(1000)

    expect(result.success).toBe(true)
    expect(config.modelPointers.main).toBe(modelB.modelName)
    expect(manager.resolveModelWithInfo('main').profile?.modelName).toBe(
      modelB.modelName,
    )
  })

  test('switchToNextModel skips incompatible models when possible', () => {
    const modelA = makeProfile({
      name: 'Model A',
      modelName: 'model-a',
      contextLength: 128_000,
      createdAt: 1,
    })
    const modelB = makeProfile({
      name: 'Model B Small',
      modelName: 'model-b-small',
      contextLength: 32_000,
      createdAt: 2,
    })
    const modelC = makeProfile({
      name: 'Model C',
      modelName: 'model-c',
      contextLength: 256_000,
      createdAt: 3,
    })

    const config: any = {
      modelProfiles: [modelA, modelB, modelC],
      modelPointers: {
        main: modelA.modelName,
        task: modelA.modelName,
        compact: modelA.modelName,
        quick: modelA.modelName,
      },
      defaultModelName: modelA.modelName,
    }

    const manager = new ModelManager(config)
    const result = manager.switchToNextModel(60_000)

    expect(result.success).toBe(true)
    expect(config.modelPointers.main).toBe(modelC.modelName)
    expect(result.message).toContain('skipped 1 incompatible')
  })

  test('switchToNextModel blocks when no alternative model can fit context', () => {
    const modelA = makeProfile({
      name: 'Model A',
      modelName: 'model-a',
      contextLength: 128_000,
      createdAt: 1,
    })
    const modelB = makeProfile({
      name: 'Model B Small',
      modelName: 'model-b-small',
      contextLength: 32_000,
      createdAt: 2,
    })

    const config: any = {
      modelProfiles: [modelA, modelB],
      modelPointers: {
        main: modelA.modelName,
        task: modelA.modelName,
        compact: modelA.modelName,
        quick: modelA.modelName,
      },
      defaultModelName: modelA.modelName,
    }

    const manager = new ModelManager(config)
    const result = manager.switchToNextModel(60_000)

    expect(result.success).toBe(false)
    expect(result.blocked).toBe(true)
    expect(config.modelPointers.main).toBe(modelA.modelName)
    expect(result.message).toContain('Keeping')
  })

  test('resolves Gemini aliases against canonical configured model names', () => {
    const geminiProfile = makeProfile({
      name: 'Gemini Main',
      provider: 'gemini',
      modelName: 'gemini-3-pro-preview',
      contextLength: 1_048_576,
      createdAt: 1,
    })

    const config: any = {
      modelProfiles: [geminiProfile],
      modelPointers: {
        main: geminiProfile.modelName,
        task: geminiProfile.modelName,
        compact: geminiProfile.modelName,
        quick: geminiProfile.modelName,
      },
      defaultModelName: geminiProfile.modelName,
    }

    const manager = new ModelManager(config)
    const resolved = manager.resolveModelWithInfo('gemini-3-pro')

    expect(resolved.success).toBe(true)
    expect(resolved.profile?.modelName).toBe('gemini-3-pro-preview')
  })

  test('resolves provider-qualified Gemini aliases', () => {
    const geminiProfile = makeProfile({
      name: 'Gemini Main',
      provider: 'gemini',
      modelName: 'gemini-3-flash-preview',
      contextLength: 1_048_576,
      createdAt: 1,
    })

    const config: any = {
      modelProfiles: [geminiProfile],
      modelPointers: {
        main: geminiProfile.modelName,
        task: geminiProfile.modelName,
        compact: geminiProfile.modelName,
        quick: geminiProfile.modelName,
      },
      defaultModelName: geminiProfile.modelName,
    }

    const manager = new ModelManager(config)
    const resolved = manager.resolveModelWithInfo('gemini:gemini-3-flash')

    expect(resolved.success).toBe(true)
    expect(resolved.profile?.modelName).toBe('gemini-3-flash-preview')
  })
})
