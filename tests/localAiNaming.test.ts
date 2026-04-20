import test from 'node:test'
import assert from 'node:assert/strict'

import {
  detectInterviewTitle,
  detectPromptTitle,
  detectTopicTitle,
  extractTitleFromContent,
  looksLikeMessyGeneratedTitle,
  needsProfessionalTitleCleanup,
  normalizeGeneratedTitleForPlan,
  suggestFolderFromNamingPlan,
  summarizeContentForNaming,
} from '../src/utils/titleNaming.ts'

test('detectInterviewTitle recognizes small-talk interview transcript', () => {
  const content = `**Interviewer:** Hey Julian, how's it going today?

**You:** Doing well, thanks. Just staying warm honestly.`

  assert.equal(detectInterviewTitle(content), 'Interview Small Talk Practice')
})

test('detectPromptTitle recognizes resume rewrite prompt style content', () => {
  const content = 'Rewrite my resume experience section to match the job description and keep it concise.'
  assert.equal(detectPromptTitle(content), 'Resume Rewrite Prompt')
})

test('detectTopicTitle recognizes testing strategy content', () => {
  const content = 'My approach to testing and quality assurance is to combine unit tests, integration tests, and code review.'
  assert.equal(detectTopicTitle(content), 'Testing Quality Strategy')
})

test('looksLikeMessyGeneratedTitle flags conversational filler titles', () => {
  assert.equal(looksLikeMessyGeneratedTitle('Interviewer Yeah Today Pretty'), true)
  assert.equal(looksLikeMessyGeneratedTitle('Yeah Just Know Really'), true)
  assert.equal(looksLikeMessyGeneratedTitle('Resume Rewrite Prompt'), false)
})

test('extractTitleFromContent produces professional interview title instead of phrase fragment', () => {
  const content = `**Interviewer:** Hey Julian, how's it going today?

**You:** Doing well, thanks. Just staying warm honestly.`

  assert.equal(extractTitleFromContent(content), 'Interview Small Talk Practice')
})

test('extractTitleFromContent produces professional prompt title', () => {
  const content = 'Build me a prompt that rewrites the executive summary of my resume for a senior backend role.'
  assert.equal(extractTitleFromContent(content), 'Resume Rewrite Prompt')
})

test('extractTitleFromContent keeps a semantic strategy title for quality content', () => {
  const content = 'My approach to testing and quality assurance treats quality as an ongoing process using integration tests and peer review.'
  assert.equal(extractTitleFromContent(content), 'Testing Quality Strategy')
})

test('summarizeContentForNaming generates a professional contract title from file context', () => {
  const content = 'This employment agreement sets out compensation, responsibilities, confidentiality, and termination terms.'
  const plan = summarizeContentForNaming(content, 'contract_docs_examples/Reco Universal LLC Contract.docx')

  assert.equal(plan.kind, 'contract')
  assert.equal(plan.title, 'Reco Universal Contract')
})

test('summarizeContentForNaming generates a presentation title for slide decks', () => {
  const content = 'Q3 marketing strategy presentation covering channels, goals, and campaign planning.'
  const plan = summarizeContentForNaming(content, 'work/marketing_strategy.pptx')

  assert.equal(plan.kind, 'presentation')
  assert.equal(plan.title, 'Marketing Strategy Presentation')
})

test('summarizeContentForNaming generates a finance presentation title for finance decks', () => {
  const content = 'Quarterly finance presentation covering revenue, expense trends, runway, and forecast updates for leadership.'
  const plan = summarizeContentForNaming(content, 'finance/q3_finance_review.pptx')

  assert.equal(plan.kind, 'presentation')
  assert.equal(plan.title, 'Finance Review Presentation')
})

test('summarizeContentForNaming generates a meeting presentation title for weekly sync slide packs', () => {
  const content = 'Weekly sync presentation covering blockers, owner updates, action items, and follow-up decisions.'
  const plan = summarizeContentForNaming(content, 'work/weekly_sync_deck.pptx')

  assert.equal(plan.kind, 'presentation')
  assert.equal(plan.title, 'Weekly Sync Presentation')
})

test('summarizeContentForNaming generates a spreadsheet-style title for finance data', () => {
  const content = 'Budget, monthly expenses, operating costs, and revenue assumptions for 2026 planning.'
  const plan = summarizeContentForNaming(content, 'finance/budget_2026.xlsx')

  assert.equal(plan.kind, 'spreadsheet')
  assert.equal(plan.title, 'Budget Report')
})

test('summarizeContentForNaming generates a metrics report title for KPI workbooks', () => {
  const content = 'KPI dashboard with conversion metrics, churn, retention, weekly scorecard, and reporting notes.'
  const plan = summarizeContentForNaming(content, 'work/reporting/kpi_dashboard.xlsx')

  assert.equal(plan.kind, 'spreadsheet')
  assert.equal(plan.title, 'KPI Dashboard Metrics Report')
})

test('summarizeContentForNaming generates an export title for statement exports', () => {
  const content = 'transaction export with ledger rows, bank statement fields, balance history, and raw data extract.'
  const plan = summarizeContentForNaming(content, 'finance/exports/bank_statement_export.csv')

  assert.equal(plan.kind, 'spreadsheet')
  assert.equal(plan.title, 'Bank Statement Export')
})

test('summarizeContentForNaming generates a document guide title for onboarding docx files', () => {
  const content = 'Employee onboarding steps, required setup tasks, and account access instructions.'
  const plan = summarizeContentForNaming(content, 'work/Eccalon_Onboarding_Paperwork/Welcome Packet.docx')

  assert.equal(plan.kind, 'document')
  assert.equal(plan.title, 'Employee Onboarding Guide')
})

test('summarizeContentForNaming generates a document proposal title for generic pdf/docx proposals', () => {
  const content = 'Project proposal outlining scope, milestones, budget, and delivery approach.'
  const plan = summarizeContentForNaming(content, 'work/project_proposal_draft.docx')

  assert.equal(plan.kind, 'document')
  assert.equal(plan.title, 'Project Proposal')
})

test('summarizeContentForNaming generates an offer letter title from document path', () => {
  const content = 'Offer letter with compensation, benefits, start date, and employment terms.'
  const plan = summarizeContentForNaming(content, 'Career/Offer Packet/CloudWave Inc Offer.pdf')

  assert.equal(plan.kind, 'document')
  assert.equal(plan.title, 'Cloudwave Inc Offer Letter')
})

test('summarizeContentForNaming generates a bank statement title from personal finance docs', () => {
  const content = 'Monthly checking account transactions, balances, deposits, and withdrawals.'
  const plan = summarizeContentForNaming(content, 'JonathanHunter/bank_statement.pdf')

  assert.equal(plan.kind, 'document')
  assert.equal(plan.title, 'Jonathanhunter Bank Statement')
})

test('summarizeContentForNaming generates a clean profile title', () => {
  const content = 'Personal background, work history, strengths, and introduction for interviews.'
  const plan = summarizeContentForNaming(content, 'Career/Interview/Projects/PersonalProfile.docx')

  assert.equal(plan.kind, 'document')
  assert.equal(plan.title, 'Personal Profile')
})

test('summarizeContentForNaming generates a screenshot title from image path context', () => {
  const plan = summarizeContentForNaming('', 'Work/UI/system_design_architecture_screenshot.png')

  assert.equal(plan.kind, 'image')
  assert.equal(plan.title, 'System Design Architecture Screenshot')
})

test('summarizeContentForNaming generates a diagram title from image path context', () => {
  const plan = summarizeContentForNaming('', 'Work/Architecture/api_flow_diagram.png')

  assert.equal(plan.kind, 'image')
  assert.equal(plan.title, 'API Flow Diagram')
})

test('summarizeContentForNaming generates a photo title from generic image path context', () => {
  const plan = summarizeContentForNaming('', 'Personal/Photos/morning_walk.jpg')

  assert.equal(plan.kind, 'image')
  assert.equal(plan.title, 'Morning Walk Photo')
})

test('normalizeGeneratedTitleForPlan repairs contract-style noisy AI titles', () => {
  const plan = summarizeContentForNaming(
    'This employment agreement defines terms, compensation, confidentiality, and termination clauses.',
    'contract_docs_examples/Reco Universal LLC Contract.docx',
  )

  assert.equal(
    normalizeGeneratedTitleForPlan('Reco Universal LLC Employment Agreement Document File', plan),
    'Reco Universal Contract',
  )
})

test('normalizeGeneratedTitleForPlan converts slide deck wording into presentation naming', () => {
  const plan = summarizeContentForNaming(
    'Q3 marketing strategy slide deck covering campaigns and goals.',
    'work/marketing_strategy.pptx',
  )

  assert.equal(
    normalizeGeneratedTitleForPlan('Marketing Strategy Slides', plan),
    'Marketing Strategy Presentation',
  )
})

test('normalizeGeneratedTitleForPlan falls back to planner title for messy output', () => {
  const plan = summarizeContentForNaming(
    'Rewrite my resume experience section to match the job description and keep it concise.',
    'career/resume_prompt.md',
  )

  assert.equal(
    normalizeGeneratedTitleForPlan('Yeah Just Know Really', plan),
    'Resume Rewrite Prompt',
  )
})

test('normalizeGeneratedTitleForPlan enforces screenshot suffix for image plans', () => {
  const plan = summarizeContentForNaming('', 'Work/UI/system_design_architecture_screenshot.png')

  assert.equal(
    normalizeGeneratedTitleForPlan('system design architecture', plan),
    'System Design Architecture Screenshot',
  )
})

test('needsProfessionalTitleCleanup catches scan and export style names', () => {
  assert.equal(needsProfessionalTitleCleanup('IMG_2455'), true)
  assert.equal(needsProfessionalTitleCleanup('scan0001'), true)
  assert.equal(needsProfessionalTitleCleanup('Untitled Copy'), true)
  assert.equal(needsProfessionalTitleCleanup('bank_statement'), true)
  assert.equal(needsProfessionalTitleCleanup('Project Proposal'), false)
})

test('suggestFolderFromNamingPlan maps interview transcripts to career interview prep', () => {
  const content = `**Interviewer:** Hey Julian, how's it going today?

**You:** Doing well, thanks.`
  assert.deepEqual(suggestFolderFromNamingPlan(content, 'notes/interview_practice.md'), {
    category: 'Career',
    subcategory: 'Interview Prep',
  })
})

test('suggestFolderFromNamingPlan maps prompt templates to resources ai prompts', () => {
  const content = 'Create a prompt that rewrites my resume summary for a staff backend engineer role.'
  assert.deepEqual(suggestFolderFromNamingPlan(content, 'prompts/resume_prompt.md'), {
    category: 'Resources',
    subcategory: 'AI Prompts',
  })
})

test('suggestFolderFromNamingPlan maps finance statements to finance documents', () => {
  const content = 'Monthly checking account transactions, balances, deposits, and withdrawals.'
  assert.deepEqual(suggestFolderFromNamingPlan(content, 'JonathanHunter/bank_statement.pdf'), {
    category: 'Finance',
    subcategory: 'Documents',
  })
})

test('suggestFolderFromNamingPlan maps onboarding docs to work documents', () => {
  const content = 'Employee onboarding steps, required setup tasks, and account access instructions.'
  assert.deepEqual(suggestFolderFromNamingPlan(content, 'work/Eccalon_Onboarding_Paperwork/Welcome Packet.docx'), {
    category: 'Work',
    subcategory: 'Documents',
  })
})

test('suggestFolderFromNamingPlan maps proposals to work research', () => {
  const content = 'Project proposal outlining scope, milestones, budget, and delivery approach.'
  assert.deepEqual(suggestFolderFromNamingPlan(content, 'work/project_proposal_draft.docx'), {
    category: 'Work',
    subcategory: 'Research',
  })
})

test('suggestFolderFromNamingPlan maps finance decks to finance presentations', () => {
  const content = 'Quarterly finance presentation covering revenue, expense trends, runway, and forecast updates.'
  assert.deepEqual(suggestFolderFromNamingPlan(content, 'finance/q3_finance_review.pptx'), {
    category: 'Finance',
    subcategory: 'Presentations',
  })
})

test('suggestFolderFromNamingPlan maps weekly sync slide packs to work meetings', () => {
  const content = 'Weekly sync presentation with blockers, action items, owner updates, and recap slides.'
  assert.deepEqual(suggestFolderFromNamingPlan(content, 'work/weekly_sync_deck.pptx'), {
    category: 'Work',
    subcategory: 'Meetings',
  })
})

test('suggestFolderFromNamingPlan maps KPI workbooks to work reporting', () => {
  const content = 'KPI dashboard with churn, conversion, utilization, and scorecard metrics for leadership reporting.'
  assert.deepEqual(suggestFolderFromNamingPlan(content, 'work/reporting/kpi_dashboard.xlsx'), {
    category: 'Work',
    subcategory: 'Reporting',
  })
})

test('suggestFolderFromNamingPlan maps statement exports to finance exports', () => {
  const content = 'Raw bank statement export with transactions, ledger rows, and downloadable CSV extract.'
  assert.deepEqual(suggestFolderFromNamingPlan(content, 'finance/exports/bank_statement_export.csv'), {
    category: 'Finance',
    subcategory: 'Exports',
  })
})

test('suggestFolderFromNamingPlan maps screenshots to work reference', () => {
  const content = ''
  assert.deepEqual(suggestFolderFromNamingPlan(content, 'Work/UI/system_design_architecture_screenshot.png'), {
    category: 'Work',
    subcategory: 'Reference',
  })
})

test('suggestFolderFromNamingPlan maps generic images to resources images', () => {
  const content = ''
  assert.deepEqual(suggestFolderFromNamingPlan(content, 'Personal/Photos/morning_walk.jpg'), {
    category: 'Resources',
    subcategory: 'Images',
  })
})
