export interface ReorgWhyThisFolder {
  currentFolder: string
  suggestedFolder: string
  evidence: string[]
  caution?: string
}

function folderOf(path: string): string {
  const parts = path.replace(/^notes\//i, '').split('/').filter(Boolean)
  return parts.slice(0, -1).join('/') || 'Vault root'
}

export function buildWhyThisFolder(sourcePath: string, targetPath: string, reason: string): ReorgWhyThisFolder {
  const lower = reason.toLowerCase()
  const evidence: string[] = []
  let caution: string | undefined

  if (lower.includes('root or uncategorized note') || lower.includes('auto-fix uncategorized path')) {
    evidence.push('Fixes a note that was still uncategorized or sitting in a generic location.')
  }

  if (lower.includes('matches existing vault category structure')) {
    evidence.push('Keeps the note inside a folder pattern that already exists in your vault.')
  }

  if (lower.includes('target folder approved') || lower.includes('similar approved note patterns') || lower.includes('similar top-level move approved')) {
    evidence.push('Matches folder choices you already approved for similar notes.')
  }

  if (lower.includes('target folder is a much stronger fit than the current location')) {
    evidence.push('The suggested folder is a much stronger semantic fit than the current location.')
  } else if (lower.includes('target folder is a better fit than the current location')) {
    evidence.push('The suggested folder fits this note better than the current location.')
  }

  if (lower.includes('low-confidence refinement')) {
    caution = 'This is a lighter-weight refinement, not one of Pipnote’s strongest move suggestions.'
  }

  if (evidence.length === 0) {
    evidence.push('Pipnote found a cleaner organization path based on the note content, title, and folder context.')
  }

  return {
    currentFolder: folderOf(sourcePath),
    suggestedFolder: folderOf(targetPath),
    evidence,
    caution,
  }
}
