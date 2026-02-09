const GEMINI_ALIAS_TO_CANONICAL: Record<string, string> = {
  'gemini-3-pro': 'gemini-3-pro-preview',
  'gemini3-pro': 'gemini-3-pro-preview',
  'gemini-3-pro-preview': 'gemini-3-pro-preview',
  'gemini-3-flash': 'gemini-3-flash-preview',
  'gemini3-flash': 'gemini-3-flash-preview',
  'gemini-3-flash-preview': 'gemini-3-flash-preview',
}

const GEMINI_CANONICAL_TO_DISPLAY: Record<string, string> = {
  'gemini-3-pro-preview': 'gemini-3-pro',
  'gemini-3-flash-preview': 'gemini-3-flash',
}

const GEMINI_CYCLE_TWINS: Record<string, string> = {
  'gemini-3-pro-preview': 'gemini-3-flash-preview',
  'gemini-3-flash-preview': 'gemini-3-pro-preview',
}

function normalizeAliasKey(value: string): string {
  return value.trim().toLowerCase().replace(/[_\s]+/g, '-')
}

export function isGoogleModelProvider(provider: string | undefined): boolean {
  if (!provider) return false
  const normalizedProvider = provider.trim().toLowerCase()
  return normalizedProvider === 'gemini' || normalizedProvider === 'adk'
}

export function normalizeGeminiModelName(modelName: string): string {
  const trimmed = modelName.trim()
  if (!trimmed) return modelName

  const aliasKey = normalizeAliasKey(trimmed)
  return GEMINI_ALIAS_TO_CANONICAL[aliasKey] || trimmed
}

export function toGeminiDisplayModelName(modelName: string): string {
  const canonical = normalizeGeminiModelName(modelName)
  return GEMINI_CANONICAL_TO_DISPLAY[canonical] || modelName
}

export function getGeminiCycleTwinModelName(modelName: string): string | null {
  const canonical = normalizeGeminiModelName(modelName)
  return GEMINI_CYCLE_TWINS[canonical] || null
}
