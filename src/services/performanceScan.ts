import { getPerfMetricSummaries, type PerfMetricName, type PerfMetricSummary } from '../utils/perfMetrics'
import { isAiReadableNotePath, getLowerExtension } from '../utils/noteScope'
import { vaultService, type TreeNode } from './vault'

export type PerformanceSeverity = 'good' | 'watch' | 'slow'

export interface PerformanceOperationResult {
  key: string
  label: string
  runs: number
  avgMs: number
  maxMs: number
  severity: PerformanceSeverity
}

export interface PerformanceBottleneck {
  key: string
  label: string
  observedMs: number
  thresholdMs: number
  severity: PerformanceSeverity
  source: 'scan' | 'live'
}

export interface PerformanceScanReport {
  scannedAt: string
  fileCount: number
  folderCount: number
  sampleTextFiles: number
  sampleAiDocs: number
  sampleQueries: number
  operations: PerformanceOperationResult[]
  bottlenecks: PerformanceBottleneck[]
  recommendations: string[]
}

function now(): number {
  if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
    return performance.now()
  }
  return Date.now()
}

function roundMs(value: number): number {
  return Math.round(value * 10) / 10
}

function measureSeverity(value: number, watchThreshold: number, slowThreshold: number): PerformanceSeverity {
  if (value >= slowThreshold) return 'slow'
  if (value >= watchThreshold) return 'watch'
  return 'good'
}

function flattenTree(nodes: TreeNode[]): { files: string[]; folders: number } {
  const files: string[] = []
  let folders = 0

  const walk = (items: TreeNode[]) => {
    for (const node of items) {
      if (node.type === 'file') {
        files.push(node.path)
      } else {
        folders += 1
        walk(node.children)
      }
    }
  }

  walk(nodes)
  return { files, folders }
}

function sampleQueries(paths: string[], limit: number): string[] {
  const tokenSet = new Set<string>()

  for (const path of paths) {
    const baseName = path.split('/').pop() || path
    const stem = baseName.replace(/\.[^.]+$/, '')
    const tokens = stem.match(/[a-z0-9]{3,}/gi) || []
    for (const token of tokens) {
      tokenSet.add(token.toLowerCase())
      if (tokenSet.size >= limit) {
        return Array.from(tokenSet)
      }
    }
  }

  return Array.from(tokenSet)
}

function summarizeOperation(key: string, label: string, samples: number[], watchThreshold: number, slowThreshold: number): PerformanceOperationResult {
  const runs = samples.length
  const maxMs = runs > 0 ? Math.max(...samples) : 0
  const avgMs = runs > 0 ? samples.reduce((sum, value) => sum + value, 0) / runs : 0

  return {
    key,
    label,
    runs,
    avgMs: roundMs(avgMs),
    maxMs: roundMs(maxMs),
    severity: measureSeverity(maxMs, watchThreshold, slowThreshold),
  }
}

const LIVE_THRESHOLDS: Record<PerfMetricName, { watch: number; slow: number; label: string }> = {
  file_open_ms: { watch: 120, slow: 260, label: 'File Open' },
  vault_tree_load_ms: { watch: 120, slow: 280, label: 'Vault Tree Load' },
  keyword_search_ms: { watch: 160, slow: 320, label: 'Keyword Search' },
  sidebar_related_ms: { watch: 180, slow: 360, label: 'Related Notes Sidebar' },
  sidebar_backlinks_ms: { watch: 180, slow: 360, label: 'Backlinks Sidebar' },
  ai_readable_load_ms: { watch: 260, slow: 550, label: 'AI Document Load' },
  search_retrieval_ms: { watch: 220, slow: 480, label: 'Search Retrieval' },
  qa_single_ms: { watch: 2400, slow: 5200, label: 'Q&A (Single)' },
  qa_multi_ms: { watch: 3200, slow: 7000, label: 'Q&A (Multi)' },
  reorg_analyze_ms: { watch: 4500, slow: 9000, label: 'Vault Analyze' },
  regen_all_embeddings_ms: { watch: 10_000, slow: 25_000, label: 'Embed Regenerate (All)' },
  regen_stale_embeddings_ms: { watch: 6_000, slow: 16_000, label: 'Embed Regenerate (Stale)' },
}

function deriveLiveBottlenecks(summaries: PerfMetricSummary[]): PerformanceBottleneck[] {
  return summaries
    .filter((summary) => summary.count > 0)
    .map((summary) => {
      const threshold = LIVE_THRESHOLDS[summary.name]
      return {
        key: summary.name,
        label: threshold.label,
        observedMs: summary.p95Ms,
        thresholdMs: threshold.watch,
        severity: measureSeverity(summary.p95Ms, threshold.watch, threshold.slow),
        source: 'live' as const,
      }
    })
    .filter((item) => item.severity !== 'good')
    .sort((a, b) => b.observedMs - a.observedMs)
    .slice(0, 5)
}

function deriveRecommendations(scanOps: PerformanceOperationResult[], bottlenecks: PerformanceBottleneck[]): string[] {
  const notes: string[] = []

  const treeOp = scanOps.find((item) => item.key === 'scan_tree_load')
  if (treeOp?.severity !== 'good') {
    notes.push('Vault tree loading is trending slow. Keep folder structures collapsed where possible and avoid triggering many file operations back-to-back.')
  }

  const textOp = scanOps.find((item) => item.key === 'scan_text_read')
  if (textOp?.severity === 'slow') {
    notes.push('Text note reads are slower than expected. The new neighbor prefetch should help, but large notes in the same folder may still need trimming or splitting.')
  }

  const docOp = scanOps.find((item) => item.key === 'scan_ai_doc_read')
  if (docOp?.severity !== 'good') {
    notes.push('AI document extraction is a hotspot. Keep very large PDFs, DOCX, PPTX, XLSX, and CSV files to a minimum in active workflows or open them once so the cache can warm.')
  }

  const searchOp = scanOps.find((item) => item.key === 'scan_keyword_search')
  if (searchOp?.severity !== 'good') {
    notes.push('Keyword search is a current bottleneck. Favor narrower searches and let the query cache warm while we continue tightening the search path.')
  }

  const liveQa = bottlenecks.find((item) => item.key === 'qa_multi_ms' || item.key === 'qa_single_ms')
  if (liveQa) {
    notes.push('Q&A p95 is one of the slower live paths. The main remaining cost is model inference time, so faster local models or smaller context windows will help most.')
  }

  if (notes.length === 0) {
    notes.push('The sampled vault paths look healthy right now. Use the live perf strip while editing/searching to catch real-world spikes as they happen.')
  }

  return notes.slice(0, 4)
}

export const performanceScanService = {
  async run(onProgress?: (current: number, total: number, label: string) => void): Promise<PerformanceScanReport> {
    const treeLoadSamples: number[] = []
    const textReadSamples: number[] = []
    const aiDocSamples: number[] = []
    const keywordSearchSamples: number[] = []

    const totalSteps = 1 + 2 + 6 + 3 + 6
    let currentStep = 0
    const step = (label: string) => {
      currentStep += 1
      onProgress?.(currentStep, totalSteps, label)
    }

    step('Loading vault tree')
    let startTime = now()
    const tree = await vaultService.getVaultTree({ forceRefresh: true })
    treeLoadSamples.push(now() - startTime)

    step('Reloading vault tree from cache')
    startTime = now()
    await vaultService.getVaultTree()
    treeLoadSamples.push(now() - startTime)

    step('Reloading vault tree again')
    startTime = now()
    await vaultService.getVaultTree()
    treeLoadSamples.push(now() - startTime)

    const flattened = flattenTree(tree)
    const aiReadableFiles = flattened.files.filter((path) => isAiReadableNotePath(path))
    const textFiles = aiReadableFiles.filter((path) => {
      const ext = getLowerExtension(path)
      return !['pdf', 'docx', 'pptx', 'xlsx', 'csv'].includes(ext)
    })
    const docFiles = aiReadableFiles.filter((path) => {
      const ext = getLowerExtension(path)
      return ['pdf', 'docx', 'pptx', 'xlsx', 'csv'].includes(ext)
    })

    const sampledTextFiles = textFiles.slice(0, 6)
    const sampledDocFiles = docFiles.slice(0, 3)
    const sampledQueries = sampleQueries(flattened.files, 6)

    for (const path of sampledTextFiles) {
      step(`Reading ${path.split('/').pop() || path}`)
      startTime = now()
      await vaultService.readFile(path)
      textReadSamples.push(now() - startTime)
    }

    for (const path of sampledDocFiles) {
      step(`Extracting ${path.split('/').pop() || path}`)
      startTime = now()
      await vaultService.readFileForAI(path)
      aiDocSamples.push(now() - startTime)
    }

    for (const query of sampledQueries) {
      step(`Searching "${query}"`)
      startTime = now()
      await vaultService.searchNotes(query, 20)
      keywordSearchSamples.push(now() - startTime)
    }

    const operations: PerformanceOperationResult[] = [
      summarizeOperation('scan_tree_load', 'Vault tree load', treeLoadSamples, 120, 280),
      summarizeOperation('scan_text_read', 'Text note read', textReadSamples, 80, 180),
      summarizeOperation('scan_ai_doc_read', 'AI document read', aiDocSamples, 260, 550),
      summarizeOperation('scan_keyword_search', 'Keyword search', keywordSearchSamples, 140, 320),
    ]

    const scanBottlenecks: PerformanceBottleneck[] = operations
      .filter((item) => item.severity !== 'good')
      .map((item) => ({
        key: item.key,
        label: item.label,
        observedMs: item.maxMs,
        thresholdMs:
          item.key === 'scan_tree_load' ? 120
            : item.key === 'scan_text_read' ? 80
              : item.key === 'scan_ai_doc_read' ? 260
                : 140,
        severity: item.severity,
        source: 'scan' as const,
      }))

    const liveBottlenecks = deriveLiveBottlenecks(getPerfMetricSummaries())
    const mergedBottlenecks = [...scanBottlenecks, ...liveBottlenecks]
      .sort((a, b) => b.observedMs - a.observedMs)
      .slice(0, 6)

    return {
      scannedAt: new Date().toISOString(),
      fileCount: flattened.files.length,
      folderCount: flattened.folders,
      sampleTextFiles: sampledTextFiles.length,
      sampleAiDocs: sampledDocFiles.length,
      sampleQueries: sampledQueries.length,
      operations,
      bottlenecks: mergedBottlenecks,
      recommendations: deriveRecommendations(operations, liveBottlenecks),
    }
  },
}
