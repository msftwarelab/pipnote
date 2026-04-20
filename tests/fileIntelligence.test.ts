import test from 'node:test'
import assert from 'node:assert/strict'

import { analyzeAIReadableFile, analyzePreviewOnlyImageFile } from '../src/utils/fileIntelligence.ts'

test('analyzeAIReadableFile marks rich PDF extraction as high quality', () => {
  const result = analyzeAIReadableFile('Work/Docs/Quarterly Strategy.pdf', {
    kind: 'pdf',
    content: `Quarterly strategy memo covering growth priorities, product bets, hiring plan, customer feedback themes, and delivery risks across the business.
    The document outlines product direction, hiring plans, go-to-market sequencing, customer evidence, engineering constraints, and recommended execution priorities for the next two quarters.
    It includes narrative explanation, clear prose, and enough structured detail to classify the document confidently.`,
    message: 'Text extracted from PDF for search and Q&A.',
  })

  assert.equal(result.kind, 'pdf')
  assert.equal(result.fileRole, 'general-document')
  assert.equal(result.extractionQuality, 'high')
  assert.equal(result.conservativeReorganization, false)
  assert.equal(result.preferredCategory, 'Work')
  assert.equal(result.preferredSubcategory, 'Strategy')
})

test('analyzeAIReadableFile marks short extracted PDF text as low quality and conservative', () => {
  const result = analyzeAIReadableFile('Work/Scans/scan0001.pdf', {
    kind: 'pdf',
    content: 'Page 1 form',
    message: 'Text extracted from PDF for search and Q&A.',
  })

  assert.equal(result.extractionQuality, 'low')
  assert.equal(result.conservativeReorganization, true)
  assert.match(result.promptContext, /Avoid aggressive renames/i)
})

test('analyzeAIReadableFile detects noisy form-like document extraction', () => {
  const result = analyzeAIReadableFile('Finance/Statements/Statement-2026.pdf', {
    kind: 'pdf',
    content: `2026 04 15 000123 9981 4482 9321 00 1234 9999 22 13 5555 0000 TOTAL DUE 001 002 003 004 005
    2026 04 16 000223 9981 4482 9321 00 1234 9999 22 13 5555 0000 TOTAL DUE 006 007 008 009 010
    REF NO ACC NO BAL 0001 0002 0003 0004 0005 DEBIT CREDIT TOTAL DUE 011 012 013 014 015`,
    message: 'Text extracted from PDF for search and Q&A.',
  })

  assert.equal(result.extractionQuality, 'low')
  assert.equal(result.conservativeReorganization, true)
  assert.match(result.qualityReason, /noisy|form-like/i)
})

test('analyzeAIReadableFile keeps plain text notes out of conservative document mode', () => {
  const result = analyzeAIReadableFile('Notes/testing-strategy.md', {
    kind: 'text',
    content: 'Testing strategy for the product, including unit tests, integration tests, review gates, release checks, and monitoring expectations.',
  })

  assert.equal(result.kind, 'text')
  assert.equal(result.fileRole, 'text-note')
  assert.equal(result.conservativeReorganization, false)
  assert.match(result.promptContext, /note-style organization/i)
})

test('analyzeAIReadableFile infers contract role and contract guidance', () => {
  const result = analyzeAIReadableFile('Work/Legal/Reco Universal LLC Contract.docx', {
    kind: 'docx',
    content: 'This agreement defines compensation, confidentiality, services, payment terms, and termination conditions for the engagement.',
    message: 'Text extracted from DOCX for search and Q&A.',
  })

  assert.equal(result.fileRole, 'contract')
  assert.equal(result.preferredTitle, 'Reco Universal Contract')
  assert.match(result.promptContext, /formal contract or agreement/i)
})

test('analyzeAIReadableFile infers resume role and career folder hints', () => {
  const result = analyzeAIReadableFile('Career/Resume/Julian_Thomas_Resume.docx', {
    kind: 'docx',
    content: 'Senior software engineer resume highlighting React, Node.js, backend architecture, leadership, and delivery experience across multiple teams.',
    message: 'Text extracted from DOCX for search and Q&A.',
  })

  assert.equal(result.fileRole, 'resume')
  assert.equal(result.preferredCategory, 'Career')
  assert.match(result.promptContext, /job-search|resume/i)
})

test('analyzeAIReadableFile infers interview role and interview-prep guidance', () => {
  const result = analyzeAIReadableFile('Career/Interviews/bedrock_prep.pdf', {
    kind: 'pdf',
    content: '**Interviewer:** Tell me about your experience with RAG pipelines. **You:** I have built retrieval workflows with ranking, grounding, and evaluation.',
    message: 'Text extracted from PDF for search and Q&A.',
  })

  assert.equal(result.fileRole, 'interview')
  assert.equal(result.preferredSubcategory, 'Interview Prep')
  assert.match(result.promptContext, /interview preparation|interview-prep/i)
})

test('analyzeAIReadableFile infers spreadsheet role and reporting guidance', () => {
  const result = analyzeAIReadableFile('Finance/budget_2026.csv', {
    kind: 'text',
    content: 'budget,revenue,expense,forecast\n120000,240000,110000,250000\n130000,255000,118000,265000',
  })

  assert.equal(result.fileRole, 'spreadsheet')
  assert.equal(result.preferredTitle, 'Budget Report')
  assert.equal(result.preferredCategory, 'Finance')
  assert.match(result.promptContext, /structured data|reporting/i)
})

test('analyzeAIReadableFile infers presentation role and deck guidance', () => {
  const result = analyzeAIReadableFile('Work/Decks/q3_marketing_strategy.txt', {
    kind: 'text',
    content: 'Q3 marketing strategy presentation covering channels, goals, campaign sequencing, and launch risks.',
  })

  assert.equal(result.fileRole, 'presentation')
  assert.equal(result.preferredTitle, 'Marketing Strategy Presentation')
  assert.match(result.promptContext, /slide deck|presentation/i)
})

test('analyzeAIReadableFile labels PPTX files as presentations in prompt context', () => {
  const result = analyzeAIReadableFile('Work/Decks/product_launch_plan.pptx', {
    kind: 'pptx',
    content: 'Product launch presentation covering messaging, rollout phases, launch owners, risks, and success metrics.',
    message: 'Text extracted from PPTX for search and Q&A.',
  })

  assert.equal(result.kind, 'pptx')
  assert.equal(result.fileRole, 'presentation')
  assert.match(result.promptContext, /PPTX presentation/i)
})

test('analyzeAIReadableFile routes finance decks to finance presentations', () => {
  const result = analyzeAIReadableFile('Finance/q3_finance_review.pptx', {
    kind: 'pptx',
    content: 'Quarterly finance presentation covering revenue, expense trends, runway, forecast updates, and budget changes.',
    message: 'Text extracted from PPTX for search and Q&A.',
  })

  assert.equal(result.fileRole, 'presentation')
  assert.equal(result.preferredCategory, 'Finance')
  assert.equal(result.preferredSubcategory, 'Presentations')
  assert.equal(result.preferredTitle, 'Finance Review Presentation')
})

test('analyzeAIReadableFile labels XLSX files as spreadsheets in prompt context', () => {
  const result = analyzeAIReadableFile('Finance/q2_forecast.xlsx', {
    kind: 'xlsx',
    content: 'revenue forecast expense margin quarterly target actual variance hiring budget runway forecast',
    message: 'Text extracted from XLSX for search and Q&A.',
  })

  assert.equal(result.kind, 'xlsx')
  assert.equal(result.fileRole, 'spreadsheet')
  assert.match(result.promptContext, /XLSX spreadsheet/i)
})

test('analyzeAIReadableFile routes KPI workbooks to work reporting', () => {
  const result = analyzeAIReadableFile('Work/reporting/kpi_dashboard.xlsx', {
    kind: 'xlsx',
    content: 'KPI dashboard covering conversion metrics, retention, churn, utilization, and leadership scorecard reporting.',
    message: 'Text extracted from XLSX for search and Q&A.',
  })

  assert.equal(result.fileRole, 'spreadsheet')
  assert.equal(result.preferredCategory, 'Work')
  assert.equal(result.preferredSubcategory, 'Reporting')
  assert.equal(result.preferredTitle, 'KPI Dashboard Metrics Report')
})

test('analyzeAIReadableFile labels CSV files as data files in prompt context', () => {
  const result = analyzeAIReadableFile('Finance/budget_2026.csv', {
    kind: 'csv',
    content: 'budget,revenue,expense,forecast\n120000,240000,110000,250000\n130000,255000,118000,265000',
    message: 'Text extracted from CSV for search and Q&A.',
  })

  assert.equal(result.kind, 'csv')
  assert.equal(result.fileRole, 'spreadsheet')
  assert.match(result.promptContext, /CSV data file/i)
})

test('analyzeAIReadableFile routes statement exports to finance exports', () => {
  const result = analyzeAIReadableFile('Finance/exports/bank_statement_export.csv', {
    kind: 'csv',
    content: 'Raw transaction export with ledger rows, statement balances, download extract, and account history.',
    message: 'Text extracted from CSV for search and Q&A.',
  })

  assert.equal(result.fileRole, 'spreadsheet')
  assert.equal(result.preferredCategory, 'Finance')
  assert.equal(result.preferredSubcategory, 'Exports')
  assert.equal(result.preferredTitle, 'Bank Statement Export')
})

test('analyzePreviewOnlyImageFile routes screenshots to work reference conservatively', () => {
  const result = analyzePreviewOnlyImageFile('Work/UI/system_design_architecture_screenshot.png')

  assert.equal(result.kind, 'image')
  assert.equal(result.fileRole, 'image')
  assert.equal(result.visualKind, 'screenshot')
  assert.equal(result.preferredCategory, 'Work')
  assert.equal(result.preferredSubcategory, 'Reference')
  assert.equal(result.preferredTitle, 'System Design Architecture Screenshot')
  assert.equal(result.conservativeReorganization, true)
  assert.match(result.promptContext, /OCR is not enabled yet/i)
})

test('analyzePreviewOnlyImageFile routes scanned finance images to finance documents', () => {
  const result = analyzePreviewOnlyImageFile('Finance/Scans/bank_statement_march.png')

  assert.equal(result.kind, 'image')
  assert.equal(result.fileRole, 'image')
  assert.equal(result.visualKind, 'scan')
  assert.equal(result.preferredCategory, 'Finance')
  assert.equal(result.preferredSubcategory, 'Documents')
  assert.equal(result.preferredTitle, 'Bank Statement Image')
})

test('analyzePreviewOnlyImageFile recognizes diagrams separately from screenshots', () => {
  const result = analyzePreviewOnlyImageFile('Work/Architecture/api_flow_diagram.png')

  assert.equal(result.kind, 'image')
  assert.equal(result.visualKind, 'diagram')
  assert.match(result.promptContext, /preview-only diagram asset/i)
})

test('analyzePreviewOnlyImageFile recognizes camera-style photos', () => {
  const result = analyzePreviewOnlyImageFile('Personal/Photos/IMG_2455.JPG')

  assert.equal(result.kind, 'image')
  assert.equal(result.visualKind, 'photo')
  assert.match(result.promptContext, /preview-only photo asset/i)
})

test('analyzeAIReadableFile marks OCR-readable screenshots as image assets with OCR mode', () => {
  const result = analyzeAIReadableFile('Work/UI/system_design_architecture_screenshot.png', {
    kind: 'image',
    content: 'System design architecture showing an API gateway, worker queue, database, cache layer, deployment flow, health checks, retry policy, background jobs, request lifecycle, service boundaries, observability hooks, asynchronous processing, cache invalidation strategy, failover routing, rate limiting, background reconciliation, and user-facing request handling across the application stack.',
    message: 'Text extracted from image using local OCR.',
  })

  assert.equal(result.kind, 'image')
  assert.equal(result.fileRole, 'image')
  assert.equal(result.visualAnalysisMode, 'ocr')
  assert.equal(result.conservativeReorganization, false)
  assert.match(result.promptContext, /image asset/i)
})

test('analyzeAIReadableFile keeps weak OCR images conservative', () => {
  const result = analyzeAIReadableFile('Finance/Scans/bank_statement_march.png', {
    kind: 'image',
    content: '03/2026 0012 8821 total 4432',
    message: 'Text extracted from image using local OCR.',
  })

  assert.equal(result.kind, 'image')
  assert.equal(result.visualAnalysisMode, 'ocr')
  assert.equal(result.extractionQuality, 'low')
  assert.equal(result.conservativeReorganization, true)
})
