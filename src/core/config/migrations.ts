import models from '@constants/models'

import type { GlobalConfig, ModelPointers, ModelProfile } from './schema'

export function migrateModelProfilesRemoveId(config: GlobalConfig): GlobalConfig {
  if (!config.modelProfiles) return config

  const idToModelNameMap = new Map<string, string>()
  const migratedProfiles = config.modelProfiles.map(profile => {
    if ((profile as any).id && profile.modelName) {
      idToModelNameMap.set((profile as any).id, profile.modelName)
    }

    const { id, ...profileWithoutId } = profile as any
    return profileWithoutId as ModelProfile
  })

  const migratedPointers: ModelPointers = {
    main: '',
    task: '',
    compact: '',
    quick: '',
  }

  const rawPointers = config.modelPointers as
    | Record<string, unknown>
    | undefined
  const rawMain = typeof rawPointers?.main === 'string' ? rawPointers.main : ''
  const rawTask = typeof rawPointers?.task === 'string' ? rawPointers.task : ''
  const rawQuick =
    typeof rawPointers?.quick === 'string' ? rawPointers.quick : ''
  const rawCompact =
    typeof rawPointers?.compact === 'string'
      ? rawPointers.compact
      : typeof rawPointers?.reasoning === 'string'
        ? rawPointers.reasoning
        : ''

  if (rawMain) migratedPointers.main = idToModelNameMap.get(rawMain) || rawMain
  if (rawTask) migratedPointers.task = idToModelNameMap.get(rawTask) || rawTask
  if (rawCompact)
    migratedPointers.compact = idToModelNameMap.get(rawCompact) || rawCompact
  if (rawQuick)
    migratedPointers.quick = idToModelNameMap.get(rawQuick) || rawQuick

  let defaultModelName: string | undefined
  if ((config as any).defaultModelId) {
    defaultModelName =
      idToModelNameMap.get((config as any).defaultModelId) ||
      (config as any).defaultModelId
  } else if ((config as any).defaultModelName) {
    defaultModelName = (config as any).defaultModelName
  }

  const migratedConfig = { ...config }
  delete (migratedConfig as any).defaultModelId
  delete (migratedConfig as any).currentSelectedModelId
  delete (migratedConfig as any).mainAgentModelId
  delete (migratedConfig as any).taskToolModelId

  return {
    ...migratedConfig,
    modelProfiles: migratedProfiles,
    modelPointers: migratedPointers,
    defaultModelName,
  }
}

function getKnownModelContextLength(
  provider: string | undefined,
  modelName: string | undefined,
): number | undefined {
  if (!provider || !modelName) return undefined
  const providerModels = (models as Record<string, any[]>)[provider]
  if (!Array.isArray(providerModels)) return undefined
  const matched = providerModels.find(m => m?.model === modelName)
  const maxInput = matched?.max_input_tokens
  return typeof maxInput === 'number' && Number.isFinite(maxInput) && maxInput > 0
    ? maxInput
    : undefined
}

export function migrateGeminiLegacyContextLength(
  config: GlobalConfig,
): GlobalConfig {
  if (!Array.isArray(config.modelProfiles) || config.modelProfiles.length === 0) {
    return config
  }

  let changed = false
  const migratedProfiles = config.modelProfiles.map(profile => {
    const provider = profile.provider
    if (provider !== 'gemini' && provider !== 'adk') {
      return profile
    }

    const knownContextLength = getKnownModelContextLength(
      provider,
      profile.modelName,
    )
    if (!knownContextLength || knownContextLength <= 128_000) {
      return profile
    }

    if (profile.contextLength !== 128_000) {
      return profile
    }

    changed = true
    return {
      ...profile,
      contextLength: knownContextLength,
    }
  })

  if (!changed) return config
  return {
    ...config,
    modelProfiles: migratedProfiles,
  }
}
