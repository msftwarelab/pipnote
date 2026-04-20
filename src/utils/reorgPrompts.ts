import type { FileIntelligence } from './fileIntelligence.ts'
import type { NamingPlan } from './titleNaming.ts'

function preferredDestination(fileContext?: FileIntelligence): string {
  if (!fileContext) return ''
  return `${fileContext.preferredCategory}${fileContext.preferredSubcategory ? `/${fileContext.preferredSubcategory}` : ''}`
}

function roleSpecificInstructions(fileContext?: FileIntelligence): string[] {
  if (!fileContext) {
    return [
      'Prefer stable existing categories over clever new folder invention.',
      'Only suggest duplicates when the source clearly overlaps with an existing note path.',
    ]
  }

  switch (fileContext.fileRole) {
    case 'contract':
    case 'offer':
    case 'statement':
      return [
        'Treat this as a formal legal or official document.',
        'Prefer stable professional document folders over broad creative categories.',
        'Avoid duplicate claims unless the duplicate target is explicit and very credible.',
      ]
    case 'resume':
    case 'interview':
      return [
        'Treat this as career-oriented material.',
        'Prefer Career or interview-prep structures over generic work folders.',
        'Keep titles concise, professional, and searchable.',
      ]
    case 'prompt':
      return [
        'Treat this as a reusable prompt or template asset.',
        'Prefer resource-library style folders and avoid burying it inside unrelated project folders.',
        'Do not classify instruction text as a meeting note or transcript.',
      ]
    case 'presentation':
    case 'spreadsheet':
      return [
        'Treat this as a structured office artifact.',
        'Prefer reporting, finance, presentation, or operations folders that match the document role.',
        'Be careful not to move it across top-level areas unless the fit is clearly stronger.',
      ]
    case 'profile':
    case 'proposal':
    case 'guide':
    case 'general-document':
      return [
        'Treat this as a formal document rather than a casual note.',
        'Prefer document-oriented folders and keep naming professional.',
      ]
    case 'image':
      return [
        'Treat this as a visual asset.',
        'If OCR quality is weak, rely mostly on filename and folder context and stay conservative.',
        'Do not invent detailed semantic meaning beyond what the OCR or path strongly supports.',
      ]
    case 'text-note':
    default:
      return [
        'Treat this as a note.',
        'Prefer note-oriented organization and preserve existing structure unless the new folder is clearly better.',
      ]
  }
}

export function buildReorganizationAnalysisPrompt(input: {
  currentPath: string
  content: string
  namingPlan: NamingPlan
  fileContext?: FileIntelligence
}): string {
  const { currentPath, content, namingPlan, fileContext } = input
  const destination = preferredDestination(fileContext)
  const fileContextBlock = fileContext
    ? `
File intelligence:
- Kind: ${fileContext.kind}
- File role: ${fileContext.fileRole}
- Extraction quality: ${fileContext.extractionQuality}
- Quality reason: ${fileContext.qualityReason}
- Preferred category: ${destination}
- Preferred title style: ${fileContext.preferredTitle}
- Guidance: ${fileContext.promptContext}
`
    : ''

  const extraRules = roleSpecificInstructions(fileContext)
    .map((rule) => `- ${rule}`)
    .join('\n')

  return `Analyze this vault item for reorganization. Decide whether to keep it, rename it, move it, or flag it as a true duplicate.

Current Path: ${currentPath}
Content: ${content.substring(0, 1500)}

Semantic naming summary:
- Document style: ${namingPlan.kind}
- Short summary: ${namingPlan.summary}
- Preferred professional title style: ${namingPlan.title}
${fileContextBlock}

Respond ONLY with JSON:
{
  "shouldKeep": true,
  "suggestedPath": "FolderName/Subfolder/Title",
  "suggestedTitle": "Better Title",
  "isDuplicate": false,
  "duplicateOf": "Other/Note/Path",
  "reason": "Why this organization makes sense"
}

Rules:
- suggestedPath must be relative to the vault root with no leading "notes/" and no extension.
- suggestedPath must contain at least two segments: Category/FileName.
- suggestedTitle must be concise, professional, and searchable.
- If isDuplicate is false, duplicateOf must be an empty string.
- Keep output valid JSON with double quotes and no prose outside the JSON object.
- If the current file is at vault root or under a generic folder, prefer a clear destination.
- If extraction quality is low, be conservative and keep the current folder unless the new folder is clearly better.
${extraRules}`
}

export function buildReorganizationRetryPrompt(input: {
  currentPath: string
  content: string
  namingPlan: NamingPlan
  fileContext?: FileIntelligence
}): string {
  const { currentPath, content, namingPlan, fileContext } = input
  const destination = preferredDestination(fileContext)
  const duplicateRule = fileContext?.fileRole === 'image'
    ? 'Do not mark as duplicate unless the duplicate target is explicit in the path.'
    : 'Only mark as duplicate when you have a strong explicit duplicate target.'

  return `Return ONLY valid JSON, no markdown, no prose.
Path: ${currentPath}
Content preview: ${content.substring(0, 700)}
Preferred destination: ${destination || 'infer from the content carefully'}
Preferred title style: ${namingPlan.title}
${duplicateRule}
Schema:
{"shouldKeep":true,"suggestedPath":"Category/Title","suggestedTitle":"Title","isDuplicate":false,"duplicateOf":"","reason":"short reason"}`
}
