const DEFAULT_OLLAMA_BASE_URL = 'http://localhost:11434'
const DEFAULT_LM_STUDIO_BASE_URL = 'http://127.0.0.1:1234'
const DEFAULT_TEXT_MODEL = 'qwen2.5:3b-instruct'
const DEFAULT_EMBEDDING_MODEL = 'nomic-embed-text'
const LOCAL_AI_SETTINGS_KEY = 'vn_ollama_settings'

export type LocalAIProvider = 'ollama' | 'lmstudio'

export interface LocalAISettings {
  provider: LocalAIProvider
  baseUrl: string
  textModel: string
  embeddingModel: string
}

export type LocalAIModelCapability = 'text' | 'embedding' | 'both' | 'unknown'

export interface LocalAIModel {
  name: string
  size?: number
  modifiedAt?: string
  capability: LocalAIModelCapability
  capabilities: string[]
}

export interface LocalAIModelSelectionStatus {
  availableModels: string[]
  textModelAvailable: boolean
  embeddingModelAvailable: boolean
  textModelCapabilityValid: boolean
  embeddingModelCapabilityValid: boolean
  missing: string[]
  incompatible: string[]
}

export interface GenerationRequestOptions {
  prompt: string
  jsonPreferred?: boolean
  temperature?: number
  numPredict?: number
  topP?: number
  repeatPenalty?: number
  timeoutMs?: number
}

export function normalizeBaseUrl(url: string): string {
  return url.trim().replace(/\/+$/, '')
}

export function getBaseUrlCandidates(provider: LocalAIProvider, baseUrl: string): string[] {
  const normalized = normalizeBaseUrl(baseUrl)
  if (provider !== 'lmstudio') {
    return [normalized]
  }

  const candidates = new Set<string>([normalized])

  try {
    const parsed = new URL(normalized)
    if (parsed.hostname === 'localhost') {
      parsed.hostname = '127.0.0.1'
      candidates.add(normalizeBaseUrl(parsed.toString()))
    } else if (parsed.hostname === '127.0.0.1') {
      parsed.hostname = 'localhost'
      candidates.add(normalizeBaseUrl(parsed.toString()))
    }
  } catch {
    // Keep the original value if URL parsing fails.
  }

  return Array.from(candidates)
}

function normalizeModelId(model: string): string {
  return model.trim().toLowerCase().replace(/@sha256:[a-f0-9]+$/i, '')
}

export function modelSatisfies(requestedModel: string, availableModel: string): boolean {
  const requested = normalizeModelId(requestedModel)
  const available = normalizeModelId(availableModel)
  if (!requested || !available) return false
  if (requested === available) return true

  if (!requested.includes(':')) {
    return available === requested || available.startsWith(`${requested}:`)
  }

  return available.startsWith(`${requested}:`)
}

export function modelSupportsCapability(capability: LocalAIModelCapability, required: 'text' | 'embedding'): boolean {
  if (capability === 'both') return true
  if (capability === required) return true
  return capability === 'unknown'
}

export function providerLabel(provider: LocalAIProvider): string {
  return provider === 'lmstudio' ? 'LM Studio' : 'Ollama'
}

export function getDefaultLocalAISettings(provider: LocalAIProvider = 'ollama'): LocalAISettings {
  return {
    provider,
    baseUrl: provider === 'lmstudio' ? DEFAULT_LM_STUDIO_BASE_URL : DEFAULT_OLLAMA_BASE_URL,
    textModel: DEFAULT_TEXT_MODEL,
    embeddingModel: DEFAULT_EMBEDDING_MODEL,
  }
}

export function getLocalAISettings(): LocalAISettings {
  const baseDefaults = getDefaultLocalAISettings()
  try {
    const raw = localStorage.getItem(LOCAL_AI_SETTINGS_KEY)
    if (!raw) return baseDefaults

    const parsed = JSON.parse(raw) as Partial<LocalAISettings>
    const provider: LocalAIProvider = parsed.provider === 'lmstudio' ? 'lmstudio' : 'ollama'
    const defaults = getDefaultLocalAISettings(provider)
    return {
      provider,
      baseUrl: normalizeBaseUrl(parsed.baseUrl || defaults.baseUrl),
      textModel: (parsed.textModel || defaults.textModel).trim(),
      embeddingModel: (parsed.embeddingModel || defaults.embeddingModel).trim(),
    }
  } catch (error) {
    console.warn('Failed to parse local AI settings, falling back to defaults:', error)
    return baseDefaults
  }
}

export function saveLocalAISettings(settings: LocalAISettings): void {
  localStorage.setItem(LOCAL_AI_SETTINGS_KEY, JSON.stringify(settings))
}
