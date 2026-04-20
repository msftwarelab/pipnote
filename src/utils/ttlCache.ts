export interface TtlCacheGetOptions {
  forceRefresh?: boolean
  now?: number
}

export class TtlCache<T> {
  private value: T | null = null
  private expiresAt = 0
  private inFlight: Promise<T> | null = null
  private readonly ttlMs: number

  constructor(ttlMs: number) {
    this.ttlMs = ttlMs
  }

  getFresh(now: number = Date.now()): T | null {
    if (this.value === null) return null
    if (now >= this.expiresAt) return null
    return this.value
  }

  invalidate(): void {
    this.value = null
    this.expiresAt = 0
  }

  set(value: T, now: number = Date.now()): T {
    this.value = value
    this.expiresAt = now + Math.max(1, this.ttlMs)
    return value
  }

  async getOrLoad(loader: () => Promise<T>, options?: TtlCacheGetOptions): Promise<T> {
    const now = options?.now ?? Date.now()
    const forceRefresh = options?.forceRefresh === true

    if (!forceRefresh) {
      const cached = this.getFresh(now)
      if (cached !== null) {
        return cached
      }
    }

    if (this.inFlight) {
      return this.inFlight
    }

    const promise = loader()
      .then((loaded) => this.set(loaded, options?.now ?? Date.now()))
      .finally(() => {
        if (this.inFlight === promise) {
          this.inFlight = null
        }
      })

    this.inFlight = promise
    return promise
  }
}
