export interface EmbeddingModelRecord {
  model: string
}

export function normalizeModelId(model: string): string {
  return model.trim().toLowerCase().replace(/@sha256:[a-f0-9]+$/i, '')
}

export function modelMatchesRequested(requestedModel: string, availableModel: string): boolean {
  const requested = normalizeModelId(requestedModel)
  const available = normalizeModelId(availableModel)
  if (!requested || !available) return false
  if (requested === available) return true
  if (!requested.includes(':')) {
    return available === requested || available.startsWith(`${requested}:`)
  }
  return available.startsWith(`${requested}:`)
}

export function pickAutoReembedTargets(
  candidatePaths: string[],
  latestByPath: Map<string, EmbeddingModelRecord>,
  selectedEmbeddingModel: string,
  maxCount: number,
): string[] {
  const uniquePaths = Array.from(new Set(candidatePaths.filter((path) => path.trim().length > 0)))
  const targets: string[] = []

  for (const path of uniquePaths) {
    if (targets.length >= Math.max(0, maxCount)) break
    const existing = latestByPath.get(path)
    if (!existing) {
      targets.push(path)
      continue
    }
    if (!modelMatchesRequested(selectedEmbeddingModel, existing.model || '')) {
      targets.push(path)
    }
  }

  return targets
}

export function collectStaleOrMissingPaths(
  allNotePaths: string[],
  latestByPath: Map<string, EmbeddingModelRecord>,
  selectedEmbeddingModel: string,
): string[] {
  const uniquePaths = Array.from(new Set(allNotePaths.filter((path) => path.trim().length > 0)))
  return uniquePaths.filter((path) => {
    const existing = latestByPath.get(path)
    if (!existing) return true
    return !modelMatchesRequested(selectedEmbeddingModel, existing.model || '')
  })
}
