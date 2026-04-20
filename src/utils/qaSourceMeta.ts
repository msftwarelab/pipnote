export type QASourceContextKind = 'ocr-image' | 'standard'

function getSourceExtension(path: string): string {
  const fileName = path.split('/').pop() || path
  const parts = fileName.split('.')
  return parts.length > 1 ? parts[parts.length - 1].toLowerCase() : ''
}

export function getSourceKindMeta(path: string, contextKind: QASourceContextKind = 'standard'): { label: string; tone: string } {
  const extension = getSourceExtension(path)
  if (contextKind === 'ocr-image' && ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'heic'].includes(extension)) {
    return {
      label: 'OCR image source',
      tone: 'bg-cyan-100 text-cyan-800 dark:bg-cyan-900/30 dark:text-cyan-200',
    }
  }
  if (extension === 'pdf') {
    return {
      label: 'PDF document',
      tone: 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300',
    }
  }
  if (extension === 'docx') {
    return {
      label: 'DOCX document',
      tone: 'bg-sky-100 text-sky-700 dark:bg-sky-900/30 dark:text-sky-300',
    }
  }
  if (extension === 'pptx') {
    return {
      label: 'PPTX presentation',
      tone: 'bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-300',
    }
  }
  if (extension === 'xlsx') {
    return {
      label: 'XLSX spreadsheet',
      tone: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300',
    }
  }
  if (extension === 'csv') {
    return {
      label: 'CSV data file',
      tone: 'bg-teal-100 text-teal-700 dark:bg-teal-900/30 dark:text-teal-300',
    }
  }
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'heic'].includes(extension)) {
    return {
      label: 'Image file',
      tone: 'bg-slate-200 text-slate-700 dark:bg-slate-700 dark:text-slate-200',
    }
  }
  return {
    label: 'Note file',
    tone: 'bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300',
  }
}
