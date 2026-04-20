import type { KeywordSearchHit } from '../services/vault'

export interface KeywordSearchExplanation {
  summary: string
  tags: string[]
}

interface KeywordSearchExplanationInput {
  hit: KeywordSearchHit
  queryTokens: string[]
  titleMatches: number
  pathMatches: number
  snippetMatches: number
  exactTitle: boolean
  titleStartsWith: boolean
}

export function buildKeywordSearchExplanation(input: KeywordSearchExplanationInput): KeywordSearchExplanation {
  const { hit, queryTokens, titleMatches, pathMatches, snippetMatches, exactTitle, titleStartsWith } = input
  const tags: string[] = []

  if (exactTitle) tags.push('Exact title')
  else if (titleStartsWith) tags.push('Title starts with query')
  else if (titleMatches > 0) tags.push('Title match')

  if (pathMatches > 0) tags.push('Path match')
  if (snippetMatches > 0) tags.push('Content match')

  const matchedTerms = queryTokens.filter((token) => {
    const lower = `${hit.title} ${hit.path} ${hit.snippet}`.toLowerCase()
    return lower.includes(token)
  }).slice(0, 3)

  if (exactTitle) {
    return {
      summary: 'Exact title match for your query.',
      tags,
    }
  }

  if (titleStartsWith) {
    return {
      summary: 'Title starts with your query, which is usually a strong direct lookup signal.',
      tags,
    }
  }

  if (titleMatches > 0 && snippetMatches > 0) {
    return {
      summary: matchedTerms.length > 0
        ? `Matched in both the note title and content for ${matchedTerms.map((term) => `"${term}"`).join(', ')}.`
        : 'Matched in both the note title and content.',
      tags,
    }
  }

  if (titleMatches > 0 || pathMatches > 0) {
    return {
      summary: matchedTerms.length > 0
        ? `Strong direct match in the note title or folder path for ${matchedTerms.map((term) => `"${term}"`).join(', ')}.`
        : 'Strong direct match in the note title or folder path.',
      tags,
    }
  }

  return {
    summary: matchedTerms.length > 0
      ? `Matched the note content for ${matchedTerms.map((term) => `"${term}"`).join(', ')}.`
      : 'Matched the note content.',
    tags,
  }
}
