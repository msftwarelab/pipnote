import { looksUncategorized, normalizeReorgPathSegment } from './reorganizePathing.ts'
import { summarizeContentForNaming, suggestFolderFromNamingPlan } from './titleNaming.ts'

export type ReorganizationStrategy = 'meaning' | 'type' | 'timeline' | 'project'

export interface StrategyTaxonomyProfile {
  topLevels: Set<string>
  subpathsByTopLevel: Map<string, Set<string>>
}

export interface ApplyReorganizationStrategyInput {
  strategy: ReorganizationStrategy
  currentRelative: string
  suggestedRelative: string
  content: string
  modifiedAt?: string
  taxonomy: StrategyTaxonomyProfile
}

export interface StrategyApplicationResult {
  targetRelative: string
  rationale?: string
}

export const REORGANIZATION_STRATEGIES: Array<{
  id: ReorganizationStrategy
  label: string
  description: string
}> = [
  { id: 'meaning', label: 'Meaning', description: 'Semantic default based on note meaning and vault patterns.' },
  { id: 'type', label: 'Type', description: 'Bias toward document-type folders like contracts, prompts, reports, or presentations.' },
  { id: 'timeline', label: 'Timeline', description: 'Group dated notes into a clean year and month structure.' },
  { id: 'project', label: 'Project', description: 'Keep notes within their current workstream unless a move is clearly needed.' },
]

function fileNameFromRelative(path: string): string {
  const parts = path.split('/').filter(Boolean)
  return parts[parts.length - 1] || 'Note.md'
}

function pathExtension(path: string): string {
  const fileName = fileNameFromRelative(path)
  const idx = fileName.lastIndexOf('.')
  return idx > 0 ? fileName.slice(idx) : ''
}

function fileStem(path: string): string {
  const fileName = fileNameFromRelative(path)
  const idx = fileName.lastIndexOf('.')
  return idx > 0 ? fileName.slice(0, idx) : fileName
}

function normalizeFileName(raw: string, fallbackPath: string): string {
  const ext = pathExtension(raw) || pathExtension(fallbackPath)
  const stem = normalizeReorgPathSegment(fileStem(raw) || fileStem(fallbackPath) || 'Note').trim() || 'Note'
  return `${stem}${ext}`
}

function buildRelative(parentSegments: string[], fileName: string): string {
  const cleanSegments = parentSegments
    .map((segment) => normalizeReorgPathSegment(segment))
    .map((segment) => segment.trim())
    .filter(Boolean)

  return [...cleanSegments, normalizeFileName(fileName, fileName)].join('/')
}

function monthLabel(month: number): string {
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
  return `${String(month).padStart(2, '0')}-${months[Math.max(0, Math.min(month - 1, 11))]}`
}

function parseDateFromString(value: string): { year: number; month: number; day?: number } | null {
  const iso = value.match(/\b(20\d{2})[-_/](\d{1,2})(?:[-_/](\d{1,2}))?\b/)
  if (iso) {
    const year = Number(iso[1])
    const month = Number(iso[2])
    const day = iso[3] ? Number(iso[3]) : undefined
    if (month >= 1 && month <= 12) {
      return { year, month, day }
    }
  }

  const monthMatch = value.match(/\b(january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec)\b[\s,-]*(\d{1,2})?(?:[\s,-]*(20\d{2}))?/i)
  if (monthMatch) {
    const monthLookup: Record<string, number> = {
      january: 1, jan: 1,
      february: 2, feb: 2,
      march: 3, mar: 3,
      april: 4, apr: 4,
      may: 5,
      june: 6, jun: 6,
      july: 7, jul: 7,
      august: 8, aug: 8,
      september: 9, sep: 9, sept: 9,
      october: 10, oct: 10,
      november: 11, nov: 11,
      december: 12, dec: 12,
    }
    const month = monthLookup[monthMatch[1].toLowerCase()]
    const day = monthMatch[2] ? Number(monthMatch[2]) : undefined
    const year = monthMatch[3] ? Number(monthMatch[3]) : undefined
    if (month) {
      return {
        year: year || 0,
        month,
        day,
      }
    }
  }

  return null
}

function inferTimelineDate(currentRelative: string, content: string, modifiedAt?: string): { year: number; month: number } | null {
  const fromPath = parseDateFromString(currentRelative)
  if (fromPath?.year && fromPath.month) {
    return { year: fromPath.year, month: fromPath.month }
  }

  const fromContent = parseDateFromString(content)
  if (fromContent?.month) {
    if (fromContent.year) {
      return { year: fromContent.year, month: fromContent.month }
    }
    if (modifiedAt) {
      const modifiedDate = new Date(modifiedAt)
      if (!Number.isNaN(modifiedDate.getTime())) {
        return {
          year: modifiedDate.getUTCFullYear(),
          month: fromContent.month,
        }
      }
    }
  }

  if (modifiedAt) {
    const modifiedDate = new Date(modifiedAt)
    if (!Number.isNaN(modifiedDate.getTime())) {
      return {
        year: modifiedDate.getUTCFullYear(),
        month: modifiedDate.getUTCMonth() + 1,
      }
    }
  }

  return null
}

function deriveTypeRelative(currentRelative: string, suggestedRelative: string, content: string): StrategyApplicationResult {
  const folder = suggestFolderFromNamingPlan(content, currentRelative)
  const targetFileName = normalizeFileName(fileNameFromRelative(suggestedRelative), currentRelative)
  const parent = folder.subcategory ? [folder.category, folder.subcategory] : [folder.category]
  return {
    targetRelative: buildRelative(parent, targetFileName),
    rationale: 'type-based grouping',
  }
}

function deriveTimelineRelative(currentRelative: string, suggestedRelative: string, content: string, modifiedAt?: string): StrategyApplicationResult {
  const targetFileName = normalizeFileName(fileNameFromRelative(suggestedRelative), currentRelative)
  const date = inferTimelineDate(currentRelative, content, modifiedAt)
  if (!date) {
    return {
      targetRelative: suggestedRelative,
      rationale: 'timeline grouping unavailable, kept semantic path',
    }
  }

  return {
    targetRelative: buildRelative(['Timeline', String(date.year), monthLabel(date.month)], targetFileName),
    rationale: 'timeline grouping',
  }
}

function deriveProjectRelative(currentRelative: string, suggestedRelative: string): StrategyApplicationResult {
  if (looksUncategorized(currentRelative)) {
    return {
      targetRelative: suggestedRelative,
      rationale: 'uncategorized note still uses semantic/project suggestion',
    }
  }

  const currentParts = currentRelative.split('/').filter(Boolean)
  const targetParts = suggestedRelative.split('/').filter(Boolean)
  const targetFileName = normalizeFileName(fileNameFromRelative(suggestedRelative), currentRelative)
  if (currentParts.length <= 1) {
    return {
      targetRelative: suggestedRelative,
      rationale: 'no stable project anchor found',
    }
  }

  const currentTop = currentParts[0]
  const targetTop = targetParts[0]
  if (targetTop && currentTop.toLowerCase() === targetTop.toLowerCase()) {
    return {
      targetRelative: suggestedRelative,
      rationale: 'project-aligned semantic path',
    }
  }

  const anchor = currentParts.slice(0, Math.min(currentParts.length - 1, 2))
  const suggestedTailParent = targetParts.slice(1, -1).slice(-1)[0]
  const parent = [...anchor]
  if (suggestedTailParent && suggestedTailParent.toLowerCase() !== parent[parent.length - 1]?.toLowerCase()) {
    parent.push(suggestedTailParent)
  }

  return {
    targetRelative: buildRelative(parent, targetFileName),
    rationale: 'kept within current project/workstream',
  }
}

function taxonomyAccepts(relative: string, taxonomy: StrategyTaxonomyProfile): boolean {
  const top = relative.split('/').filter(Boolean)[0]?.toLowerCase()
  if (!top || taxonomy.topLevels.size === 0) return true
  if (top === 'timeline') return true
  return taxonomy.topLevels.has(top)
}

export function applyReorganizationStrategy(input: ApplyReorganizationStrategyInput): StrategyApplicationResult {
  const suggestedRelative = input.suggestedRelative || input.currentRelative
  if (input.strategy === 'meaning') {
    return {
      targetRelative: suggestedRelative,
      rationale: 'meaning-based organization',
    }
  }

  let result: StrategyApplicationResult

  switch (input.strategy) {
    case 'type':
      result = deriveTypeRelative(input.currentRelative, suggestedRelative, input.content)
      break
    case 'timeline':
      result = deriveTimelineRelative(input.currentRelative, suggestedRelative, input.content, input.modifiedAt)
      break
    case 'project':
      result = deriveProjectRelative(input.currentRelative, suggestedRelative)
      break
    default:
      result = { targetRelative: suggestedRelative }
      break
  }

  if (!taxonomyAccepts(result.targetRelative, input.taxonomy)) {
    return {
      targetRelative: suggestedRelative,
      rationale: `${result.rationale || 'strategy result'} fell outside vault taxonomy, kept semantic path`,
    }
  }

  const plan = summarizeContentForNaming(input.content, input.currentRelative)
  const normalizedFileName = normalizeFileName(fileNameFromRelative(result.targetRelative), input.currentRelative)
  const parent = result.targetRelative.split('/').filter(Boolean).slice(0, -1)
  if (parent.length === 0) {
    return {
      targetRelative: buildRelative(['Unsorted'], `${plan.title}${pathExtension(input.currentRelative)}`),
      rationale: result.rationale,
    }
  }

  return {
    targetRelative: buildRelative(parent, normalizedFileName),
    rationale: result.rationale,
  }
}
