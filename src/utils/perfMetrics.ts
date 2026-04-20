export type PerfMetricName =
  | 'file_open_ms'
  | 'vault_tree_load_ms'
  | 'keyword_search_ms'
  | 'sidebar_related_ms'
  | 'sidebar_backlinks_ms'
  | 'ai_readable_load_ms'
  | 'qa_single_ms'
  | 'qa_multi_ms'
  | 'search_retrieval_ms'
  | 'reorg_analyze_ms'
  | 'regen_all_embeddings_ms'
  | 'regen_stale_embeddings_ms'

interface PerfMetricMeta {
  [key: string]: string | number | boolean | null | undefined
}

const PERF_METRICS_KEY = 'vn_perf_metrics_v1'
const MAX_SAMPLES_PER_METRIC = 180

type PerfStore = Record<string, number[]>
const PERF_METRIC_NAMES: PerfMetricName[] = [
  'file_open_ms',
  'vault_tree_load_ms',
  'keyword_search_ms',
  'sidebar_related_ms',
  'sidebar_backlinks_ms',
  'ai_readable_load_ms',
  'search_retrieval_ms',
  'qa_single_ms',
  'qa_multi_ms',
  'reorg_analyze_ms',
  'regen_all_embeddings_ms',
  'regen_stale_embeddings_ms',
]

let inMemoryStore: PerfStore | null = null

function nowMs(): number {
  if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
    return performance.now()
  }
  return Date.now()
}

function roundMs(value: number): number {
  return Math.round(value * 10) / 10
}

function clampMetricMs(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.max(0, value)
}

function loadStore(): PerfStore {
  if (inMemoryStore) return inMemoryStore
  if (typeof window === 'undefined') {
    inMemoryStore = {}
    return inMemoryStore
  }

  try {
    const raw = window.localStorage.getItem(PERF_METRICS_KEY)
    if (!raw) {
      inMemoryStore = {}
      return inMemoryStore
    }

    const parsed = JSON.parse(raw) as PerfStore
    if (!parsed || typeof parsed !== 'object') {
      inMemoryStore = {}
      return inMemoryStore
    }
    inMemoryStore = parsed
    return inMemoryStore
  } catch {
    inMemoryStore = {}
    return inMemoryStore
  }
}

function persistStore(store: PerfStore): void {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(PERF_METRICS_KEY, JSON.stringify(store))
  } catch {
    // Best-effort telemetry only.
  }
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))
  return sorted[index]
}

function formatMeta(meta?: PerfMetricMeta): string {
  if (!meta) return ''
  const parts = Object.entries(meta)
    .filter(([, value]) => value !== undefined && value !== null)
    .map(([key, value]) => `${key}=${value}`)
  if (parts.length === 0) return ''
  return ` ${parts.join(' ')}`
}

export function startPerfTimer(): number {
  return nowMs()
}

export function recordPerfMetric(name: PerfMetricName, startTime: number, meta?: PerfMetricMeta): void {
  const elapsedMs = clampMetricMs(nowMs() - startTime)
  const store = loadStore()
  const existing = Array.isArray(store[name]) ? store[name] : []
  const samples = [...existing, elapsedMs].slice(-MAX_SAMPLES_PER_METRIC)
  store[name] = samples
  inMemoryStore = store
  persistStore(store)

  const sorted = [...samples].sort((a, b) => a - b)
  const p50 = percentile(sorted, 50)
  const p95 = percentile(sorted, 95)

  console.log(
    `[perf] ${name} run=${roundMs(elapsedMs)}ms p50=${roundMs(p50)}ms p95=${roundMs(p95)}ms n=${samples.length}${formatMeta(meta)}`,
  )
}

export interface PerfMetricSummary {
  name: PerfMetricName
  count: number
  lastMs: number
  p50Ms: number
  p95Ms: number
  meanMs: number
}

export function getPerfMetricSummaries(): PerfMetricSummary[] {
  const store = loadStore()
  return PERF_METRIC_NAMES.map((name) => {
    const samplesRaw = Array.isArray(store[name]) ? store[name] : []
    const samples = samplesRaw
      .map((value) => clampMetricMs(Number(value)))
      .filter((value) => Number.isFinite(value))
    if (samples.length === 0) {
      return {
        name,
        count: 0,
        lastMs: 0,
        p50Ms: 0,
        p95Ms: 0,
        meanMs: 0,
      }
    }

    const sorted = [...samples].sort((a, b) => a - b)
    const total = samples.reduce((sum, value) => sum + value, 0)
    return {
      name,
      count: samples.length,
      lastMs: roundMs(samples[samples.length - 1]),
      p50Ms: roundMs(percentile(sorted, 50)),
      p95Ms: roundMs(percentile(sorted, 95)),
      meanMs: roundMs(total / samples.length),
    }
  })
}

export function clearPerfMetrics(): void {
  inMemoryStore = {}
  if (typeof window === 'undefined') return
  try {
    window.localStorage.removeItem(PERF_METRICS_KEY)
  } catch {
    // Best-effort cleanup only.
  }
}
