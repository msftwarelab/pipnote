import { invoke } from '@tauri-apps/api/core'
import type { GenerationRequestOptions, LocalAIModel, LocalAIModelCapability, LocalAISettings } from '../localAiTypes'

function isTauriRuntime(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
}

interface LocalAiModelResponse {
  name: string
  size?: number | null
  modified_at?: string | null
  capability: string
  capabilities: string[]
}

function mapCapability(capability: string): LocalAIModelCapability {
  if (capability === 'text' || capability === 'embedding' || capability === 'both') return capability
  return 'unknown'
}

function inferCapabilityFromName(modelName: string): { capability: LocalAIModelCapability; capabilities: string[] } {
  const lower = modelName.toLowerCase()
  const looksEmbedding = /(embed|embedding|bge|e5-|e5:|nomic-embed|mxbai|arctic-embed)/.test(lower)
  const looksText = /(gpt|llama|qwen|mistral|phi|gemma|deepseek|mixtral|command-r|chat)/.test(lower)
  if (looksEmbedding && looksText) return { capability: 'both', capabilities: ['completion', 'embedding'] }
  if (looksEmbedding) return { capability: 'embedding', capabilities: ['embedding'] }
  if (looksText) return { capability: 'text', capabilities: ['completion'] }
  return { capability: 'unknown', capabilities: [] }
}

function classifyCapability(
  modelName: string,
  modelShowData: { capabilities?: unknown; details?: unknown; template?: unknown } | null,
): { capability: LocalAIModelCapability; capabilities: string[] } {
  const heuristic = inferCapabilityFromName(modelName)
  if (!modelShowData) return heuristic

  const rawCaps = Array.isArray(modelShowData.capabilities)
    ? modelShowData.capabilities
        .map((value) => (typeof value === 'string' ? value.toLowerCase() : ''))
        .filter((value) => value.length > 0)
    : []

  const hasEmbedding = rawCaps.some((cap) => cap.includes('embed'))
  const hasText = rawCaps.some((cap) => cap.includes('completion') || cap.includes('chat') || cap.includes('generate'))

  if (hasEmbedding && hasText) return { capability: 'both', capabilities: rawCaps }
  if (hasEmbedding) return { capability: 'embedding', capabilities: rawCaps }
  if (hasText) return { capability: 'text', capabilities: rawCaps }

  if (typeof modelShowData.template === 'string' && modelShowData.template.trim().length > 0) {
    return { capability: 'text', capabilities: ['completion'] }
  }

  if (modelShowData.details && JSON.stringify(modelShowData.details).toLowerCase().includes('embed')) {
    return { capability: 'embedding', capabilities: ['embedding'] }
  }

  return heuristic
}

async function fetchModelShowData(
  settings: LocalAISettings,
  modelName: string,
): Promise<{ capabilities?: unknown; details?: unknown; template?: unknown } | null> {
  try {
    const response = await fetch(`${settings.baseUrl}/api/show`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ model: modelName }),
      signal: AbortSignal.timeout(6000),
    })
    if (!response.ok) return null
    return (await response.json()) as { capabilities?: unknown; details?: unknown; template?: unknown }
  } catch {
    return null
  }
}

export async function listOllamaModels(settings: LocalAISettings): Promise<LocalAIModel[]> {
  try {
    const models = await invoke<LocalAiModelResponse[]>('local_ai_list_models', {
      provider: 'ollama',
      baseUrl: settings.baseUrl,
    })
    return models
      .map((model) => ({
        name: model.name,
        size: model.size ?? undefined,
        modifiedAt: model.modified_at ?? undefined,
        capability: mapCapability(model.capability),
        capabilities: Array.isArray(model.capabilities) ? model.capabilities : [],
      }))
      .sort((a, b) => a.name.localeCompare(b.name))
  } catch (error) {
    console.error('Ollama model listing via Tauri failed:', error)
    if (isTauriRuntime()) throw error
  }

  const response = await fetch(`${settings.baseUrl}/api/tags`, {
    method: 'GET',
    headers: {
      'Content-Type': 'application/json',
    },
    signal: AbortSignal.timeout(7000),
  })

  if (!response.ok) {
    throw new Error(`Ollama responded with HTTP ${response.status} at ${settings.baseUrl}.`)
  }

  const data = (await response.json()) as {
    models?: Array<{ name?: string; model?: string; size?: number; modified_at?: string }>
  }
  const baseModels = (Array.isArray(data.models) ? data.models : [])
    .map((model) => ({
      name: (model.name || model.model || '').trim(),
      size: typeof model.size === 'number' ? model.size : undefined,
      modifiedAt: typeof model.modified_at === 'string' ? model.modified_at : undefined,
    }))
    .filter((model) => model.name.length > 0)

  const models = await Promise.all(
    baseModels.map(async (model) => {
      const showData = await fetchModelShowData(settings, model.name)
      const capability = classifyCapability(model.name, showData)
      return {
        ...model,
        capability: capability.capability,
        capabilities: capability.capabilities,
      } satisfies LocalAIModel
    }),
  )

  models.sort((a, b) => a.name.localeCompare(b.name))
  return models
}

export async function generateOllamaText(settings: LocalAISettings, options: GenerationRequestOptions): Promise<string> {
  try {
    const payload: Record<string, unknown> = {
      provider: 'ollama',
      baseUrl: settings.baseUrl,
      model: settings.textModel,
      prompt: options.prompt,
      jsonPreferred: options.jsonPreferred ?? false,
      temperature: options.temperature ?? 0.3,
      numPredict: options.numPredict ?? 300,
      timeoutMs: options.timeoutMs ?? 30000,
    }
    if (typeof options.topP === 'number') {
      payload.topP = options.topP
    }
    if (typeof options.repeatPenalty === 'number') {
      payload.repeatPenalty = options.repeatPenalty
    }
    const response = await invoke<{ text: string }>('local_ai_generate_text', payload)
    return response.text?.trim() || ''
  } catch (error) {
    console.error('Ollama text generation via Tauri failed:', error)
    if (isTauriRuntime()) throw error
  }

  const response = await fetch(`${settings.baseUrl}/api/generate`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: settings.textModel,
      prompt: options.prompt,
      stream: false,
      ...(options.jsonPreferred ? { format: 'json' } : {}),
      options: {
        temperature: options.temperature ?? 0.3,
        num_predict: options.numPredict ?? 300,
        ...(typeof options.topP === 'number' ? { top_p: options.topP } : {}),
        ...(typeof options.repeatPenalty === 'number' ? { repeat_penalty: options.repeatPenalty } : {}),
      },
    }),
    signal: AbortSignal.timeout(options.timeoutMs ?? 30000),
  })

  if (!response.ok) {
    throw new Error(`Ollama API error: ${response.status}`)
  }

  const data = (await response.json()) as { response?: string }
  return data.response?.trim() || ''
}

export async function generateOllamaEmbedding(settings: LocalAISettings, content: string): Promise<number[]> {
  try {
    const response = await invoke<{ embedding: number[] }>('local_ai_generate_embedding', {
      provider: 'ollama',
      baseUrl: settings.baseUrl,
      model: settings.embeddingModel,
      input: content,
      timeoutMs: 30000,
    })
    return Array.isArray(response.embedding) ? response.embedding : []
  } catch (error) {
    console.error('Ollama embedding generation via Tauri failed:', error)
    if (isTauriRuntime()) throw error
  }

  const response = await fetch(`${settings.baseUrl}/api/embeddings`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: settings.embeddingModel,
      prompt: content,
    }),
    signal: AbortSignal.timeout(30000),
  })

  if (!response.ok) {
    throw new Error(`Ollama API error: ${response.status}`)
  }

  const data = await response.json()
  return Array.isArray(data.embedding) ? data.embedding : []
}
