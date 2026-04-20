import { invoke } from '@tauri-apps/api/core'
import { getBaseUrlCandidates, type GenerationRequestOptions, type LocalAIModel, type LocalAIModelCapability, type LocalAISettings } from '../localAiTypes'

function isTauriRuntime(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
}

async function fetchWithLmStudioFallback(inputPath: string, settings: LocalAISettings, init: RequestInit, timeoutMs: number): Promise<Response> {
  let lastError: unknown = null

  for (const baseUrl of getBaseUrlCandidates('lmstudio', settings.baseUrl)) {
    try {
      return await fetch(`${baseUrl}${inputPath}`, {
        ...init,
        signal: AbortSignal.timeout(timeoutMs),
      })
    } catch (error) {
      lastError = error
    }
  }

  throw lastError instanceof Error ? lastError : new Error('Failed to reach LM Studio')
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

export async function listLmStudioModels(settings: LocalAISettings): Promise<LocalAIModel[]> {
  try {
    const models = await invoke<LocalAiModelResponse[]>('local_ai_list_models', {
      provider: 'lmstudio',
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
    console.error('LM Studio model listing via Tauri failed:', error)
    if (isTauriRuntime()) throw error
  }

  const response = await fetchWithLmStudioFallback('/v1/models', settings, {
    method: 'GET',
    headers: {
      'Content-Type': 'application/json',
    },
  }, 7000)

  if (!response.ok) {
    throw new Error(`LM Studio responded with HTTP ${response.status} at ${settings.baseUrl}.`)
  }

  const data = (await response.json()) as {
    data?: Array<{ id?: string }>
  }

  const models = (Array.isArray(data.data) ? data.data : [])
    .map((item) => (item.id || '').trim())
    .filter((name) => name.length > 0)
    .map((name) => {
      const capability = inferCapabilityFromName(name)
      return {
        name,
        capability: capability.capability,
        capabilities: capability.capabilities,
      } satisfies LocalAIModel
    })

  models.sort((a, b) => a.name.localeCompare(b.name))
  return models
}

export async function generateLmStudioText(settings: LocalAISettings, options: GenerationRequestOptions): Promise<string> {
  try {
    const payload: Record<string, unknown> = {
      provider: 'lmstudio',
      baseUrl: settings.baseUrl,
      model: settings.textModel,
      prompt: options.prompt,
      jsonPreferred: options.jsonPreferred ?? false,
      temperature: options.temperature ?? 0.3,
      numPredict: options.numPredict ?? 300,
      topP: options.topP ?? 0.9,
      timeoutMs: options.timeoutMs ?? 30000,
    }
    if (typeof options.repeatPenalty === 'number') {
      payload.repeatPenalty = options.repeatPenalty
    }
    const response = await invoke<{ text: string }>('local_ai_generate_text', payload)
    return response.text?.trim() || ''
  } catch (error) {
    console.error('LM Studio text generation via Tauri failed:', error)
    if (isTauriRuntime()) throw error
  }

  const buildBody = (includeJsonFormat: boolean) => ({
    model: settings.textModel,
    messages: [{ role: 'user', content: options.prompt }],
    temperature: options.temperature ?? 0.3,
    max_tokens: options.numPredict ?? 300,
    top_p: options.topP ?? 0.9,
    ...(includeJsonFormat && options.jsonPreferred ? { response_format: { type: 'json_object' } } : {}),
  })

  let response = await fetchWithLmStudioFallback('/v1/chat/completions', settings, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(buildBody(true)),
  }, options.timeoutMs ?? 30000)

  if (!response.ok && options.jsonPreferred) {
    response = await fetchWithLmStudioFallback('/v1/chat/completions', settings, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(buildBody(false)),
    }, options.timeoutMs ?? 30000)
  }

  if (!response.ok) {
    throw new Error(`LM Studio API error: ${response.status}`)
  }

  const data = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>
  }
  return data.choices?.[0]?.message?.content?.trim() || ''
}

export async function generateLmStudioEmbedding(settings: LocalAISettings, content: string): Promise<number[]> {
  try {
    const response = await invoke<{ embedding: number[] }>('local_ai_generate_embedding', {
      provider: 'lmstudio',
      baseUrl: settings.baseUrl,
      model: settings.embeddingModel,
      input: content,
      timeoutMs: 30000,
    })
    return Array.isArray(response.embedding) ? response.embedding : []
  } catch (error) {
    console.error('LM Studio embedding generation via Tauri failed:', error)
    if (isTauriRuntime()) throw error
  }

  const response = await fetchWithLmStudioFallback('/v1/embeddings', settings, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: settings.embeddingModel,
      input: content,
    }),
  }, 30000)

  if (!response.ok) {
    throw new Error(`LM Studio API error: ${response.status}`)
  }

  const data = await response.json()
  return Array.isArray(data.data?.[0]?.embedding) ? data.data[0].embedding : []
}
