import type { RelatedSignals, RelatedNoteSuggestion } from '../services/relatedNotes'

export interface RelatedExplanation {
  summary: string
  tags: string[]
}

function strongestSignal(signals: RelatedSignals): 'semantic' | 'entity' | 'keyword' | 'title' {
  const entries: Array<[keyof RelatedSignals, number]> = [
    ['semantic', signals.semantic],
    ['entity', signals.entity],
    ['keyword', signals.keyword],
    ['title', signals.title],
  ]
  entries.sort((a, b) => b[1] - a[1])
  return entries[0][0]
}

export function buildRelatedExplanation(item: RelatedNoteSuggestion): RelatedExplanation {
  const tags = Array.isArray(item.reasonTags) ? item.reasonTags.slice(0, 3) : []
  const strongest = strongestSignal(item.signals)

  if (tags.includes('same topic')) {
    return {
      summary: 'Very similar topic with strong semantic overlap.',
      tags,
    }
  }

  if (tags.includes('similar topic')) {
    return {
      summary: 'Similar topic with meaningful semantic overlap.',
      tags,
    }
  }

  if (tags.includes('shared person/topic')) {
    return {
      summary: item.reason || 'Shared named people, topics, or entities.',
      tags,
    }
  }

  if (tags.includes('shared keywords')) {
    return {
      summary: item.reason || 'Shared keywords across both notes.',
      tags,
    }
  }

  if (tags.includes('same folder') || tags.includes('same sub-area') || tags.includes('same area')) {
    return {
      summary: `Related mostly through nearby vault structure and ${strongest === 'semantic' ? 'topic overlap' : strongest === 'entity' ? 'shared references' : strongest === 'title' ? 'title overlap' : 'keyword overlap'}.`,
      tags,
    }
  }

  return {
    summary: item.reason || 'Related context detected.',
    tags,
  }
}
