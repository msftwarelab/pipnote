import type { AIReadableFileData } from '../services/vault'
import { summarizeContentForNaming, suggestFolderFromNamingPlan } from './titleNaming.ts'

export type ExtractionQuality = 'high' | 'medium' | 'low'
export type FileIntelligenceKind = AIReadableFileData['kind'] | 'image'
export type FileRole =
  | 'text-note'
  | 'contract'
  | 'resume'
  | 'interview'
  | 'prompt'
  | 'presentation'
  | 'spreadsheet'
  | 'statement'
  | 'offer'
  | 'profile'
  | 'guide'
  | 'proposal'
  | 'image'
  | 'general-document'

export type VisualAssetKind = 'screenshot' | 'diagram' | 'scan' | 'photo' | 'image'
export type VisualAnalysisMode = 'path' | 'ocr'

export interface FileIntelligence {
  kind: FileIntelligenceKind
  extension: string
  fileRole: FileRole
  visualKind?: VisualAssetKind
  visualAnalysisMode?: VisualAnalysisMode
  extractionQuality: ExtractionQuality
  extractionScore: number
  qualityReason: string
  preferredTitle: string
  preferredCategory: string
  preferredSubcategory?: string
  promptContext: string
  conservativeReorganization: boolean
}

const PREVIEW_ONLY_IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico', 'heic', 'svg'])

function normalizePath(path: string): string {
  return path.replace(/\\/g, '/').replace(/^\/+/, '')
}

function tokenCount(text: string): number {
  return (text.match(/[A-Za-z]{2,}/g) || []).length
}

function uniqueTokenRatio(text: string): number {
  const tokens = (text.match(/[A-Za-z]{2,}/g) || []).map((token) => token.toLowerCase())
  if (tokens.length === 0) return 0
  return new Set(tokens).size / tokens.length
}

function alphaRatio(text: string): number {
  const nonWhitespace = text.replace(/\s+/g, '')
  if (!nonWhitespace) return 0
  const alphaChars = (nonWhitespace.match(/[A-Za-z]/g) || []).length
  return alphaChars / nonWhitespace.length
}

function digitRatio(text: string): number {
  const nonWhitespace = text.replace(/\s+/g, '')
  if (!nonWhitespace) return 0
  const digits = (nonWhitespace.match(/\d/g) || []).length
  return digits / nonWhitespace.length
}

function punctuationRatio(text: string): number {
  const nonWhitespace = text.replace(/\s+/g, '')
  if (!nonWhitespace) return 0
  const punctuation = (nonWhitespace.match(/[^A-Za-z0-9]/g) || []).length
  return punctuation / nonWhitespace.length
}

function detectExtractionQuality(readable: AIReadableFileData): {
  quality: ExtractionQuality
  score: number
  reason: string
} {
  const text = readable.content.trim()
  const chars = text.length
  const words = tokenCount(text)
  const uniqueRatio = uniqueTokenRatio(text)
  const letters = alphaRatio(text)
  const digits = digitRatio(text)
  const punctuation = punctuationRatio(text)

  if (chars < 60 || words < 12) {
    return {
      quality: 'low',
      score: 0.1,
      reason: 'Very little extracted text was available.',
    }
  }

  if (letters < 0.38 || (digits > 0.34 && letters < 0.52) || punctuation > 0.28) {
    return {
      quality: 'low',
      score: 0.2,
      reason: 'Extracted text looks noisy, form-like, or poorly structured.',
    }
  }

  if (uniqueRatio < 0.28) {
    return {
      quality: 'medium',
      score: 0.48,
      reason: 'Extracted text is repetitive, so foldering should stay conservative.',
    }
  }

  if (chars < 240 || words < 45) {
    return {
      quality: 'medium',
      score: 0.62,
      reason: 'Extracted text is usable but limited in detail.',
    }
  }

  return {
    quality: 'high',
    score: 0.88,
    reason: 'Extracted text looks detailed enough for file-aware organization.',
  }
}

export function analyzeAIReadableFile(path: string, readable: AIReadableFileData): FileIntelligence {
  const normalizedPath = normalizePath(path)
  const extension = normalizedPath.split('.').pop()?.toLowerCase() || readable.kind
  const quality = detectExtractionQuality(readable)
  const namingPlan = summarizeContentForNaming(readable.content, path)
  const folderPlan = suggestFolderFromNamingPlan(readable.content, path)
  const fileLabel = readable.kind === 'pdf'
    ? 'PDF document'
    : readable.kind === 'docx'
      ? 'DOCX document'
      : readable.kind === 'pptx'
        ? 'PPTX presentation'
        : readable.kind === 'xlsx'
          ? 'XLSX spreadsheet'
          : readable.kind === 'csv'
            ? 'CSV data file'
            : readable.kind === 'image'
              ? 'image asset'
            : 'text note'
  const context = `${normalizedPath.toLowerCase()} ${readable.content.toLowerCase()}`

  let fileRole: FileRole
  if (readable.kind === 'image') {
    fileRole = 'image'
  } else {
    switch (namingPlan.kind) {
      case 'contract':
        fileRole = /\b(offer letter|offer packet|offer)\b/.test(context) ? 'offer' : /\b(statement|bank statement)\b/.test(context) ? 'statement' : 'contract'
        break
      case 'resume':
        fileRole = 'resume'
        break
      case 'interview':
        fileRole = 'interview'
        break
      case 'prompt':
        fileRole = 'prompt'
        break
      case 'presentation':
        fileRole = 'presentation'
        break
      case 'spreadsheet':
        fileRole = 'spreadsheet'
        break
      case 'image':
        fileRole = 'image'
        break
      case 'document':
        if (/\b(statement|bank statement)\b/.test(context)) fileRole = 'statement'
        else if (/\b(profile|personal profile)\b/.test(context)) fileRole = 'profile'
        else if (/\b(proposal)\b/.test(context)) fileRole = 'proposal'
        else if (/\b(guide|manual|reference|playbook|tutorial|onboarding)\b/.test(context)) fileRole = 'guide'
        else fileRole = 'general-document'
        break
      default:
        fileRole = readable.kind === 'text' ? 'text-note' : 'general-document'
        break
    }
  }

  const roleGuidance: Record<FileRole, string> = {
    'text-note': 'Prefer note-style organization and keep context grounded in the note content.',
    contract: 'Treat this as a formal contract or agreement. Prefer stable legal/business foldering and concise professional titles.',
    resume: 'Treat this as a career or job-search document. Prefer resume/interview-prep/job-search foldering.',
    interview: 'Treat this as interview preparation or transcript material. Prefer interview-prep or career-oriented foldering.',
    prompt: 'Treat this as a reusable prompt/template. Prefer resources or prompt-library style foldering.',
    presentation: 'Treat this as a slide deck or presentation artifact. Prefer presentation or project-doc foldering.',
    spreadsheet: 'Treat this as structured data/reporting content. Prefer finance, reporting, or operations foldering.',
    statement: 'Treat this as a formal statement/report/financial record. Prefer finance or official-doc foldering.',
    offer: 'Treat this as an offer-related employment document. Prefer career/documents style foldering.',
    profile: 'Treat this as a profile/background document. Prefer career/profile or personal-profile foldering.',
    guide: 'Treat this as a guide/reference/onboarding document. Prefer work-docs or reference-docs foldering.',
    proposal: 'Treat this as a proposal or planning document. Prefer project/research/proposal foldering.',
    image: 'Treat this as an image or screenshot asset. Prefer reference/image foldering and title it like a visual artifact.',
    'general-document': 'Treat this as a formal document. Prefer stable document-oriented foldering and avoid creative folder invention.',
  }

  const promptContext =
    readable.kind === 'text'
      ? `${roleGuidance[fileRole]} Preferred destination: ${folderPlan.category}${folderPlan.subcategory ? `/${folderPlan.subcategory}` : ''}. Preferred title style: ${namingPlan.title}.`
      : quality.quality === 'low'
        ? `This is a ${fileLabel} with weak extracted text. ${roleGuidance[fileRole]} Rely more on the file path and strong document cues. Preferred destination: ${folderPlan.category}${folderPlan.subcategory ? `/${folderPlan.subcategory}` : ''}. Preferred title style: ${namingPlan.title}. Avoid aggressive renames or cross-folder moves unless the fit is clearly stronger.`
        : `This is a ${fileLabel}. ${roleGuidance[fileRole]} Preferred destination: ${folderPlan.category}${folderPlan.subcategory ? `/${folderPlan.subcategory}` : ''}. Preferred title style: ${namingPlan.title}.`

  return {
    kind: readable.kind,
    extension,
    fileRole,
    visualAnalysisMode: readable.kind === 'image' ? 'ocr' : undefined,
    extractionQuality: quality.quality,
    extractionScore: quality.score,
    qualityReason: quality.reason,
    preferredTitle: namingPlan.title,
    preferredCategory: folderPlan.category,
    preferredSubcategory: folderPlan.subcategory,
    promptContext,
    conservativeReorganization: readable.kind !== 'text' && quality.quality !== 'high',
  }
}

export function isPreviewOnlyImagePath(path: string): boolean {
  const normalizedPath = normalizePath(path)
  const extension = normalizedPath.split('.').pop()?.toLowerCase() || ''
  return PREVIEW_ONLY_IMAGE_EXTENSIONS.has(extension)
}

export function analyzePreviewOnlyImageFile(path: string): FileIntelligence {
  const normalizedPath = normalizePath(path)
  const extension = normalizedPath.split('.').pop()?.toLowerCase() || 'image'
  const namingPlan = summarizeContentForNaming('', path)
  const folderPlan = suggestFolderFromNamingPlan('', path)
  const lower = normalizedPath.toLowerCase()
  const spaced = lower.replace(/[_-]+/g, ' ')
  const visualKind: VisualAssetKind =
    /\b(screenshot|screen ?shot|capture)\b/.test(spaced)
      ? 'screenshot'
      : /\b(diagram|architecture|flowchart|wireframe|mockup)\b/.test(spaced)
        ? 'diagram'
        : /\b(scan|scanned|statement|invoice|receipt|passport|id|license)\b/.test(spaced)
          ? 'scan'
          : /\b(photo|img ?\d+|dsc ?\d+|camera|picture)\b/.test(spaced)
            ? 'photo'
            : 'image'

  return {
    kind: 'image',
    extension,
    fileRole: 'image',
    visualKind,
    visualAnalysisMode: 'path',
    extractionQuality: 'medium',
    extractionScore: 0.42,
    qualityReason: 'Preview-only image organized from filename and folder context because OCR is not enabled yet.',
    preferredTitle: namingPlan.title,
    preferredCategory: folderPlan.category,
    preferredSubcategory: folderPlan.subcategory,
    promptContext: `This is a preview-only ${visualKind} asset. OCR is not enabled yet, so organize it conservatively using the filename and folder context only. Preferred destination: ${folderPlan.category}${folderPlan.subcategory ? `/${folderPlan.subcategory}` : ''}. Preferred title style: ${namingPlan.title}.`,
    conservativeReorganization: true,
  }
}
