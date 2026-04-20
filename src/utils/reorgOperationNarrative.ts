import type { ReorganizationOperation } from '../services/reorganize'

export interface ReorgOperationNarrative {
  title: string
  bullets: string[]
}

function targetDisplay(targetPath?: string): string {
  return targetPath?.replace(/^notes\//i, '') || 'another file'
}

export function buildReorgOperationNarrative(op: ReorganizationOperation): ReorgOperationNarrative | null {
  const lower = op.reason.toLowerCase()

  if (op.type === 'merge') {
    const bullets: string[] = []
    if (lower.includes('cleaner canonical file')) {
      bullets.push(`Pipnote prefers keeping the cleaner canonical file at ${targetDisplay(op.targetPath)}.`)
    }
    if (lower.includes('newer copy')) {
      bullets.push(`Pipnote prefers the newer copy at ${targetDisplay(op.targetPath)}.`)
    }
    if (lower.includes('final version')) {
      bullets.push(`Pipnote prefers the final version over the draft-like version here.`)
    }
    if (lower.includes('non-draft file')) {
      bullets.push(`Pipnote prefers the non-draft file over the draft variant.`)
    }
    if (lower.includes('superseded by')) {
      bullets.push(`This file appears to be superseded by ${targetDisplay(op.targetPath)}.`)
    }
    if (bullets.length === 0) {
      bullets.push(`Pipnote found strong overlap with ${targetDisplay(op.targetPath)} and thinks these should be merged or consolidated.`)
    }
    return {
      title: 'Why keep the other file',
      bullets,
    }
  }

  if (op.type === 'move' && op.targetPath?.startsWith('Review/')) {
    const bullets: string[] = []
    if (/\b(unreadable|unsupported|failed|corrupt|broken)\b/i.test(op.reason)) {
      bullets.push('Pipnote found a real quality problem and wants this reviewed manually.')
    }
    if (/\b(empty|blank)\b/i.test(op.reason)) {
      bullets.push('The file looks empty or effectively blank, so Pipnote does not trust an automatic placement.')
    }
    if (/\b(junk|garbage|temporary|temp)\b/i.test(op.reason)) {
      bullets.push('The file looks like low-value clutter and may need manual cleanup.')
    }
    if (bullets.length === 0) {
      bullets.push('Pipnote found enough risk to avoid auto-organizing this file and wants a manual check instead.')
    }
    return {
      title: 'Why this needs review',
      bullets,
    }
  }

  return null
}
