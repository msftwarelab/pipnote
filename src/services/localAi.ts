import { extractLooseJsonObject } from '../utils/jsonRecovery'
import type { EmbeddingRecord } from '../types/embedding'
import {
  looksLikeMessyGeneratedTitle,
  normalizeGeneratedTitleForPlan,
  suggestFolderFromNamingPlan,
  summarizeContentForNaming,
} from '../utils/titleNaming'
import type { FileIntelligence } from '../utils/fileIntelligence'
import {
  getDefaultLocalAISettings,
  getLocalAISettings,
  modelSatisfies,
  modelSupportsCapability,
  normalizeBaseUrl,
  providerLabel,
  saveLocalAISettings,
  type GenerationRequestOptions,
  type LocalAIModel,
  type LocalAIModelSelectionStatus,
  type LocalAIProvider,
  type LocalAISettings,
} from './localAiTypes'
import { generateLmStudioEmbedding, generateLmStudioText, listLmStudioModels } from './providers/lmStudioProvider'
import { generateOllamaEmbedding, generateOllamaText, listOllamaModels } from './providers/ollamaProvider'
import { assessReorgModelOutput } from '../utils/reorgModelGuard'
import { buildReorganizationAnalysisPrompt, buildReorganizationRetryPrompt } from '../utils/reorgPrompts'

export type {
  LocalAIProvider,
  LocalAISettings,
  LocalAIModel,
  LocalAIModelCapability,
  LocalAIModelSelectionStatus,
  GenerationRequestOptions,
}
from './localAiTypes'

async function listProviderModels(settings: LocalAISettings): Promise<LocalAIModel[]> {
  return settings.provider === 'lmstudio'
    ? listLmStudioModels(settings)
    : listOllamaModels(settings)
}

async function requestTextGeneration(settings: LocalAISettings, options: GenerationRequestOptions): Promise<string> {
  return settings.provider === 'lmstudio'
    ? generateLmStudioText(settings, options)
    : generateOllamaText(settings, options)
}

let lastHealthError: string | null = null

// List of forbidden generic titles - NEVER use these
const FORBIDDEN_TITLES = [
  'untitled', 'untitled note', 'new note', 'note', 'document',
  'note title here', 'title', 'my note', 'notes', 'draft'
]
const GENERIC_CATEGORIES = new Set([
  'quick notes',
  'notes',
  'misc',
  'miscellaneous',
  'general',
  'uncategorized',
  'untitled',
])

// Generate a smart title from content - NEVER copy verbatim from content
// Check if a title is forbidden/generic
function isForbiddenTitle(title: string): boolean {
  const lower = title.toLowerCase().trim()
  return FORBIDDEN_TITLES.some(forbidden => 
    lower === forbidden || lower.includes('untitled') || lower === 'note title here'
  )
}

function inferCategoryFromContent(content: string): { category: string; subcategory?: string } {
  return suggestFolderFromNamingPlan(content)
}

function stripProblematicEmbeddingCharacters(value: string): string {
  let next = ''
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0
    const isControl = (code >= 0 && code <= 8) || code === 11 || code === 12 || (code >= 14 && code <= 31) || (code >= 127 && code <= 159)
    const isPrivateUse = code >= 0xe000 && code <= 0xf8ff
    next += isControl || isPrivateUse ? ' ' : char
  }
  return next
}

function fallbackClassificationFromContent(content: string, currentPath?: string): NoteClassification {
  const inferred = suggestFolderFromNamingPlan(content, currentPath)
  const namingPlan = summarizeContentForNaming(content, currentPath)
  return {
    title: namingPlan.title,
    category: inferred.category,
    subcategory: inferred.subcategory,
  }
}

function normalizeReorgPathSegment(segment: string): string {
  return segment.replace(/[/\\:*?"<>|]/g, '-').trim()
}

function normalizeReorgSuggestedPath(suggestedPath: string, fallbackPath: string, fallbackTitle: string): string {
  const normalizedFallback = fallbackPath
    .replace(/^\/+/, '')
    .replace(/^notes\//i, '')
    .replace(/\.md$/i, '')
  const fallbackSegments = normalizedFallback
    .split('/')
    .map(normalizeReorgPathSegment)
    .filter(Boolean)

  const cleanedSuggested = (suggestedPath || '')
    .replace(/\\/g, '/')
    .replace(/^\/+/, '')
    .replace(/^notes\//i, '')
    .replace(/\.md$/i, '')

  const suggestedSegments = cleanedSuggested
    .split('/')
    .map(normalizeReorgPathSegment)
    .filter(Boolean)

  const baseSegments = suggestedSegments.length >= 2
    ? suggestedSegments
    : fallbackSegments.length >= 2
      ? fallbackSegments
      : ['Learning', normalizeReorgPathSegment(fallbackTitle)]

  const title = normalizeReorgPathSegment(baseSegments[baseSegments.length - 1] || fallbackTitle) || 'Note'
  const categorySegments = baseSegments.slice(0, -1).filter(Boolean)
  const combined = [...categorySegments, title]
  if (combined.length < 2) {
    combined.unshift('Learning')
  }
  return combined.join('/')
}

function buildHeuristicReorganizationResult(content: string, currentPath: string, reason: string) {
  const normalizedCurrent = currentPath.replace(/^\/+/, '').replace(/^notes\//i, '').trim()
  const normalizedCurrentWithoutExt = normalizedCurrent.replace(/\.md$/i, '')
  const currentParts = normalizedCurrentWithoutExt.split('/').filter(Boolean)
  const currentTop = currentParts[0]?.toLowerCase() || ''
  const isUncategorized = currentParts.length <= 1 || GENERIC_CATEGORIES.has(currentTop)

  const inferred = suggestFolderFromNamingPlan(content, currentPath)
  const namingPlan = summarizeContentForNaming(content, currentPath)
  const inferredTitle = normalizeReorgPathSegment(namingPlan.title.replace(/\.md$/i, '').trim()) || 'Note'
  const inferredPath = [inferred.category, inferred.subcategory, inferredTitle].filter(Boolean).join('/')
  const suggestedPath = isUncategorized
    ? normalizeReorgSuggestedPath(inferredPath, normalizedCurrentWithoutExt || inferredPath, inferredTitle)
    : normalizeReorgSuggestedPath(normalizedCurrentWithoutExt, inferredPath, inferredTitle)
  const suggestedTitle = suggestedPath.split('/').pop() || inferredTitle

  return {
    shouldKeep: true,
    suggestedPath,
    suggestedTitle,
    isDuplicate: false,
    reason,
  }
}

export interface NoteClassification {
  title: string
  category: string
  subcategory?: string
}

export type NoteEmbedding = EmbeddingRecord

export interface SearchResult {
  notePath: string
  similarity: number
  content?: string
  retrievalSummary?: string
  retrievalTags?: string[]
  retrievalPathTerms?: string[]
}

export interface LocalAIService {
  checkHealth: () => Promise<boolean>
  getHealthError: () => string | null
  getSettings: () => LocalAISettings
  updateSettings: (settings: Partial<LocalAISettings>) => LocalAISettings
  listLocalModels: () => Promise<LocalAIModel[]>
  getModelSelectionStatus: () => Promise<LocalAIModelSelectionStatus>
  classifyNote: (content: string) => Promise<NoteClassification>
  generateEmbedding: (content: string) => Promise<NoteEmbedding>
  answerQuestion: (question: string, context: string, notePath: string) => Promise<string>
  answerGeneralQuestion: (question: string) => Promise<string>
  analyzeNoteForReorganization: (content: string, currentPath: string, fileContext?: FileIntelligence) => Promise<{
    shouldKeep: boolean
    suggestedPath: string
    suggestedTitle: string
    isDuplicate: boolean
    duplicateOf?: string
    reason: string
  }>
}

export const localAiService: LocalAIService = {
  async listLocalModels(): Promise<LocalAIModel[]> {
    const settings = getLocalAISettings()
    try {
      return await listProviderModels(settings)
    } catch (error) {
      console.error(`Failed to list local ${providerLabel(settings.provider)} models:`, error)
      throw error
    }
  },

  async getModelSelectionStatus(): Promise<LocalAIModelSelectionStatus> {
    const settings = getLocalAISettings()
    const models = await listProviderModels(settings)
    const availableModels = models.map((model) => model.name)
    const matchingTextModels = models.filter((model) => modelSatisfies(settings.textModel, model.name))
    const matchingEmbeddingModels = models.filter((model) => modelSatisfies(settings.embeddingModel, model.name))
    const textModelAvailable = matchingTextModels.length > 0
    const embeddingModelAvailable = matchingEmbeddingModels.length > 0
    const textModelCapabilityValid = textModelAvailable
      ? matchingTextModels.some((model) => modelSupportsCapability(model.capability, 'text'))
      : false
    const embeddingModelCapabilityValid = embeddingModelAvailable
      ? matchingEmbeddingModels.some((model) => modelSupportsCapability(model.capability, 'embedding'))
      : false
    const missing: string[] = []
    const incompatible: string[] = []
    if (!textModelAvailable) missing.push(settings.textModel)
    if (textModelAvailable && !textModelCapabilityValid) incompatible.push(settings.textModel)
    if (!embeddingModelAvailable) missing.push(settings.embeddingModel)
    if (embeddingModelAvailable && !embeddingModelCapabilityValid) incompatible.push(settings.embeddingModel)
    return {
      availableModels,
      textModelAvailable,
      embeddingModelAvailable,
      textModelCapabilityValid,
      embeddingModelCapabilityValid,
      missing,
      incompatible,
    }
  },

  async checkHealth(): Promise<boolean> {
    const settings = getLocalAISettings()
    try {
      const status = await localAiService.getModelSelectionStatus()
      if (status.missing.length > 0 || status.incompatible.length > 0) {
        const details: string[] = []
        if (status.missing.length > 0) details.push(`Missing: ${status.missing.join(', ')}`)
        if (status.incompatible.length > 0) details.push(`Capability mismatch: ${status.incompatible.join(', ')}`)
        lastHealthError = `${providerLabel(settings.provider)} is running, but model configuration is invalid. ${details.join('. ')}. Available: ${status.availableModels.join(', ') || 'none'}.`
        console.warn(lastHealthError)
        return false
      }

      lastHealthError = null
      console.log(`${providerLabel(settings.provider)} is running and required models are available`)
      return true
    } catch (error) {
      console.error(`${providerLabel(settings.provider)} health check failed:`, error)
      lastHealthError = `Cannot reach ${providerLabel(settings.provider)} at ${settings.baseUrl}.`
      return false
    }
  },

  getHealthError(): string | null {
    return lastHealthError
  },

  getSettings(): LocalAISettings {
    return getLocalAISettings()
  },

  updateSettings(settings: Partial<LocalAISettings>): LocalAISettings {
    const current = getLocalAISettings()
    const provider: LocalAIProvider = settings.provider === 'lmstudio' ? 'lmstudio' : (settings.provider === 'ollama' ? 'ollama' : current.provider)
    const defaults = getDefaultLocalAISettings(provider)
    const next: LocalAISettings = {
      provider,
      baseUrl: normalizeBaseUrl(settings.baseUrl || current.baseUrl || defaults.baseUrl),
      textModel: (settings.textModel || current.textModel || defaults.textModel).trim(),
      embeddingModel: (settings.embeddingModel || current.embeddingModel || defaults.embeddingModel).trim(),
    }
    saveLocalAISettings(next)
    return next
  },

  async classifyNote(content: string): Promise<NoteClassification> {
    const settings = getLocalAISettings()

    // If content is empty or too short, extract title from what we have
    if (!content || content.trim().length < 10) {
      console.log('⚠️ Content too short for classification, extracting title from content')
      return fallbackClassificationFromContent(content)
    }

    try {
      console.log('🤖 Starting AI classification...')
      console.log(`📝 Content length: ${content.length} characters`)
      
      const namingPlan = summarizeContentForNaming(content)

      const prompt = `You are an expert note classification AI. Analyze the content and create a precise, descriptive title that summarizes the MAIN TOPIC, not the opening words.
Note Content:
${content.substring(0, 2000)} ${content.length > 2000 ? '...' : ''}

Semantic naming summary:
- Document style: ${namingPlan.kind}
- Short summary: ${namingPlan.summary}
- Preferred professional title style: ${namingPlan.title}

CRITICAL RULES FOR ANALYSIS:
1. Analyze both the note content and its file/folder path for ALL structural issues.
2. Detect and flag ANY problem that makes the vault less organized, readable, or efficient, including but not limited to:
   - Excessive folder nesting (e.g., repeated folders)
   - Files with repeated or malformed extensions
   - Empty, redundant, or orphaned folders
   - Duplicate or orphaned files
   - Inconsistent naming, misplaced notes, or unclear hierarchy
   - Any other issue that reduces clarity, searchability, or maintainability
3. Suggest a new path/title or action for each issue, and provide a reason for each suggestion.
4. Keep title 3-8 words maximum, professionally descriptive.

CORRECT APPROACH - Analyze then Summarize:
- Content about meeting times → Title: "Julian Thomas Meeting Schedule"
- Path with repeated folders → Suggest: Remove redundant folders
- Filename with repeated .md → Suggest: Rename to single .md
- Empty folder → Suggest: Remove
- Orphaned file → Suggest: Move or delete
- Redundant folder → Suggest: Merge or remove
- Inconsistent naming → Suggest: Rename for clarity

WRONG APPROACH - Never Do This:
❌ Ignore structural issues
❌ Generic: "Untitled", "New Document"
❌ Verbatim from content: Taking any consecutive words from the note

CATEGORIZATION:
- Main category: Work, Personal, Projects, Learning, Ideas, Health, Finance, etc.
- Subcategory (optional): Meetings, Planning, Research, Tutorial, Journal, etc.

RESPONSE FORMAT - ONLY JSON, no other text:
{
  "title": "Synthesized Descriptive Title Here",
  "category": "Main Category",
  "subcategory": "Optional Subcategory",
  "structuralIssues": [
    { "type": "nestedFolders", "path": "notes/notes/notes/...", "suggestion": "Flatten folders" },
    { "type": "repeatedExtension", "path": "Title.md.md.md", "suggestion": "Rename to Title.md" },
    { "type": "emptyFolder", "path": "notes/Empty", "suggestion": "Remove folder" },
    { "type": "orphanedFile", "path": "notes/Orphan.md", "suggestion": "Delete or move" },
    { "type": "redundantFolder", "path": "notes/Redundant", "suggestion": "Merge or remove" },
    { "type": "inconsistentNaming", "path": "notes/BadName.md", "suggestion": "Rename for clarity" }
    // ...and any other issue found
  ]
}

Analyze the content and path deeply and respond with the JSON object:`

      console.log(`🔄 Sending request to ${providerLabel(settings.provider)}...`)
      let responseText = await requestTextGeneration(settings, {
        prompt,
        jsonPreferred: true,
        temperature: 0.3,
        numPredict: 200,
        topP: 0.9,
        repeatPenalty: 1.2,
        timeoutMs: 30000,
      })
      console.log('✅ Model response received')
      console.log('📄 Raw response:', responseText)
      console.log('📄 Full response length:', responseText.length)

      // Try to unescape if the response is a JSON string (contains escaped quotes)
      if (responseText.includes('\\"') || responseText.includes('\\n')) {
        console.log('🔧 Detected escaped JSON, attempting to unescape')
        try {
          // Try to parse as a JSON string first
          const unescaped = JSON.parse(responseText)
          if (typeof unescaped === 'string') {
            responseText = unescaped
            console.log('✅ Unescaped response:', responseText)
          }
        } catch {
          // If it fails, try manual unescaping
          responseText = responseText.replace(/\\"/g, '"').replace(/\\n/g, '\n')
          console.log('✅ Manually unescaped response:', responseText)
        }
      }

      // Try multiple JSON extraction methods
      let classification: NoteClassification | null = null
      
      // Method 1: Try to find JSON object in response
      const jsonMatch = responseText.match(/\{[\s\S]*\}/)
      if (jsonMatch) {
        try {
          console.log('🔍 Found JSON match:', jsonMatch[0])
          classification = JSON.parse(jsonMatch[0]) as NoteClassification
        } catch (parseError) {
          console.warn('⚠️ Failed to parse matched JSON:', parseError)
        }
      }
      
      // Method 2: Try to extract from code blocks if present
      if (!classification) {
        const codeBlockMatch = responseText.match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/)
        if (codeBlockMatch) {
          try {
            console.log('🔍 Found JSON in code block:', codeBlockMatch[1])
            classification = JSON.parse(codeBlockMatch[1]) as NoteClassification
          } catch (parseError) {
            console.warn('⚠️ Failed to parse code block JSON:', parseError)
          }
        }
      }
      
      // Method 3: Try to find just the object part if LLM added extra text
      if (!classification) {
        const cleanMatch = responseText.match(/"title"\s*:\s*"[^"]*"[\s\S]*"category"\s*:\s*"[^"]*"/)
        if (cleanMatch) {
          const wrappedJson = `{${cleanMatch[0]}}`
          try {
            console.log('🔍 Attempting to parse cleaned JSON:', wrappedJson)
            classification = JSON.parse(wrappedJson) as NoteClassification
          } catch (parseError) {
            console.warn('⚠️ Failed to parse cleaned JSON:', parseError)
          }
        }
      }

      if (!classification) {
        console.warn('⚠️ All JSON parsing methods failed, attempting retry with simpler prompt')
        
        // Retry with an extremely simple prompt
        const retryPrompt = `Classify this note. Respond with JSON only:
{"title": "note title here", "category": "Work or Personal or Projects or Learning"}

Note: ${content.substring(0, 500)}`
        
        try {
          const retryText = await requestTextGeneration(settings, {
            prompt: retryPrompt,
            jsonPreferred: true,
            temperature: 0.1,
            numPredict: 100,
            timeoutMs: 15000,
          })
            console.log('🔄 Retry response:', retryText)
            
          const retryJsonMatch = retryText.match(/\{[\s\S]*\}/)
          if (retryJsonMatch) {
            classification = JSON.parse(retryJsonMatch[0]) as NoteClassification
            console.log('✅ Retry successful:', classification)
          }
        } catch (retryError) {
          console.error('❌ Retry failed:', retryError)
        }
      }
      
      if (!classification) {
        console.warn('⚠️ All attempts failed, extracting title from content')
        return fallbackClassificationFromContent(content)
      }

      // Validate the classification
      if (!classification.title || !classification.category) {
        console.warn('⚠️ Invalid classification structure:', classification)
        return fallbackClassificationFromContent(content)
      }

      console.log('✅ Successfully parsed classification:', classification)

      classification.title = normalizeGeneratedTitleForPlan(classification.title, namingPlan)

      // CRITICAL: Check if AI returned a forbidden/generic title
      if (isForbiddenTitle(classification.title) || looksLikeMessyGeneratedTitle(classification.title)) {
        console.warn('⚠️ AI returned forbidden generic title, generating semantic title')
        classification.title = namingPlan.title
      }
      
      // STRICT CHECK: Detect if title is copying from the start of content (NEVER ALLOWED)
      const contentStart = content.trim().substring(0, 150).toLowerCase()
      const contentWords = contentStart.split(/\s+/).slice(0, 10).join(' ')
      const titleLower = classification.title.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').trim()
      const titleWords = titleLower.split(/\s+/)
      
      // Multi-layer verbatim detection
      let needsRetry = false
      let retryReason = ''
      
      // Check 1: Consecutive word matching at content start
      if (titleWords.length >= 3) {
        const titlePattern = titleWords.slice(0, Math.min(5, titleWords.length)).join('\\s+')
        const regex = new RegExp(`^\\s*${titlePattern}`, 'i')
        if (regex.test(contentWords)) {
          needsRetry = true
          retryReason = 'verbatim copy from content start'
        }
      }
      
      // Check 2: Exact substring match
      const contentPrefix = content.trim().substring(0, classification.title.length).toLowerCase().replace(/[^a-z0-9]/g, '')
      const titleClean = titleLower.replace(/[^a-z0-9]/g, '')
      if (contentPrefix === titleClean && titleClean.length > 10) {
        needsRetry = true
        retryReason = 'exact substring of content'
      }
      
      // Check 3: Forbidden starting phrases
      const forbiddenStarts = ['here is', 'this is', 'i am', 'my latest', 'the following', 'note about']
      if (forbiddenStarts.some(phrase => titleLower.startsWith(phrase))) {
        needsRetry = true
        retryReason = 'forbidden starting phrase'
      }
      
      // Check 4: Malformed or truncated
      if (classification.title.match(/[-.]{2,}$|\s+$|^[^A-Z0-9]/)) {
        needsRetry = true
        retryReason = 'malformed or truncated'
      }
      
      // Check 5: Too vague
      const meaningfulWords = classification.title.split(/\s+/).filter(w => w.length > 3)
      if (meaningfulWords.length < 2) {
        needsRetry = true
        retryReason = 'too vague or generic'
      }
      
      // If LLM failed validation, give it ONE more chance with stronger prompt
      if (needsRetry) {
        console.warn(`❌ REJECTED LLM TITLE: ${retryReason}`)
        console.warn(`   Failed title: "${classification.title}"`)
        console.warn(`   Content preview: "${content.substring(0, 80)}..."`)
        console.warn(`🔄 RETRY: Asking LLM to synthesize properly...`)
        
        try {
          // Extremely strict retry prompt
          const retryPrompt = `CRITICAL INSTRUCTION: You MUST create a NEW synthesized title. DO NOT copy any phrase from the content.

Content to analyze:
${content.substring(0, 1000)}

FORBIDDEN: Never use these from the content:
- First line: "${content.split('\n')[0].substring(0, 60)}"
- Opening words: "${content.substring(0, 40)}"

REQUIRED: Analyze the TOPIC and PURPOSE, then create a brand new descriptive title.

Example - If content is "Hello, here are my meeting times with John on Wednesday...", the title should be "John Meeting Schedule" NOT "Hello here are my meeting times"

Respond with JSON only:
{"title": "Your New Synthesized Title", "category": "Category", "subcategory": "Optional"}`

          const retryText = await requestTextGeneration(settings, {
            prompt: retryPrompt,
            jsonPreferred: true,
            temperature: 0.5,
            numPredict: 150,
            repeatPenalty: 1.5,
            timeoutMs: 20000,
          })
          const retryJsonMatch = retryText.match(/\{[\s\S]*\}/)
          if (retryJsonMatch) {
            const retryClassification = JSON.parse(retryJsonMatch[0]) as NoteClassification
            
            // Validate retry result
            const retryTitleLower = retryClassification.title.toLowerCase()
            const stillCopying = forbiddenStarts.some(phrase => retryTitleLower.startsWith(phrase)) ||
                                 contentWords.toLowerCase().startsWith(retryTitleLower.substring(0, 20))
            
            if (!stillCopying && retryClassification.title.split(/\s+/).filter(w => w.length > 3).length >= 2) {
              console.log('✅ RETRY SUCCESS: LLM provided synthesized title')
              classification.title = normalizeGeneratedTitleForPlan(retryClassification.title, namingPlan)
            }
          } else {
            console.warn('⚠️ RETRY STILL FAILED: Falling back to semantic extraction')
            classification.title = namingPlan.title
          }
        } catch (retryError) {
          console.error('❌ Retry failed:', retryError)
          classification.title = namingPlan.title
        }

      }

      // Sanitize category and subcategory
      classification.category = classification.category
        .replace(/[/\\:*?"<>|]/g, '-')
        .trim()

      if (classification.subcategory) {
        classification.subcategory = classification.subcategory
          .replace(/[/\\:*?"<>|]/g, '-')
          .trim()
      }

      const inferred = inferCategoryFromContent(content)
      const plannerAnchoredKinds = new Set([
        'interview',
        'prompt',
        'resume',
        'meeting',
        'contract',
        'presentation',
        'spreadsheet',
        'image',
        'code',
      ])

      if (GENERIC_CATEGORIES.has(classification.category.toLowerCase())) {
        classification.category = inferred.category
        classification.subcategory = inferred.subcategory
      } else if (plannerAnchoredKinds.has(namingPlan.kind) && classification.category !== inferred.category) {
        classification.category = inferred.category
        classification.subcategory = inferred.subcategory
      } else if (!classification.subcategory && inferred.subcategory && classification.category === inferred.category) {
        classification.subcategory = inferred.subcategory
      }

      console.log('✨ Classification complete:')
      console.log(`  📌 Title: "${classification.title}"`)
      console.log(`  📁 Category: "${classification.category}"`)
      if (classification.subcategory) {
        console.log(`  📂 Subcategory: "${classification.subcategory}"`)
      }
      
      return classification

    } catch (error) {
      console.error('❌ Classification failed:', error)
      return fallbackClassificationFromContent(content)
    }
  },

  async generateEmbedding(content: string): Promise<NoteEmbedding> {
    console.log('🔢 Generating embedding for content...')
    const settings = getLocalAISettings()
    
    try {
      const sanitized = stripProblematicEmbeddingCharacters(content.normalize('NFKC'))
        .replace(/\s+/g, ' ')
        .trim()

      const attempts = [
        sanitized.slice(0, 8000),
        sanitized.slice(0, 4000),
        sanitized.slice(0, 2000),
      ].filter((value, index, arr) => value.length > 0 && arr.indexOf(value) === index)

      let lastError: Error | null = null

      for (const attemptContent of attempts) {
        try {
          const vector = settings.provider === 'lmstudio'
            ? await generateLmStudioEmbedding(settings, attemptContent)
            : await generateOllamaEmbedding(settings, attemptContent)

          if (!vector || !Array.isArray(vector)) {
            lastError = new Error(`Invalid embedding response from ${providerLabel(settings.provider)}`)
            continue
          }

          const embedding: NoteEmbedding = {
            embedding: vector,
            model: settings.embeddingModel,
            created_at: new Date().toISOString(),
          }

          console.log(`✅ Generated ${vector.length}-dimensional embedding`)
          return embedding
        } catch (error) {
          lastError = error instanceof Error ? error : new Error(String(error))
          if (lastError.message.includes('500')) {
            continue
          }
          throw lastError
        }
      }

      throw lastError || new Error('Embedding generation failed')

    } catch (error) {
      console.error('❌ Embedding generation failed:', error)
      throw error
    }
  },

  async answerQuestion(question: string, context: string, notePath: string): Promise<string> {
    console.log(`🤔 Answering question using ${providerLabel(getLocalAISettings().provider)}...`)
    const settings = getLocalAISettings()
    console.log(`📝 Question: "${question}"`)
    console.log(`📄 Note path: "${notePath}"`)
    console.log(`📋 Note content length: ${context.length} chars`)
    console.log(`📋 Note content preview: "${context.substring(0, 200)}..."`)
    
    try {
      const prompt = `You are a helpful assistant that answers questions based on the provided note content.

QUESTION: ${question}

NOTE CONTENT (from ${notePath}):
${context}

INSTRUCTIONS:
- Prefer information from the note content when it is relevant
- If the note does not contain enough information, still provide a helpful direct answer using your general knowledge
- Be concise and direct
- Quote relevant parts of the note when helpful

ANSWER:`

      const answer = await requestTextGeneration(settings, {
        prompt,
        temperature: 0.5,
        numPredict: 300,
        timeoutMs: 30000,
      })

      console.log(`✅ Answer generated (${answer.length} chars)`)
      console.log(`💬 Answer: "${answer}"`)
      
      return answer

    } catch (error) {
      console.error('❌ Question answering failed:', error)
      throw error
    }
  },

  async answerGeneralQuestion(question: string): Promise<string> {
    const settings = getLocalAISettings()
    try {
      const prompt = `You are a helpful assistant.

QUESTION: ${question}

INSTRUCTIONS:
- Answer directly and naturally.
- Be concise but useful.
- Do not mention note retrieval or missing vault context unless explicitly asked.

ANSWER:`

      return await requestTextGeneration(settings, {
        prompt,
        temperature: 0.6,
        numPredict: 300,
        timeoutMs: 30000,
      })
    } catch (error) {
      console.error('❌ General question answering failed:', error)
      throw error
    }
  },

  async analyzeNoteForReorganization(content: string, currentPath: string, fileContext?: FileIntelligence) {
    const settings = getLocalAISettings()
    const fallback = buildHeuristicReorganizationResult(content, currentPath, 'Heuristic fallback from note content')
    const normalizedCurrent = currentPath.replace(/^\/+/, '').replace(/^notes\//i, '').trim().toLowerCase()
    const namingPlan = summarizeContentForNaming(content, currentPath)
    const expectedFolder = suggestFolderFromNamingPlan(content, currentPath)

    const coerceBoolean = (value: unknown, defaultValue: boolean): boolean => {
      if (typeof value === 'boolean') return value
      if (typeof value === 'string') {
        const normalized = value.trim().toLowerCase()
        if (normalized === 'true' || normalized === 'yes' || normalized === '1') return true
        if (normalized === 'false' || normalized === 'no' || normalized === '0') return false
      }
      if (typeof value === 'number') {
        if (value === 1) return true
        if (value === 0) return false
      }
      return defaultValue
    }

    const coerceString = (value: unknown): string => {
      if (typeof value === 'string') return value.trim()
      if (typeof value === 'number' || typeof value === 'boolean') return String(value).trim()
      return ''
    }

    const parseAnalysis = (raw: unknown) => {
      const parsed = extractLooseJsonObject<{
        shouldKeep?: boolean
        suggestedPath?: string
        suggestedTitle?: string
        isDuplicate?: boolean
        duplicateOf?: string
        reason?: string
      }>(raw)

      if (!parsed) {
        return null
      }

      const shouldKeepValue = coerceBoolean((parsed as Record<string, unknown>).shouldKeep ?? (parsed as Record<string, unknown>).keep, true)
      const suggestedPathValue = coerceString(
        (parsed as Record<string, unknown>).suggestedPath
          ?? (parsed as Record<string, unknown>).path
          ?? (parsed as Record<string, unknown>).targetPath
          ?? (parsed as Record<string, unknown>).folderPath,
      )
      const suggestedTitleValue = coerceString(
        (parsed as Record<string, unknown>).suggestedTitle
          ?? (parsed as Record<string, unknown>).title
          ?? (parsed as Record<string, unknown>).newTitle
          ?? (parsed as Record<string, unknown>).noteTitle,
      )
      const reasonValue = coerceString(
        (parsed as Record<string, unknown>).reason
          ?? (parsed as Record<string, unknown>).rationale
          ?? (parsed as Record<string, unknown>).why,
      )

      // Strict schema gate: if core fields are missing, force retry once.
      if (!suggestedPathValue || !suggestedTitleValue || !reasonValue) {
        return null
      }

      const rawTitle = normalizeReorgPathSegment(
        normalizeGeneratedTitleForPlan(suggestedTitleValue.replace(/\.md$/i, '').trim(), namingPlan),
      )
      if (!rawTitle) return null

      const suggestedTitle = rawTitle
      const suggestedPath = normalizeReorgSuggestedPath(suggestedPathValue, fallback.suggestedPath, suggestedTitle)
      if (!suggestedPath || !suggestedPath.includes('/')) return null

      const duplicateCandidate = coerceString(
        (parsed as Record<string, unknown>).duplicateOf
          ?? (parsed as Record<string, unknown>).duplicatePath,
      )
        .replace(/^\/+/, '')
        .replace(/^notes\//i, '')
        .trim()
      const normalizedDuplicate = duplicateCandidate
        ? (duplicateCandidate.toLowerCase().endsWith('.md') ? duplicateCandidate : `${duplicateCandidate}.md`)
        : ''
      const isDuplicate = coerceBoolean((parsed as Record<string, unknown>).isDuplicate, false)
        && normalizedDuplicate.length > 0
        && normalizedDuplicate.toLowerCase() !== normalizedCurrent

      return {
        shouldKeep: shouldKeepValue,
        suggestedPath,
        suggestedTitle,
        isDuplicate,
        duplicateOf: isDuplicate ? normalizedDuplicate : undefined,
        reason: reasonValue,
      }
    }

    const validateModelAnalysis = (candidate: ReturnType<typeof parseAnalysis>) => {
      if (!candidate) return null
      const guard = assessReorgModelOutput({
        currentPath,
        suggestedPath: candidate.suggestedPath,
        suggestedTitle: candidate.suggestedTitle,
        reason: candidate.reason,
        isDuplicate: candidate.isDuplicate,
        duplicateOf: candidate.duplicateOf,
        namingPlan,
        expectedFolder,
        fileContext,
      })

      return {
        analysis: guard.confidence === 'medium'
          ? {
            ...candidate,
            reason: candidate.reason.toLowerCase().includes('low-confidence refinement')
              ? candidate.reason
              : `${candidate.reason} (low-confidence refinement)`,
          }
          : candidate,
        confidence: guard.confidence,
      }
    }

    try {
      const prompt = buildReorganizationAnalysisPrompt({
        currentPath,
        content,
        namingPlan,
        fileContext,
      })

      const primaryResponse = await requestTextGeneration(settings, {
        prompt,
        jsonPreferred: true,
        temperature: 0.2,
        numPredict: 260,
        timeoutMs: 30000,
      })
      const primary = validateModelAnalysis(parseAnalysis(primaryResponse))
      if (primary?.confidence === 'high') {
        return primary.analysis
      }

      const mediumCandidate = primary?.confidence === 'medium' ? primary.analysis : null

      const retryPrompt = buildReorganizationRetryPrompt({
        currentPath,
        content,
        namingPlan,
        fileContext,
      })

      try {
        const retryResponse = await requestTextGeneration(settings, {
          prompt: retryPrompt,
          jsonPreferred: true,
          temperature: 0.1,
          numPredict: 180,
          timeoutMs: 20000,
        })
        const retried = validateModelAnalysis(parseAnalysis(retryResponse))
        if (retried?.confidence === 'high' || retried?.confidence === 'medium') {
          return retried.analysis
        }
      } catch {
        // fall through to heuristic fallback
      }

      if (mediumCandidate) {
        return mediumCandidate
      }

      return {
        ...fallback,
        reason: 'Heuristic fallback after invalid model JSON output',
      }
    } catch (error) {
      console.error('Analysis failed:', error)
      return {
        ...fallback,
        reason: 'Heuristic fallback after model analysis error',
      }
    }
  }
}
