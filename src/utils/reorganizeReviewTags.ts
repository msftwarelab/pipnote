import type { ReorganizationOperationReviewContext } from '../services/reorganize'

export interface ReorgReviewTag {
  label: string
  className: string
}

export function getReorgTrustTags(
  reason: string,
  reviewContext?: ReorganizationOperationReviewContext,
): ReorgReviewTag[] {
  const lower = reason.toLowerCase()
  const tags: ReorgReviewTag[] = []
  const supportsExtractionBadges = !!reviewContext?.aiReadableKind
    && ['pdf', 'docx', 'pptx', 'xlsx', 'csv'].includes(reviewContext.aiReadableKind)
  const isVisualAsset = reviewContext?.aiReadableKind === 'image'
  const isVisualOcr = isVisualAsset && reviewContext?.visualAnalysisMode === 'ocr'
  const isVisualPathOnly = isVisualAsset && reviewContext?.visualAnalysisMode !== 'ocr'

  if (lower.includes('root or uncategorized note') || lower.includes('auto-fix uncategorized path')) {
    tags.push({
      label: 'Uncategorized Fix',
      className: 'bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-200',
    })
  }

  if (lower.includes('matches existing vault category structure')) {
    tags.push({
      label: 'Vault Pattern',
      className: 'bg-sky-100 text-sky-800 dark:bg-sky-900/30 dark:text-sky-200',
    })
  }

  if (lower.includes('target folder approved') || lower.includes('similar approved note patterns') || lower.includes('similar top-level move approved')) {
    tags.push({
      label: 'Learned From Approvals',
      className: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-200',
    })
  }

  if (lower.includes('low-confidence refinement')) {
    tags.push({
      label: 'Low Confidence',
      className: 'bg-slate-200 text-slate-700 dark:bg-slate-700 dark:text-slate-200',
    })
  }

  if (reviewContext?.validationPassed) {
    tags.push({
      label: reviewContext.validationKind === 'duplicate'
        ? 'Validated Duplicate'
        : reviewContext.validationKind === 'review'
          ? 'Validated Review'
          : 'Validated Move',
      className: 'bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-200',
    })
  }

  if (lower.includes('cleaner canonical file')) {
    tags.push({
      label: 'Cleaner Canonical File',
      className: 'bg-violet-100 text-violet-800 dark:bg-violet-900/30 dark:text-violet-200',
    })
  } else if (lower.includes('better organized file')) {
    tags.push({
      label: 'Better Organized File',
      className: 'bg-indigo-100 text-indigo-800 dark:bg-indigo-900/30 dark:text-indigo-200',
    })
  } else if (lower.includes('newer copy')) {
    tags.push({
      label: 'Newer Copy',
      className: 'bg-cyan-100 text-cyan-800 dark:bg-cyan-900/30 dark:text-cyan-200',
    })
  } else if (lower.includes('final version')) {
    tags.push({
      label: 'Final Version',
      className: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-200',
    })
  } else if (lower.includes('non-draft file')) {
    tags.push({
      label: 'Non-Draft File',
      className: 'bg-lime-100 text-lime-800 dark:bg-lime-900/30 dark:text-lime-200',
    })
  } else if (lower.includes('superseded by')) {
    tags.push({
      label: 'Superseded Version',
      className: 'bg-rose-100 text-rose-800 dark:bg-rose-900/30 dark:text-rose-200',
    })
  }

  if (lower.includes('flatten noisy copy/export container') || lower.includes('shallow clutter folder')) {
    tags.push({
      label: 'Clutter Cleanup',
      className: 'bg-orange-100 text-orange-800 dark:bg-orange-900/30 dark:text-orange-200',
    })
  }

  if (supportsExtractionBadges && reviewContext?.extractionQuality === 'low') {
    tags.push({
      label: 'Weak Extraction',
      className: 'bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-200',
    })
  } else if (supportsExtractionBadges && reviewContext?.extractionQuality === 'medium') {
    tags.push({
      label: 'Limited Extraction',
      className: 'bg-orange-100 text-orange-800 dark:bg-orange-900/30 dark:text-orange-200',
    })
  }

  if (isVisualAsset) {
    tags.push({
      label: 'Visual Asset',
      className: 'bg-cyan-100 text-cyan-800 dark:bg-cyan-900/30 dark:text-cyan-200',
    })
    if (reviewContext?.visualKind === 'scan') {
      tags.push({
        label: 'Scanned Doc',
        className: 'bg-teal-100 text-teal-800 dark:bg-teal-900/30 dark:text-teal-200',
      })
    } else if (reviewContext?.visualKind === 'screenshot') {
      tags.push({
        label: 'Screenshot',
        className: 'bg-sky-100 text-sky-800 dark:bg-sky-900/30 dark:text-sky-200',
      })
    } else if (reviewContext?.visualKind === 'diagram') {
      tags.push({
        label: 'Diagram',
        className: 'bg-indigo-100 text-indigo-800 dark:bg-indigo-900/30 dark:text-indigo-200',
      })
    } else if (reviewContext?.visualKind === 'photo') {
      tags.push({
        label: 'Photo',
        className: 'bg-fuchsia-100 text-fuchsia-800 dark:bg-fuchsia-900/30 dark:text-fuchsia-200',
      })
    }
    if (isVisualOcr) {
      tags.push({
        label: reviewContext?.extractionQuality === 'low' ? 'Weak OCR' : 'OCR Read',
        className: reviewContext?.extractionQuality === 'low'
          ? 'bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-200'
          : 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-200',
      })
    }
    if (isVisualPathOnly && reviewContext?.conservativeReorganization) {
      tags.push({
        label: 'Path-Based',
        className: 'bg-slate-200 text-slate-700 dark:bg-slate-700 dark:text-slate-200',
      })
    }
  }

  return tags.slice(0, 4)
}

export function getReorgReviewHint(
  reviewContext?: ReorganizationOperationReviewContext,
): string | null {
  if (!reviewContext) return null
  if (reviewContext.aiReadableKind === 'image') {
    const visualLabel = reviewContext.visualKind === 'scan'
      ? 'scanned image'
      : reviewContext.visualKind === 'screenshot'
        ? 'screenshot'
        : reviewContext.visualKind === 'diagram'
          ? 'diagram'
          : reviewContext.visualKind === 'photo'
            ? 'photo'
            : 'image'
    const qualityReason = reviewContext.qualityReason?.trim()
    if (reviewContext.visualAnalysisMode === 'ocr') {
      if (reviewContext.extractionQuality === 'low') {
        if (qualityReason) {
          return `Pipnote used local OCR on this ${visualLabel}, but the extracted text was weak or noisy: ${qualityReason}.`
        }
        return `Pipnote used local OCR on this ${visualLabel}, but the extracted text was weak or noisy.`
      }
      if (qualityReason) {
        return `Pipnote used local OCR text from this ${visualLabel} to guide the suggestion: ${qualityReason}.`
      }
      return `Pipnote used local OCR text from this ${visualLabel} to guide the suggestion.`
    }

    if (qualityReason) {
      return `Pipnote treated this ${visualLabel} conservatively using filename and folder clues because OCR is not enabled yet: ${qualityReason}.`
    }
    return `Pipnote treated this ${visualLabel} conservatively using filename and folder clues because OCR is not enabled yet.`
  }

  if (!reviewContext.aiReadableKind || !['pdf', 'docx', 'pptx', 'xlsx', 'csv'].includes(reviewContext.aiReadableKind)) {
    return null
  }

  const qualityReason = reviewContext.qualityReason?.trim()
  if (reviewContext.extractionQuality === 'low') {
    if (qualityReason) {
      return `Pipnote stayed conservative because extracted ${reviewContext.aiReadableKind?.toUpperCase() || 'document'} text was weak or noisy: ${qualityReason}.`
    }
    return 'Pipnote stayed conservative because this document had weak or noisy extracted text.'
  }

  if (reviewContext.extractionQuality === 'medium') {
    if (qualityReason) {
      return `Pipnote softened this suggestion because extracted ${reviewContext.aiReadableKind?.toUpperCase() || 'document'} text was usable but limited: ${qualityReason}.`
    }
    return 'Pipnote softened this suggestion because the extracted document text was usable but limited.'
  }

  return null
}
