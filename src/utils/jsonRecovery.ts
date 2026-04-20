function normalizeSmartQuotes(input: string): string {
  return input
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
}

function stripTrailingCommas(input: string): string {
  return input.replace(/,\s*([}\]])/g, '$1')
}

function stripJsonComments(input: string): string {
  return input
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
}

function stripTrailingSemicolons(input: string): string {
  return input.replace(/;\s*$/, '')
}

function convertSingleQuotedJson(input: string): string {
  return input
    .replace(/([{,]\s*)'([^']+?)'\s*:/g, '$1"$2":')
    .replace(/:\s*'([^'\\]*(?:\\.[^'\\]*)*)'/g, ': "$1"')
}

function quoteBareKeys(input: string): string {
  return input.replace(/([{,]\s*)([A-Za-z_][A-Za-z0-9_-]*)(\s*:)/g, '$1"$2"$3')
}

function collectRawCandidates(raw: string): string[] {
  const candidates: string[] = [raw.trim()]

  const codeBlockMatch = raw.match(/```(?:json)?\s*([\s\S]*?)\s*```/i)
  if (codeBlockMatch?.[1]) {
    candidates.push(codeBlockMatch[1].trim())
  }

  const jsonMatch = raw.match(/\{[\s\S]*\}/)
  if (jsonMatch?.[0]) {
    candidates.push(jsonMatch[0].trim())
  }

  return Array.from(new Set(candidates.filter((value) => value.length > 0)))
}

function parseCandidateObject(candidate: string): Record<string, unknown> | null {
  const trimmed = candidate.trim()
  const queue = Array.from(new Set([
    trimmed,
    normalizeSmartQuotes(trimmed),
    stripTrailingCommas(trimmed),
    stripJsonComments(trimmed),
    stripTrailingSemicolons(trimmed),
    convertSingleQuotedJson(trimmed),
    quoteBareKeys(trimmed),
    stripTrailingCommas(convertSingleQuotedJson(normalizeSmartQuotes(trimmed))),
    stripTrailingCommas(quoteBareKeys(stripJsonComments(normalizeSmartQuotes(trimmed)))),
    stripTrailingSemicolons(stripTrailingCommas(quoteBareKeys(convertSingleQuotedJson(stripJsonComments(normalizeSmartQuotes(trimmed)))))),
  ]))

  for (const attempt of queue) {
    if (!attempt) continue
    try {
      const parsed = JSON.parse(attempt) as unknown
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>
      }
      if (typeof parsed === 'string') {
        const nested = parseCandidateObject(parsed)
        if (nested) return nested
      }
    } catch {
      // Continue trying with next transformation.
    }
  }
  return null
}

export function extractLooseJsonObject<T>(raw: unknown): T | null {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    return raw as T
  }
  if (typeof raw !== 'string' || !raw.trim()) {
    return null
  }

  const candidates = collectRawCandidates(raw)
  for (const candidate of candidates) {
    const parsed = parseCandidateObject(candidate)
    if (parsed) return parsed as T
  }
  return null
}
