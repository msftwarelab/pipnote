import type { AIReadableFileData } from '../services/vault'
import { analyzeAIReadableFile } from './fileIntelligence.ts'
import { isPotentiallyAIReadablePath, isVisualMediaPath, normalizeNotePath } from './noteScope.ts'

export function isRetrievalEligibleAIReadable(path: string, readable: AIReadableFileData): boolean {
  if (readable.kind !== 'image') return true
  const intel = analyzeAIReadableFile(path, readable)
  return intel.extractionQuality === 'high'
}

export function isPotentialRetrievalPath(path: string): boolean {
  return isPotentiallyAIReadablePath(normalizeNotePath(path))
}

export async function filterRetrievalEligiblePaths(
  paths: string[],
  readFileForAI: (path: string) => Promise<AIReadableFileData>,
  maxConcurrency = 3,
): Promise<string[]> {
  const normalized = Array.from(new Set(paths.map((path) => normalizeNotePath(path)).filter((path) => isPotentialRetrievalPath(path))))
  if (normalized.length === 0) return []

  const results = new Set<string>()
  const queue = [...normalized]
  const concurrency = Math.max(1, Math.min(maxConcurrency, queue.length))

  await Promise.all(Array.from({ length: concurrency }, async () => {
    while (queue.length > 0) {
      const next = queue.shift()
      if (!next) break
      if (!isVisualMediaPath(next)) {
        results.add(next)
        continue
      }
      try {
        const readable = await readFileForAI(next)
        if (isRetrievalEligibleAIReadable(next, readable)) {
          results.add(next)
        }
      } catch {
        // Ignore OCR-unreadable images here; they are intentionally excluded from retrieval.
      }
    }
  }))

  return normalized.filter((path) => results.has(path))
}
