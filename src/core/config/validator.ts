import type { ModelPointerType, ModelProfile, ProviderType } from './schema'
import { debug as debugLogger } from '@utils/log/debugLogger'
import { getGlobalConfig, saveGlobalConfig } from './loader'
import {
  isGoogleModelProvider,
  normalizeGeminiModelName,
} from '@utils/model/geminiAliases'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const DEFAULT_GEMINI_CONTEXT_LENGTH = 1048576
const DEFAULT_GEMINI_MAX_TOKENS = 8192
const DEFAULT_GEMINI_MODELS: ReadonlyArray<{
  name: string
  modelName: string
}> = [
  { name: 'Gemini 3 Flash', modelName: 'gemini-3-flash-preview' },
  { name: 'Gemini 3 Pro', modelName: 'gemini-3-pro-preview' },
]

function sanitizeCandidateApiKey(value: string | undefined): string {
  const cleaned = String(value || '').trim()
  if (!cleaned) return ''
  const lower = cleaned.toLowerCase()
  if (
    lower === 'your_api_key_here' ||
    lower.includes('replace_me') ||
    lower.includes('changeme')
  ) {
    return ''
  }
  return cleaned
}

function resolveBundledDemoApiKey(): string {
  const candidates: string[] = []
  const addCandidatesForDir = (baseDir: string) => {
    candidates.push(join(baseDir, '.amawta-demo-key'))
    candidates.push(join(baseDir, '.amawta', 'demo-key.txt'))
  }

  const fromEnvPath = sanitizeCandidateApiKey(process.env.AMAWTA_DEMO_KEY_FILE)
  if (fromEnvPath) candidates.push(fromEnvPath)

  try {
    let runtimeDir = dirname(fileURLToPath(import.meta.url))
    for (let i = 0; i < 6; i++) {
      addCandidatesForDir(runtimeDir)
      const parent = dirname(runtimeDir)
      if (parent === runtimeDir) break
      runtimeDir = parent
    }
  } catch {
    // Ignore import.meta URL resolution errors.
  }

  const cliEntry = process.argv[1]
  if (cliEntry) {
    const cliDir = dirname(cliEntry)
    addCandidatesForDir(cliDir)

    const parentDir = dirname(cliDir)
    addCandidatesForDir(parentDir)
  }

  addCandidatesForDir(process.cwd())

  for (const filePath of candidates) {
    try {
      if (!existsSync(filePath)) continue
      const content = readFileSync(filePath, 'utf8')
      const key = sanitizeCandidateApiKey(content)
      if (key) return key
    } catch {
      // Ignore unreadable candidates and continue.
    }
  }

  return ''
}

function resolveConfigGeminiApiKey(): string {
  return sanitizeCandidateApiKey(
    process.env.AMAWTA_DEFAULT_GEMINI_API_KEY ||
      process.env.GOOGLE_GENAI_API_KEY ||
      process.env.GEMINI_API_KEY ||
      process.env.GOOGLE_API_KEY ||
      process.env.ADK_API_KEY ||
      resolveBundledDemoApiKey(),
  )
}

function isValidActivePointerTarget(
  pointerValue: string | undefined,
  profiles: ModelProfile[],
): boolean {
  if (!pointerValue) return false
  return profiles.some(
    profile =>
      profile.isActive &&
      (profile.modelName === pointerValue || profile.name === pointerValue),
  )
}

export function ensureDefaultGeminiProfiles(): {
  changed: boolean
  created: number
  reactivated: number
  pointersUpdated: boolean
} {
  const config = getGlobalConfig()
  const profiles = [...(config.modelProfiles || [])]
  const apiKey = resolveConfigGeminiApiKey()
  const now = Date.now()

  if (apiKey) {
    if (!process.env.GEMINI_API_KEY) {
      process.env.GEMINI_API_KEY = apiKey
    }
    if (!process.env.GOOGLE_GENAI_API_KEY) {
      process.env.GOOGLE_GENAI_API_KEY = apiKey
    }
  }

  let changed = false
  let created = 0
  let reactivated = 0

  const ensureDefaultModel = (spec: { name: string; modelName: string }) => {
    const targetName = normalizeGeminiModelName(spec.modelName)
    const existingIndex = profiles.findIndex(
      profile =>
        isGoogleModelProvider(profile.provider) &&
        normalizeGeminiModelName(profile.modelName) === targetName,
    )

    if (existingIndex >= 0) {
      const existing = profiles[existingIndex]
      if (!existing.isActive) {
        profiles[existingIndex] = { ...existing, isActive: true }
        changed = true
        reactivated += 1
      }
      if (!profiles[existingIndex].apiKey && apiKey) {
        profiles[existingIndex] = { ...profiles[existingIndex], apiKey }
        changed = true
      }
      return profiles[existingIndex].modelName
    }

    let uniqueName = spec.name
    let suffix = 2
    while (profiles.some(profile => profile.name === uniqueName)) {
      uniqueName = `${spec.name} #${suffix}`
      suffix += 1
    }

    profiles.push({
      name: uniqueName,
      provider: 'gemini',
      modelName: targetName,
      baseURL: '',
      apiKey,
      maxTokens: DEFAULT_GEMINI_MAX_TOKENS,
      contextLength: DEFAULT_GEMINI_CONTEXT_LENGTH,
      isActive: true,
      createdAt: now + created,
    })
    changed = true
    created += 1
    return targetName
  }

  const flashModelName = ensureDefaultModel(DEFAULT_GEMINI_MODELS[0])
  const proModelName = ensureDefaultModel(DEFAULT_GEMINI_MODELS[1])

  const nextPointers = {
    main: config.modelPointers?.main || '',
    task: config.modelPointers?.task || '',
    compact: config.modelPointers?.compact || '',
    quick: config.modelPointers?.quick || '',
  }

  let pointersUpdated = false
  if (!isValidActivePointerTarget(nextPointers.main, profiles)) {
    nextPointers.main = flashModelName
    pointersUpdated = true
  }
  if (!isValidActivePointerTarget(nextPointers.task, profiles)) {
    nextPointers.task = proModelName
    pointersUpdated = true
  }
  if (!isValidActivePointerTarget(nextPointers.compact, profiles)) {
    nextPointers.compact = flashModelName
    pointersUpdated = true
  }
  if (!isValidActivePointerTarget(nextPointers.quick, profiles)) {
    nextPointers.quick = flashModelName
    pointersUpdated = true
  }

  const hasValidDefaultModelName =
    !!config.defaultModelName &&
    profiles.some(
      profile =>
        profile.isActive &&
        (profile.modelName === config.defaultModelName ||
          profile.name === config.defaultModelName),
    )
  const nextDefaultModelName = hasValidDefaultModelName
    ? config.defaultModelName
    : nextPointers.main
  const defaultModelUpdated = nextDefaultModelName !== config.defaultModelName

  if (pointersUpdated) {
    changed = true
  }
  if (defaultModelUpdated) {
    changed = true
  }

  if (!changed) {
    return { changed: false, created: 0, reactivated: 0, pointersUpdated: false }
  }

  saveGlobalConfig({
    ...config,
    modelProfiles: profiles,
    modelPointers: nextPointers,
    defaultModelName: nextDefaultModelName,
  })

  debugLogger.info('DEFAULT_GEMINI_PROFILES_ENSURED', {
    created,
    reactivated,
    pointersUpdated,
    main: nextPointers.main,
    task: nextPointers.task,
    compact: nextPointers.compact,
    quick: nextPointers.quick,
  })

  return { changed: true, created, reactivated, pointersUpdated }
}

export function setAllPointersToModel(modelName: string): void {
  const config = getGlobalConfig()
  const updatedConfig = {
    ...config,
    modelPointers: {
      main: modelName,
      task: modelName,
      compact: modelName,
      quick: modelName,
    },
    defaultModelName: modelName,
  }
  saveGlobalConfig(updatedConfig)
}

export function setModelPointer(
  pointer: ModelPointerType,
  modelName: string,
): void {
  const config = getGlobalConfig()
  const updatedConfig = {
    ...config,
    modelPointers: {
      ...config.modelPointers,
      [pointer]: modelName,
    },
  }
  saveGlobalConfig(updatedConfig)

  import('../../utils/model').then(({ reloadModelManager }) => {
    reloadModelManager()
  })
}

export function isGPT5ModelName(modelName: string): boolean {
  if (!modelName || typeof modelName !== 'string') return false
  const lowerName = modelName.toLowerCase()
  return lowerName.startsWith('gpt-5') || lowerName.includes('gpt-5')
}

export function validateAndRepairGPT5Profile(
  profile: ModelProfile,
): ModelProfile {
  const isGPT5 = isGPT5ModelName(profile.modelName)
  const now = Date.now()

  const repairedProfile: ModelProfile = { ...profile }
  let wasRepaired = false

  if (isGPT5 !== profile.isGPT5) {
    repairedProfile.isGPT5 = isGPT5
    wasRepaired = true
  }

  if (isGPT5) {

    const validReasoningEfforts = ['minimal', 'low', 'medium', 'high']
    if (
      !profile.reasoningEffort ||
      !validReasoningEfforts.includes(profile.reasoningEffort)
    ) {
      repairedProfile.reasoningEffort = 'medium'
      wasRepaired = true
      debugLogger.state('GPT5_CONFIG_AUTO_REPAIR', {
        model: profile.modelName,
        field: 'reasoningEffort',
        value: 'medium',
      })
    }

    if (profile.contextLength < 128000) {
      repairedProfile.contextLength = 128000
      wasRepaired = true
      debugLogger.state('GPT5_CONFIG_AUTO_REPAIR', {
        model: profile.modelName,
        field: 'contextLength',
        value: 128000,
      })
    }

    if (profile.maxTokens < 4000) {
      repairedProfile.maxTokens = 8192
      wasRepaired = true
      debugLogger.state('GPT5_CONFIG_AUTO_REPAIR', {
        model: profile.modelName,
        field: 'maxTokens',
        value: 8192,
      })
    }

    if (
      profile.provider !== 'openai' &&
      profile.provider !== 'custom-openai' &&
      profile.provider !== 'azure'
    ) {
      debugLogger.warn('GPT5_CONFIG_UNEXPECTED_PROVIDER', {
        model: profile.modelName,
        provider: profile.provider,
        expectedProviders: ['openai', 'custom-openai', 'azure'],
      })
    }

    if (profile.modelName.includes('gpt-5') && !profile.baseURL) {
      repairedProfile.baseURL = 'https://api.openai.com/v1'
      wasRepaired = true
      debugLogger.state('GPT5_CONFIG_AUTO_REPAIR', {
        model: profile.modelName,
        field: 'baseURL',
        value: 'https://api.openai.com/v1',
      })
    }
  }

  repairedProfile.validationStatus = wasRepaired ? 'auto_repaired' : 'valid'
  repairedProfile.lastValidation = now

  if (wasRepaired) {
    debugLogger.info('GPT5_CONFIG_AUTO_REPAIRED', { model: profile.modelName })
  }

  return repairedProfile
}

export function validateAndRepairAllGPT5Profiles(): {
  repaired: number
  total: number
} {
  const config = getGlobalConfig()
  if (!config.modelProfiles) {
    return { repaired: 0, total: 0 }
  }

  let repairCount = 0
  const repairedProfiles = config.modelProfiles.map(profile => {
    const repairedProfile = validateAndRepairGPT5Profile(profile)
    if (repairedProfile.validationStatus === 'auto_repaired') {
      repairCount++
    }
    return repairedProfile
  })

  if (repairCount > 0) {
    const updatedConfig = {
      ...config,
      modelProfiles: repairedProfiles,
    }
    saveGlobalConfig(updatedConfig)
    debugLogger.info('GPT5_CONFIG_AUTO_REPAIR_SUMMARY', {
      repaired: repairCount,
      total: config.modelProfiles.length,
    })
  }

  return { repaired: repairCount, total: config.modelProfiles.length }
}

export function getGPT5ConfigRecommendations(
  modelName: string,
): Partial<ModelProfile> {
  if (!isGPT5ModelName(modelName)) {
    return {}
  }

  const recommendations: Partial<ModelProfile> = {
    contextLength: 128000,
    maxTokens: 8192,
    reasoningEffort: 'medium',
    isGPT5: true,
  }

  if (modelName.includes('gpt-5-mini')) {
    recommendations.maxTokens = 4096
    recommendations.reasoningEffort = 'low'
  } else if (modelName.includes('gpt-5-nano')) {
    recommendations.maxTokens = 2048
    recommendations.reasoningEffort = 'minimal'
  }

  return recommendations
}

export function createGPT5ModelProfile(
  name: string,
  modelName: string,
  apiKey: string,
  baseURL?: string,
  provider: ProviderType = 'openai',
): ModelProfile {
  const recommendations = getGPT5ConfigRecommendations(modelName)

  const profile: ModelProfile = {
    name,
    provider,
    modelName,
    baseURL: baseURL || 'https://api.openai.com/v1',
    apiKey,
    maxTokens: recommendations.maxTokens || 8192,
    contextLength: recommendations.contextLength || 128000,
    reasoningEffort: recommendations.reasoningEffort || 'medium',
    isActive: true,
    createdAt: Date.now(),
    isGPT5: true,
    validationStatus: 'valid',
    lastValidation: Date.now(),
  }

  return profile
}
