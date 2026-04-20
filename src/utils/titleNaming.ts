const TITLE_FILLER_WORDS = new Set([
  'yeah', 'just', 'really', 'today', 'pretty', 'know', 'give', 'handle', 'worst',
  'easy', 'briefly', 'user', 'requirement', 'expert', 'note',
  'please', 'help', 'make', 'create', 'show', 'tell',
])

const GENERIC_PATH_WORDS = new Set([
  'notes', 'note', 'document', 'documents', 'file', 'files', 'copy', 'draft', 'final',
  'untitled', 'misc', 'general', 'docs', 'examples', 'downloads', 'desktop', 'folder',
  'pdf', 'doc', 'docx', 'ppt', 'pptx', 'xls', 'xlsx', 'csv', 'md', 'txt',
  'career', 'work', 'personal', 'projects', 'project', 'learning', 'resources', 'resource',
  'category', 'categories', 'job', 'jobs', 'jobsearch', 'search', 'interview', 'interviews',
  'prep', 'preparation', 'packet', 'paperwork',
])

const STOP_WORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for', 'of', 'with', 'by', 'from',
  'is', 'was', 'are', 'were', 'been', 'be', 'have', 'has', 'had', 'do', 'does', 'did', 'will',
  'would', 'could', 'should', 'can', 'may', 'might', 'must', 'shall', 'this', 'that', 'these',
  'those', 'here', 'there', 'when', 'where', 'why', 'how', 'what', 'which', 'who', 'whom',
  'my', 'your', 'his', 'her', 'its', 'our', 'their', 'am', 'if', 'then', 'so', 'as',
])

export type NamingKind =
  | 'interview'
  | 'prompt'
  | 'resume'
  | 'meeting'
  | 'contract'
  | 'document'
  | 'image'
  | 'presentation'
  | 'spreadsheet'
  | 'checklist'
  | 'code'
  | 'qa'
  | 'strategy'
  | 'general'

export interface NamingPlan {
  kind: NamingKind
  summary: string
  title: string
  keywords: string[]
}

export interface FolderSuggestion {
  category: string
  subcategory?: string
}

const GENERIC_TITLE_WORDS = new Set([
  'document', 'documents', 'file', 'files', 'notes', 'note', 'draft', 'copy', 'template', 'text',
  'content', 'page', 'pages', 'folder', 'pdf', 'doc', 'docx', 'ppt', 'pptx', 'xls', 'xlsx', 'csv',
])

const WEAK_TITLE_EXACT = new Set([
  'untitled',
  'document',
  'new note',
  'note',
  'notes',
  'scan',
  'image',
  'picture',
  'copy',
  'draft',
])

const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico', 'heic', 'svg'])
const TITLE_ACRONYMS = new Set(['ai', 'api', 'csv', 'docx', 'kpi', 'llm', 'pdf', 'ppt', 'pptx', 'rag', 'sql', 'ui', 'ux', 'xlsx'])

function toTitleCase(value: string): string {
  return value
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => {
      const lower = word.toLowerCase()
      if (TITLE_ACRONYMS.has(lower)) return lower.toUpperCase()
      return /^[A-Z]{2,4}$/.test(word) ? word : word.charAt(0).toUpperCase() + word.slice(1).toLowerCase()
    })
    .join(' ')
}

function sanitizeProfessionalTitle(value: string): string {
  return toTitleCase(
    value
      .replace(/[/\\:*?"<>|]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim(),
  ).substring(0, 60).trim()
}

function appendDistinctSuffix(base: string, suffix: string): string {
  const baseWords = new Set(titleWords(base))
  const suffixWords = titleWords(suffix)
  const needsSuffix = suffixWords.some((word) => !baseWords.has(word))
  return needsSuffix ? sanitizeProfessionalTitle(`${base} ${suffix}`) : sanitizeProfessionalTitle(base)
}

function stripContractSuffixes(value: string): string {
  return sanitizeProfessionalTitle(
    value
      .replace(/\b(inc|llc|ltd|corp|co|company)\b/gi, ' ')
      .replace(/\s+/g, ' ')
      .trim(),
  )
}

function titleWords(value: string): string[] {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
}

function pathExtension(path?: string): string {
  if (!path) return ''
  const match = path.toLowerCase().match(/\.([a-z0-9]+)$/)
  return match ? match[1] : ''
}

function pathContextText(path?: string): string {
  if (!path) return ''
  return path
    .replace(/\\/g, '/')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/[._/-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
}

function tokenizePath(path?: string): string[] {
  if (!path) return []
  return path
    .replace(/\\/g, '/')
    .split(/[/\s._-]+/)
    .flatMap((segment) => segment.replace(/([a-z])([A-Z])/g, '$1 $2').split(/\s+/))
    .map((token) => token.toLowerCase())
    .filter((token) => token.length > 1 && !GENERIC_PATH_WORDS.has(token))
}

function uniqueWords(words: string[]): string[] {
  const seen = new Set<string>()
  return words.filter((word) => {
    if (seen.has(word)) return false
    seen.add(word)
    return true
  })
}

function rankKeywords(content: string, pathTokens: string[]): string[] {
  const allWords = content.toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((word) => (word.length > 3 || TITLE_ACRONYMS.has(word)) && !STOP_WORDS.has(word))

  const freq = new Map<string, number>()
  allWords.forEach((word, index) => {
    const boost = index < 40 ? 2 : 1
    freq.set(word, (freq.get(word) || 0) + boost)
  })
  pathTokens.forEach((token) => {
    if (token.length > 2) {
      freq.set(token, (freq.get(token) || 0) + 4)
    }
  })

  return uniqueWords(
    Array.from(freq.entries())
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([word]) => word)
      .filter((word) => !TITLE_FILLER_WORDS.has(word)),
  ).slice(0, 4)
}

function pathEntity(path?: string): string | null {
  if (!path) return null

  const normalizedPath = path.replace(/\\/g, '/')
  const segments = normalizedPath.split('/').filter(Boolean)
  const basename = segments[segments.length - 1]?.replace(/\.[^.]+$/, '') || ''
  const parent = segments[segments.length - 2] || ''

  const cleanSegment = (segment: string, keepShortUpper = false): string | null => {
    const rawPieces = segment
      .replace(/[._-]+/g, ' ')
      .split(/\s+/)
      .filter(Boolean)

    const words = rawPieces
      .flatMap((token) => token.replace(/([a-z])([A-Z])/g, '$1 $2').split(/\s+/))
      .map((token) => token.toLowerCase())
      .filter((token) => token.length > 1)
      .filter((token) => !GENERIC_PATH_WORDS.has(token))
      .filter((token) => !['contract', 'agreement', 'offer', 'letter', 'packet', 'resume', 'prompt', 'template', 'interview', 'profile', 'statement', 'bank', 'guide', 'proposal', 'report'].includes(token))

    if (words.length === 0) return null

    if (keepShortUpper) {
      const preserved = rawPieces
        .filter((token) => !['offer', 'letter', 'contract', 'agreement', 'statement', 'profile'].includes(token.toLowerCase()))
        .filter((token) => token.length > 1)
        .slice(0, 3)
      if (preserved.length > 0) {
        return sanitizeProfessionalTitle(preserved.join(' '))
      }
    }

    return sanitizeProfessionalTitle(words.slice(0, 3).join(' '))
  }

  const basenameEntity = cleanSegment(basename, true)
  if (basenameEntity) return basenameEntity

  const parentEntity = cleanSegment(parent, true)
  if (parentEntity) return parentEntity

  const tokens = tokenizePath(path)
    .filter((token) => token.length > 2)
    .filter((token) => !['contract', 'agreement', 'offer', 'letter', 'packet', 'resume', 'prompt', 'template', 'interview', 'profile', 'statement', 'bank', 'proposal', 'guide', 'report'].includes(token))
  if (tokens.length === 0) return null
  return sanitizeProfessionalTitle(tokens.slice(0, 2).join(' '))
}

function hasFinanceContext(text: string): boolean {
  return /\b(finance|financial|budget|forecast|revenue|expense|expenses|runway|cash|profit|loss|invoice|arr|mrr)\b/i.test(text)
}

function hasMeetingContext(text: string): boolean {
  return /\b(meeting|agenda|minutes|standup|sync|weekly sync|weekly review|monthly review|follow-up|recap)\b/i.test(text)
}

function hasMetricsContext(text: string): boolean {
  return /\b(kpi|metric|metrics|dashboard|reporting|pipeline|conversion|retention|churn|throughput|utilization|scorecard)\b/i.test(text)
}

function hasExportContext(text: string): boolean {
  return /\b(export|download|transaction export|statement export|ledger export|csv export|raw data|extract)\b/i.test(text)
}

export function detectInterviewTitle(text: string): string | null {
  const lower = text.toLowerCase()
  const isDialogue = /\*\*interviewer:\*\*|\*\*you:\*\*|(^|\n)\s*(interviewer|candidate|you):/i.test(text)
  if (!isDialogue) return null

  if (/(weather|how('?s| is) it going|small talk|warm|storm|grounded)/i.test(lower)) {
    return 'Interview Small Talk Practice'
  }
  if (/(bedrock|rag|langchain|langgraph|agent|system design)/i.test(lower)) {
    return 'AI Engineering Interview Prep'
  }
  if (/(resume|experience section|bullet points|job description)/i.test(lower)) {
    return 'Resume Interview Prep'
  }
  return 'Interview Practice Transcript'
}

export function detectPromptTitle(text: string): string | null {
  const lower = text.toLowerCase()
  const startsLikeInstruction = /^(rewrite|build|create|give|help|make|generate|improve|shorten)\b/i.test(text.trim())
  if (!startsLikeInstruction) return null

  if (/\bresume\b/i.test(lower)) return 'Resume Rewrite Prompt'
  if (/\binterview\b/i.test(lower)) return 'Interview Answer Prompt'
  if (/\bprompt\b/i.test(lower)) return 'Prompt Template'
  if (/\bapi\b|\bbackend\b|\bschema\b/i.test(lower)) return 'API Design Prompt'
  return 'Writing Prompt'
}

export function detectTopicTitle(text: string): string | null {
  const lower = text.toLowerCase()
  if (/\bresume\b.*\bexperience\b|\bexperience\b.*\bresume\b/i.test(lower)) return 'Resume Experience Rewrite'
  if (/\bquality\b.*\btesting\b|\btesting\b.*\bquality\b/i.test(lower)) return 'Testing Quality Strategy'
  if (/\bprompt engineering\b|\bprompt generation\b/i.test(lower)) return 'Prompt Engineering Guide'
  if (/\bgithub\b.*\bactivity\b/i.test(lower)) return 'GitHub Activity Plan'
  if (/\btool\b.*\bintegration\b/i.test(lower)) return 'Tool Integration Plan'
  return null
}

export function looksLikeMessyGeneratedTitle(title: string): boolean {
  const words = titleWords(title)
  if (words.length < 2) return true
  if (words.length > 6) return true

  const fillerCount = words.filter((word) => TITLE_FILLER_WORDS.has(word)).length
  if (fillerCount >= Math.ceil(words.length / 2)) return true

  const badStarts = ['yeah', 'today', 'just', 'easy', 'interviewer']
  if (badStarts.includes(words[0])) return true

  return false
}

export function needsProfessionalTitleCleanup(title: string): boolean {
  const normalized = sanitizeProfessionalTitle(title)
  if (!normalized) return true

  const lower = normalized.toLowerCase()
  const words = titleWords(normalized)
  if (/^[a-z0-9]+(?:_[a-z0-9]+)+$/.test(title.trim())) return true
  if (WEAK_TITLE_EXACT.has(lower)) return true
  if (looksLikeMessyGeneratedTitle(normalized)) return true
  if (words.length < 2) return true

  if (/^(img|image|scan|screenshot|file|document)[\s_-]*\d+/i.test(lower)) return true
  if (/\b(copy|draft)\b/i.test(lower) && words.length <= 3) return true
  if (/^\d+$/.test(lower)) return true

  const meaningfulWords = words.filter((word) => !GENERIC_TITLE_WORDS.has(word))
  if (meaningfulWords.length < 2) return true

  return false
}

export function normalizeGeneratedTitleForPlan(title: string, plan: NamingPlan): string {
  const sanitized = sanitizeProfessionalTitle(title)
  if (!sanitized || looksLikeMessyGeneratedTitle(sanitized)) {
    return plan.title
  }

  const words = titleWords(sanitized).filter((word) => !GENERIC_TITLE_WORDS.has(word))
  if (words.length < 2 || words.length > 7) {
    return plan.title
  }

  let candidate = sanitizeProfessionalTitle(words.join(' '))
  const candidateWords = titleWords(candidate)

  const ensureSuffix = (suffix: string) => {
    if (!titleWords(candidate).includes(suffix.toLowerCase())) {
      candidate = sanitizeProfessionalTitle(`${candidate} ${suffix}`)
    }
  }

  const ensurePrefix = (prefix: string) => {
    if (!candidateWords.includes(prefix.toLowerCase())) {
      candidate = sanitizeProfessionalTitle(`${prefix} ${candidate}`)
    }
  }

  switch (plan.kind) {
    case 'contract':
      if (!candidateWords.some((word) => ['contract', 'agreement', 'offer'].includes(word))) {
        ensureSuffix('Contract')
      }
      break
    case 'presentation':
      if (!candidateWords.some((word) => ['presentation', 'deck', 'slides'].includes(word))) {
        ensureSuffix('Presentation')
      } else if (candidateWords.includes('slides') || candidateWords.includes('deck')) {
        candidate = sanitizeProfessionalTitle(candidate.replace(/\b(slides|deck)\b/ig, 'Presentation'))
      }
      break
    case 'spreadsheet':
      if (!candidateWords.some((word) => ['report', 'spreadsheet', 'budget', 'forecast', 'revenue', 'expense', 'invoice'].includes(word))) {
        ensureSuffix('Report')
      } else if (candidateWords.includes('spreadsheet')) {
        candidate = sanitizeProfessionalTitle(candidate.replace(/\bspreadsheet\b/ig, 'Report'))
      }
      break
    case 'prompt':
      if (!candidateWords.some((word) => ['prompt', 'template'].includes(word))) {
        ensureSuffix('Prompt')
      }
      break
    case 'interview':
      if (!candidateWords.includes('interview')) {
        ensurePrefix('Interview')
      }
      break
    case 'resume':
      if (!candidateWords.some((word) => ['resume', 'cv'].includes(word))) {
        ensurePrefix('Resume')
      }
      break
    case 'meeting':
      if (!candidateWords.some((word) => ['meeting', 'agenda', 'minutes'].includes(word))) {
        ensureSuffix('Meeting Notes')
      }
      break
    case 'document':
      if (!candidateWords.some((word) => ['guide', 'reference', 'report', 'proposal', 'itinerary', 'brief', 'offer', 'statement', 'profile', 'letter'].includes(word))) {
        ensureSuffix('Reference')
      } else if (candidateWords.includes('document')) {
        candidate = sanitizeProfessionalTitle(candidate.replace(/\bdocument\b/ig, 'Reference'))
      }
      break
    case 'image':
      if (!candidateWords.some((word) => ['screenshot', 'diagram', 'image', 'photo', 'mockup', 'wireframe'].includes(word))) {
        ensureSuffix('Screenshot')
      }
      break
    default:
      break
  }

  if (looksLikeMessyGeneratedTitle(candidate)) {
    return plan.title
  }

  return candidate
}

export function summarizeContentForNaming(content: string, currentPath?: string): NamingPlan {
  const text = content.trim()
  const lower = text.toLowerCase()
  const ext = pathExtension(currentPath)
  const pathTokens = tokenizePath(currentPath)
  const contextText = `${lower} ${pathContextText(currentPath)}`

  const interviewTitle = detectInterviewTitle(text)
  if (interviewTitle) {
    return {
      kind: 'interview',
      summary: 'Interview transcript or practice dialogue',
      title: interviewTitle,
      keywords: ['interview', 'practice'],
    }
  }

  const promptTitle = detectPromptTitle(text)
  if (promptTitle) {
    return {
      kind: 'prompt',
      summary: 'Prompt or instruction template',
      title: promptTitle,
      keywords: ['prompt', 'template'],
    }
  }

  const topicTitle = detectTopicTitle(text)
  if (topicTitle) {
    return {
      kind: topicTitle.toLowerCase().includes('resume')
        ? 'resume'
        : topicTitle.toLowerCase().includes('strategy')
          ? 'strategy'
          : 'general',
      summary: topicTitle,
      title: topicTitle,
      keywords: rankKeywords(text, pathTokens).slice(0, 3),
    }
  }

  if (/\b(offer letter|offer packet|offer)\b/i.test(contextText)) {
    const entity = pathEntity(currentPath)
    const base = entity || 'Offer'
    return {
      kind: 'document',
      summary: `${base} offer-related document`,
      title: appendDistinctSuffix(base, 'Offer Letter'),
      keywords: rankKeywords(text, pathTokens).slice(0, 3),
    }
  }

  if (/(contract|agreement|offer letter|statement of work|sow|nda)/i.test(contextText)) {
    const entity = pathEntity(currentPath)
    const contractEntity = entity ? stripContractSuffixes(entity) || entity : null
    const base = contractEntity ? `${contractEntity} Contract` : 'Contract Document'
    return {
      kind: 'contract',
      summary: contractEntity ? `${contractEntity} contract or agreement document` : 'Contract or agreement document',
      title: base,
      keywords: uniqueWords(['contract', ...pathTokens]).slice(0, 3),
    }
  }

  if (IMAGE_EXTENSIONS.has(ext) || /\b(screenshot|screen shot|photo|image|diagram|wireframe|mockup|flowchart)\b/i.test(contextText)) {
    const keywords = rankKeywords(text, pathTokens)
    if (/\bbank statement\b/i.test(contextText)) {
      return {
        kind: 'image',
        summary: 'Bank statement scan or screenshot',
        title: 'Bank Statement Image',
        keywords: ['bank', 'statement', 'image'],
      }
    }

    if (/\b(invoice|receipt)\b/i.test(contextText)) {
      return {
        kind: 'image',
        summary: 'Financial document scan or screenshot',
        title: /\binvoice\b/i.test(contextText) ? 'Invoice Image' : 'Receipt Image',
        keywords: /\binvoice\b/i.test(contextText) ? ['invoice', 'image'] : ['receipt', 'image'],
      }
    }

    const imageEntity = pathEntity(currentPath)
      || sanitizeProfessionalTitle(keywords.slice(0, 2).join(' '))
      || 'Reference'

    const imageSuffix = /\b(screenshot|screen shot)\b/i.test(contextText)
      ? 'Screenshot'
      : /\b(diagram|architecture|flowchart|schema)\b/i.test(contextText)
        ? 'Diagram'
      : /\b(wireframe|mockup)\b/i.test(contextText)
        ? 'Mockup'
        : /\b(photo|photos|portrait)\b/i.test(contextText)
          ? 'Photo'
          : 'Image'

    return {
      kind: 'image',
      summary: `${imageEntity} visual reference`,
      title: appendDistinctSuffix(imageEntity, imageSuffix),
      keywords: keywords.slice(0, 3),
    }
  }

  if (ext === 'ppt' || ext === 'pptx' || /\b(slide deck|slides|presentation)\b/i.test(contextText)) {
    const keywords = rankKeywords(text, pathTokens)
    const topic = sanitizeProfessionalTitle(keywords.slice(0, 2).join(' ')) || 'Presentation'
    const financeDeck = hasFinanceContext(contextText)
    const meetingDeck = hasMeetingContext(contextText)
    const metricsDeck = hasMetricsContext(contextText)
    const explicitMeetingDeckTitle = /\bweekly sync\b/i.test(contextText)
      ? 'Weekly Sync Presentation'
      : /\bmonthly review\b/i.test(contextText)
        ? 'Monthly Review Presentation'
        : /\bstandup\b/i.test(contextText)
          ? 'Standup Presentation'
          : null
    const baseTitle = meetingDeck
      ? explicitMeetingDeckTitle || appendDistinctSuffix(topic === 'Presentation' ? 'Meeting' : topic, 'Presentation')
      : financeDeck
        ? appendDistinctSuffix(topic === 'Presentation' ? 'Finance' : topic, 'Presentation')
        : metricsDeck
          ? appendDistinctSuffix(topic === 'Presentation' ? 'Metrics' : topic, 'Presentation')
          : sanitizeProfessionalTitle(`${topic} Presentation`)
    return {
      kind: 'presentation',
      summary: `${topic} presentation or slide deck`,
      title: baseTitle,
      keywords: keywords.slice(0, 3),
    }
  }

  if (['xls', 'xlsx', 'csv'].includes(ext) || /\b(spreadsheet|worksheet|sheet|dashboard|metrics|kpi|statement export|transaction export|ledger export|csv export|raw data|extract)\b/i.test(contextText)) {
    const keywords = rankKeywords(text, pathTokens)
    const primaryFinanceTopic = keywords.find((word) =>
      ['budget', 'forecast', 'revenue', 'expense', 'expenses', 'invoice'].includes(word),
    )
    const financeSheet = hasFinanceContext(contextText)
    const metricsSheet = hasMetricsContext(contextText)
    const exportSheet = hasExportContext(contextText)
    const statementSheet = /\b(statement|bank statement|transactions?|ledger)\b/i.test(contextText)
    const topic = primaryFinanceTopic
      ? sanitizeProfessionalTitle(primaryFinanceTopic)
      : sanitizeProfessionalTitle(keywords.slice(0, 2).join(' ')) || 'Data'
    const suffix = exportSheet
      ? 'Export'
      : metricsSheet
        ? 'Metrics Report'
        : financeSheet || statementSheet
          ? 'Report'
          : 'Spreadsheet'
    const baseTitle = statementSheet && exportSheet
      ? /\bbank statement\b/i.test(contextText)
        ? 'Bank Statement Export'
        : /\btransaction export\b/i.test(contextText)
          ? 'Transaction Export'
          : /\bledger export\b/i.test(contextText)
            ? 'Ledger Export'
            : appendDistinctSuffix(topic === 'Data' ? 'Statement' : topic, 'Export')
      : metricsSheet
        ? /\bkpi dashboard\b/i.test(contextText)
          ? 'KPI Dashboard Metrics Report'
          : appendDistinctSuffix(topic === 'Data' ? 'KPI' : topic, 'Metrics Report')
        : sanitizeProfessionalTitle(`${topic} ${suffix}`)
    return {
      kind: 'spreadsheet',
      summary: `${topic} ${suffix.toLowerCase()}`,
      title: baseTitle,
      keywords: keywords.slice(0, 3),
    }
  }

  if (['pdf', 'doc', 'docx'].includes(ext) || /\b(pdf|document|brief|report|analysis|proposal|guide|manual|reference|itinerary|onboarding|statement|profile|cover letter|offer)\b/i.test(contextText)) {
    const keywords = rankKeywords(text, pathTokens)
    const topic = sanitizeProfessionalTitle(keywords.slice(0, 2).join(' ')) || (pathEntity(currentPath) || 'Document')

    if (/\b(bank statement|statement)\b/i.test(contextText)) {
      const entity = pathEntity(currentPath)
      return {
        kind: 'document',
        summary: `${entity || topic} bank statement or financial statement`,
        title: appendDistinctSuffix(entity || topic, 'Bank Statement'),
        keywords: keywords.slice(0, 3),
      }
    }

    if (/\b(personal profile|profile)\b/i.test(contextText)) {
      const entity = pathEntity(currentPath)
      const base = entity && entity.toLowerCase() !== 'personal' ? entity : 'Personal'
      return {
        kind: 'document',
        summary: `${base} profile or background document`,
        title: appendDistinctSuffix(base, 'Profile'),
        keywords: keywords.slice(0, 3),
      }
    }

    if (/\bcover letter\b/i.test(contextText)) {
      const entity = pathEntity(currentPath)
      return {
        kind: 'document',
        summary: `${entity || topic} cover letter document`,
        title: appendDistinctSuffix(entity || topic, 'Cover Letter'),
        keywords: keywords.slice(0, 3),
      }
    }

    if (/\b(itinerary|travel)\b/i.test(contextText)) {
      return {
        kind: 'document',
        summary: 'Travel itinerary or trip planning document',
        title: 'Travel Itinerary',
        keywords: keywords.slice(0, 3),
      }
    }

    if (/\b(onboarding)\b/i.test(contextText)) {
      const onboardingTopic = /\bemployee\b/i.test(lower)
        ? 'Employee'
        : pathEntity(currentPath) || topic.replace(/\bOnboarding\b/ig, '').trim() || 'Onboarding'
      return {
        kind: 'document',
        summary: `${topic} onboarding or setup document`,
        title: appendDistinctSuffix(onboardingTopic, 'Onboarding Guide'),
        keywords: keywords.slice(0, 3),
      }
    }

    if (/\b(proposal)\b/i.test(contextText)) {
      const topicWordsForProposal = new Set(titleWords(topic))
      const proposalBase = pathEntity(currentPath)
        || (topicWordsForProposal.has('proposal') ? 'Project' : topic)
      return {
        kind: 'document',
        summary: `${proposalBase} proposal document`,
        title: appendDistinctSuffix(proposalBase, 'Proposal'),
        keywords: keywords.slice(0, 3),
      }
    }

    if (/\b(report|analysis|findings|summary)\b/i.test(contextText)) {
      return {
        kind: 'document',
        summary: `${topic} report or analysis document`,
        title: appendDistinctSuffix(topic, 'Report'),
        keywords: keywords.slice(0, 3),
      }
    }

    if (/\b(guide|manual|reference|playbook|tutorial)\b/i.test(contextText)) {
      return {
        kind: 'document',
        summary: `${topic} guide or reference document`,
        title: appendDistinctSuffix(topic, 'Guide'),
        keywords: keywords.slice(0, 3),
      }
    }

    return {
      kind: 'document',
      summary: `${topic} reference document`,
      title: sanitizeProfessionalTitle(`${topic} Reference`),
      keywords: keywords.slice(0, 3),
    }
  }

  if (/\b(meeting|agenda|minutes|standup|sync|follow-up)\b/i.test(lower)) {
    const keywords = rankKeywords(text, pathTokens)
    const topic = sanitizeProfessionalTitle(keywords.slice(0, 2).join(' ')) || 'Meeting'
    return {
      kind: 'meeting',
      summary: `${topic} meeting notes or schedule`,
      title: sanitizeProfessionalTitle(`${topic} Meeting Notes`),
      keywords: keywords.slice(0, 3),
    }
  }

  if (/\b(resume|cv|cover letter|job description)\b/i.test(contextText)) {
    const keywords = rankKeywords(text, pathTokens)
    const modifier = /\b(interview|question|behavioral)\b/i.test(lower)
      ? 'Interview Prep'
      : /\b(experience|bullet|rewrite)\b/i.test(lower)
        ? 'Experience Rewrite'
        : 'Resume Notes'
    return {
      kind: 'resume',
      summary: `Resume or job search content focused on ${modifier.toLowerCase()}`,
      title: sanitizeProfessionalTitle(`Resume ${modifier}`),
      keywords: keywords.slice(0, 3),
    }
  }

  if (text.match(/^[-*•]\s/m) || text.split('\n').filter((line) => /^\d+[.)]\s/.test(line)).length > 2) {
    const keywords = rankKeywords(text, pathTokens)
    const topic = sanitizeProfessionalTitle(keywords[0] || 'Task')
    return {
      kind: 'checklist',
      summary: `${topic} checklist or action list`,
      title: sanitizeProfessionalTitle(`${topic} Checklist`),
      keywords: keywords.slice(0, 3),
    }
  }

  if (/\b(function|class|const|let|var|import|export|return)\b/.test(lower) || text.includes('```')) {
    const language = text.match(/```(\w+)/)?.[1]
    const keywords = rankKeywords(text, pathTokens)
    const topic = sanitizeProfessionalTitle(keywords[0] || language || 'Code')
    return {
      kind: 'code',
      summary: `${topic} code notes or implementation reference`,
      title: sanitizeProfessionalTitle(`${topic} Code Notes`),
      keywords: keywords.slice(0, 3),
    }
  }

  if ((text.match(/\?/g) || []).length > 1) {
    const keywords = rankKeywords(text, pathTokens)
    const topic = sanitizeProfessionalTitle(keywords[0] || 'Topic')
    return {
      kind: 'qa',
      summary: `Questions and answers about ${topic.toLowerCase()}`,
      title: sanitizeProfessionalTitle(`Questions About ${topic}`),
      keywords: keywords.slice(0, 3),
    }
  }

  const keywords = rankKeywords(text, pathTokens)
  if (keywords.length > 0) {
    const topic = sanitizeProfessionalTitle(keywords.slice(0, 2).join(' '))
    const title = /\b(strategy|approach|plan|roadmap|architecture|quality)\b/i.test(lower)
      ? sanitizeProfessionalTitle(`${topic} Strategy`)
      : sanitizeProfessionalTitle(`${topic} Notes`)
    return {
      kind: title.endsWith('Strategy') ? 'strategy' : 'general',
      summary: `General knowledge note about ${topic.toLowerCase()}`,
      title,
      keywords: keywords.slice(0, 4),
    }
  }

  const date = new Date()
  const fallbackTitle = `Note ${date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`
  return {
    kind: 'general',
    summary: 'General note with limited content',
    title: fallbackTitle,
    keywords: [],
  }
}

export function suggestFolderFromNamingPlan(content: string, currentPath?: string): FolderSuggestion {
  const plan = summarizeContentForNaming(content, currentPath)
  const contextText = `${content.toLowerCase()} ${pathContextText(currentPath)}`

  switch (plan.kind) {
    case 'interview':
      return { category: 'Career', subcategory: 'Interview Prep' }
    case 'prompt':
      return /\b(ai|llm|rag|model|embedding|prompt)\b/i.test(contextText)
        ? { category: 'Resources', subcategory: 'AI Prompts' }
        : { category: 'Learning', subcategory: 'Notes' }
    case 'resume':
      return { category: 'Career', subcategory: 'Job Search' }
    case 'meeting':
      return { category: 'Work', subcategory: 'Meetings' }
    case 'contract':
      if (/\b(offer|resume|job|hiring|employment)\b/i.test(contextText)) {
        return { category: 'Career', subcategory: 'Documents' }
      }
      return { category: 'Work', subcategory: 'Contracts' }
    case 'document':
      if (/\b(proposal|analysis|report|research|findings|competitive)\b/i.test(contextText)) {
        return { category: 'Work', subcategory: 'Research' }
      }
      if (/\b(strategy|roadmap|priority|priorities|planning|quarterly|q[1-4]|go to market|execution)\b/i.test(contextText)) {
        return { category: 'Work', subcategory: 'Strategy' }
      }
      if (/\b(bank statement|statement|invoice|expense|budget|finance|receipt)\b/i.test(contextText)) {
        return { category: 'Finance', subcategory: 'Documents' }
      }
      if (/\b(offer|resume|cover letter|job description|interview|profile|hiring)\b/i.test(contextText)) {
        return /\b(interview|profile)\b/i.test(contextText)
          ? { category: 'Career', subcategory: 'Interview Prep' }
          : { category: 'Career', subcategory: 'Documents' }
      }
      if (/\b(onboarding|guide|manual|reference|playbook|runbook)\b/i.test(contextText)) {
        return { category: 'Work', subcategory: 'Documents' }
      }
      if (/\b(itinerary|travel|trip)\b/i.test(contextText)) {
        return { category: 'Personal', subcategory: 'Travel' }
      }
      if (/\b(ai|llm|rag|prompt|model|embedding)\b/i.test(contextText)) {
        return { category: 'Learning', subcategory: 'AI' }
      }
      return { category: 'Work', subcategory: 'Documents' }
    case 'image':
      if (/\b(bank statement|statement|invoice|receipt)\b/i.test(contextText)) {
        return { category: 'Finance', subcategory: 'Documents' }
      }
      if (/\b(interview|resume|job|career)\b/i.test(contextText)) {
        return { category: 'Career', subcategory: 'Reference' }
      }
      if (/\b(screenshot|diagram|wireframe|mockup|architecture|flowchart|schema|ui|ux)\b/i.test(contextText)) {
        return { category: 'Work', subcategory: 'Reference' }
      }
      return { category: 'Resources', subcategory: 'Images' }
    case 'presentation':
      if (hasMeetingContext(contextText)) {
        return { category: 'Work', subcategory: 'Meetings' }
      }
      if (hasFinanceContext(contextText) || hasMetricsContext(contextText)) {
        return { category: 'Finance', subcategory: 'Presentations' }
      }
      if (/\b(project|launch|roadmap|milestone|plan|planning|proposal)\b/i.test(contextText)) {
        return { category: 'Projects', subcategory: 'Planning' }
      }
      return { category: 'Work', subcategory: 'Presentations' }
    case 'spreadsheet':
      if (hasExportContext(contextText) || /\b(statement|bank statement|ledger|transaction)\b/i.test(contextText)) {
        return { category: 'Finance', subcategory: 'Exports' }
      }
      if (hasFinanceContext(contextText)) {
        return { category: 'Finance', subcategory: 'Reports' }
      }
      if (hasMetricsContext(contextText)) {
        return { category: 'Work', subcategory: 'Reporting' }
      }
      if (hasMeetingContext(contextText)) {
        return { category: 'Work', subcategory: 'Meetings' }
      }
      return { category: 'Work', subcategory: 'Data' }
    case 'checklist':
      return /\b(project|roadmap|milestone|launch|mvp|plan)\b/i.test(contextText)
        ? { category: 'Projects', subcategory: 'Planning' }
        : { category: 'Learning', subcategory: 'Checklists' }
    case 'code':
      return { category: 'Work', subcategory: 'Engineering' }
    case 'qa':
      return /\b(ai|llm|rag|prompt)\b/i.test(contextText)
        ? { category: 'Learning', subcategory: 'AI' }
        : { category: 'Learning', subcategory: 'Notes' }
    case 'strategy':
      return /\b(project|roadmap|milestone|launch|mvp|plan)\b/i.test(contextText)
        ? { category: 'Projects', subcategory: 'Planning' }
        : { category: 'Work', subcategory: 'Strategy' }
    default:
      if (/\b(health|routine|workout|diet|sleep|skincare)\b/i.test(contextText)) {
        return { category: 'Personal', subcategory: 'Health' }
      }
      if (/\b(prompt|llm|ai|model|embedding|rag)\b/i.test(contextText)) {
        return { category: 'Learning', subcategory: 'AI' }
      }
      if (/\b(project|roadmap|milestone|plan)\b/i.test(contextText)) {
        return { category: 'Projects', subcategory: 'Planning' }
      }
      if (/\b(meeting|agenda|minutes|standup|sync)\b/i.test(contextText)) {
        return { category: 'Work', subcategory: 'Meetings' }
      }
      return { category: 'Learning', subcategory: 'Notes' }
  }
}

export function extractTitleFromContent(content: string, currentPath?: string): string {
  if (!content || content.trim().length === 0) {
    const date = new Date()
    return `Note ${date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`
  }

  return summarizeContentForNaming(content, currentPath).title
}
