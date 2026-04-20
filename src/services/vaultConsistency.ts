import { factsService } from './facts'
import { relatedNotesService } from './relatedNotes'
import { vaultService } from './vault'
import { normalizeNotePath, isIndexableNotePath } from '../utils/noteScope'

export type BrokenReferenceKind = 'wiki' | 'markdown'
export type BrokenReferenceReason = 'missing' | 'ambiguous'

export interface BrokenReferenceItem {
  path: string
  target: string
  kind: BrokenReferenceKind
  reason: BrokenReferenceReason
  candidates: string[]
}

export interface VaultConsistencyReport {
  validNoteCount: number
  orphanEmbeddings: string[]
  removedOrphanEmbeddings: number
  prunedFacts: number
  prunedRelatedRecords: number
  prunedRelatedEdges: number
  brokenReferences: BrokenReferenceItem[]
  repairedReferences: number
}

interface ConsistencyService {
  scan: () => Promise<VaultConsistencyReport>
  repair: (onProgress?: (current: number, total: number) => void) => Promise<VaultConsistencyReport>
}

function extractFilePaths(nodes: Awaited<ReturnType<typeof vaultService.getVaultTree>>): string[] {
  const result: string[] = []
  const walk = (items: Awaited<ReturnType<typeof vaultService.getVaultTree>>) => {
    for (const node of items) {
      if (node.type === 'file') {
        result.push(normalizeNotePath(node.path))
      } else {
        walk(node.children)
      }
    }
  }
  walk(nodes)
  return result
}

function fileTitle(path: string): string {
  return normalizeNotePath(path).split('/').pop()?.replace(/\.[^.]+$/i, '').toLowerCase() || normalizeNotePath(path).toLowerCase()
}

function normalizeLinkTarget(rawTarget: string): string {
  return normalizeNotePath(rawTarget).replace(/^\.\//, '').trim()
}

function buildPathIndex(paths: string[]): {
  exact: Map<string, string>
  byTitle: Map<string, string[]>
} {
  const exact = new Map<string, string>()
  const byTitle = new Map<string, string[]>()
  for (const path of paths) {
    const normalized = normalizeNotePath(path)
    exact.set(normalized.toLowerCase(), normalized)
    const title = fileTitle(normalized)
    byTitle.set(title, [...(byTitle.get(title) || []), normalized])
  }
  return { exact, byTitle }
}

function collectCandidateKeys(normalized: string): string[] {
  const stem = normalized.replace(/\.[^.]+$/i, '')
  return [
    normalized,
    stem,
    `${stem}.md`,
    `${stem}.markdown`,
    `${stem}.txt`,
    `${stem}.mdx`,
    `${stem}.pdf`,
    `${stem}.docx`,
    `${stem}.pptx`,
    `${stem}.xlsx`,
    `${stem}.csv`,
    `${stem}.doc`,
    `${stem}.png`,
    `${stem}.jpg`,
    `${stem}.jpeg`,
    `${stem}.svg`,
    `${stem}.webp`,
  ]
}

function resolveReferenceTarget(rawTarget: string, pathIndex: ReturnType<typeof buildPathIndex>): { resolved: string | null; reason: 'exact' | 'title' | BrokenReferenceReason; candidates: string[] } {
  const normalized = normalizeLinkTarget(rawTarget)
  if (!normalized) {
    return { resolved: null, reason: 'missing', candidates: [] }
  }

  for (const candidate of collectCandidateKeys(normalized)) {
    const exact = pathIndex.exact.get(candidate.toLowerCase())
    if (exact) return { resolved: exact, reason: 'exact', candidates: [exact] }
  }

  const title = fileTitle(normalized)
  const titleMatches = pathIndex.byTitle.get(title) || []
  if (titleMatches.length === 1) {
    return { resolved: titleMatches[0], reason: 'title', candidates: titleMatches }
  }
  if (titleMatches.length > 1) {
    return { resolved: null, reason: 'ambiguous', candidates: titleMatches.slice(0, 8) }
  }
  return { resolved: null, reason: 'missing', candidates: [] }
}

function buildRelativeTargetPath(sourcePath: string, targetPath: string): string {
  const sourceSegments = normalizeNotePath(sourcePath).split('/').filter(Boolean)
  const targetSegments = normalizeNotePath(targetPath).split('/').filter(Boolean)
  sourceSegments.pop()

  let shared = 0
  while (shared < sourceSegments.length && shared < targetSegments.length && sourceSegments[shared] === targetSegments[shared]) {
    shared += 1
  }

  const up = sourceSegments.slice(shared).map(() => '..')
  const down = targetSegments.slice(shared)
  return [...up, ...down].join('/') || targetSegments[targetSegments.length - 1] || targetPath
}

async function collectBrokenReferences(notePaths: string[], allPaths: string[]): Promise<BrokenReferenceItem[]> {
  const pathIndex = buildPathIndex(allPaths)
  const broken: BrokenReferenceItem[] = []

  for (const path of notePaths) {
    let content = ''
    try {
      content = await vaultService.readFile(path)
    } catch {
      continue
    }

    const wikiLinkRegex = /\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g
    let wikiMatch: RegExpExecArray | null
    while ((wikiMatch = wikiLinkRegex.exec(content)) !== null) {
      const rawTarget = (wikiMatch[1] || '').trim()
      if (!rawTarget) continue
      const resolution = resolveReferenceTarget(rawTarget, pathIndex)
      if (!resolution.resolved) {
        broken.push({
          path,
          target: rawTarget,
          kind: 'wiki',
          reason: normalizeBrokenReason(resolution.reason),
          candidates: resolution.candidates,
        })
      }
    }

    const markdownLinkRegex = /(!?\[[^\]]*\])\(([^)]+)\)/g
    let markdownMatch: RegExpExecArray | null
    while ((markdownMatch = markdownLinkRegex.exec(content)) !== null) {
      const rawTarget = (markdownMatch[2] || '').trim()
      if (!rawTarget || /^https?:\/\//i.test(rawTarget) || rawTarget.startsWith('#')) continue
      const resolution = resolveReferenceTarget(rawTarget, pathIndex)
      if (!resolution.resolved) {
        broken.push({
          path,
          target: rawTarget,
          kind: 'markdown',
          reason: normalizeBrokenReason(resolution.reason),
          candidates: resolution.candidates,
        })
      }
    }
  }

  return broken
}

async function repairReferences(notePaths: string[], allPaths: string[], onProgress?: (current: number, total: number) => void): Promise<number> {
  const pathIndex = buildPathIndex(allPaths)
  let repaired = 0
  let processed = 0

  for (const path of notePaths) {
    let content = ''
    try {
      content = await vaultService.readFile(path)
    } catch {
      processed += 1
      onProgress?.(processed, notePaths.length)
      continue
    }

    let changed = false

    const nextWiki = content.replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (full, rawTarget: string, alias?: string) => {
      const resolution = resolveReferenceTarget((rawTarget || '').trim(), pathIndex)
      if (!resolution.resolved || resolution.reason !== 'title') return full
      changed = true
      repaired += 1
      return alias?.trim()
        ? `[[${resolution.resolved}|${alias.trim()}]]`
        : `[[${resolution.resolved}]]`
    })

    const nextContent = nextWiki.replace(/(!?\[[^\]]*\])\(([^)]+)\)/g, (full, label: string, rawTarget: string) => {
      const trimmed = (rawTarget || '').trim()
      if (!trimmed || /^https?:\/\//i.test(trimmed) || trimmed.startsWith('#')) return full
      const resolution = resolveReferenceTarget(trimmed, pathIndex)
      if (!resolution.resolved || resolution.reason !== 'title') return full
      changed = true
      repaired += 1
      return `${label}(${buildRelativeTargetPath(path, resolution.resolved)})`
    })

    if (changed && nextContent !== content) {
      await vaultService.writeFile(path, nextContent)
    }

    processed += 1
    onProgress?.(processed, notePaths.length)
  }

  return repaired
}

export const vaultConsistencyService: ConsistencyService = {
  async scan(): Promise<VaultConsistencyReport> {
    const [tree, allEmbeddings] = await Promise.all([
      vaultService.getVaultTree({ forceRefresh: true }),
      vaultService.readAllEmbeddings({ forceRefresh: true }),
    ])
    const allPaths = extractFilePaths(tree)
    const notePaths = allPaths.filter((path) => isIndexableNotePath(path))
    const validPathSet = new Set(notePaths.map((path) => normalizeNotePath(path)))
    const orphanEmbeddings = Array.from(
      new Set(
        allEmbeddings
          .map((entry) => normalizeNotePath(entry.path))
          .filter((path) => isIndexableNotePath(path))
          .filter((path) => !validPathSet.has(path)),
      ),
    ).sort()

    const brokenReferences = await collectBrokenReferences(notePaths, allPaths)

    return {
      validNoteCount: notePaths.length,
      orphanEmbeddings,
      removedOrphanEmbeddings: 0,
      prunedFacts: 0,
      prunedRelatedRecords: 0,
      prunedRelatedEdges: 0,
      brokenReferences,
      repairedReferences: 0,
    }
  },

  async repair(onProgress?: (current: number, total: number) => void): Promise<VaultConsistencyReport> {
    const initial = await this.scan()
    let step = 0
    const totalSteps = Math.max(1, initial.validNoteCount + 3)
    const advance = (increment = 1) => {
      step += increment
      onProgress?.(Math.min(step, totalSteps), totalSteps)
    }

    let removedOrphanEmbeddings = 0
    for (const path of initial.orphanEmbeddings) {
      try {
        const deleted = await vaultService.deleteEmbedding(path)
        if (deleted) removedOrphanEmbeddings += 1
      } catch {
        // Best-effort cleanup only.
      }
      advance()
    }

    const tree = await vaultService.getVaultTree({ forceRefresh: true })
    const allPaths = extractFilePaths(tree)
    const notePaths = allPaths.filter((path) => isIndexableNotePath(path))

    const [prunedFacts, relatedRepair, repairedReferences] = await Promise.all([
      factsService.pruneMissingNotes(notePaths),
      relatedNotesService.repairAgainstPaths(notePaths),
      repairReferences(notePaths, allPaths),
    ])

    advance(notePaths.length + 3)
    const rescanned = await this.scan()
    return {
      ...rescanned,
      removedOrphanEmbeddings,
      prunedFacts,
      prunedRelatedRecords: relatedRepair.removedRecords,
      prunedRelatedEdges: relatedRepair.removedEdges,
      repairedReferences,
    }
  },
}
function normalizeBrokenReason(reason: 'exact' | 'title' | BrokenReferenceReason): BrokenReferenceReason {
  return reason === 'ambiguous' ? 'ambiguous' : 'missing'
}
