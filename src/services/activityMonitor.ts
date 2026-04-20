export type ActivityPressureLevel = 'idle' | 'low' | 'medium' | 'high'

export interface ActivitySnapshot {
  typing: boolean
  pressure: ActivityPressureLevel
  charsPerSecond: number
  charsInWindow: number
  eventsInWindow: number
  lastInputAt: number | null
  updatedAt: number
}

type ActivityListener = (snapshot: ActivitySnapshot) => void

interface ActivityEvent {
  at: number
  chars: number
}

const ACTIVITY_WINDOW_MS = 3_200
const ACTIVITY_IDLE_MS = 1_350
const MAX_EVENTS = 180

function clampChars(value: number): number {
  if (!Number.isFinite(value)) return 1
  return Math.max(1, Math.min(256, Math.round(value)))
}

class ActivityMonitorService {
  private events: ActivityEvent[] = []
  private listeners = new Set<ActivityListener>()
  private idleTimer: number | null = null
  private lastInputAt: number | null = null
  private lastEmittedSignature = ''

  private prune(now: number): void {
    const cutoff = now - ACTIVITY_WINDOW_MS
    if (this.events.length === 0) return
    this.events = this.events.filter((entry) => entry.at >= cutoff).slice(-MAX_EVENTS)
  }

  private computeSnapshot(now = Date.now()): ActivitySnapshot {
    this.prune(now)
    const charsInWindow = this.events.reduce((sum, entry) => sum + entry.chars, 0)
    const eventsInWindow = this.events.length
    const charsPerSecond = charsInWindow / Math.max(0.4, ACTIVITY_WINDOW_MS / 1000)
    const idleForMs = this.lastInputAt ? now - this.lastInputAt : Number.POSITIVE_INFINITY
    const typing = idleForMs <= ACTIVITY_IDLE_MS

    let pressure: ActivityPressureLevel = 'idle'
    if (typing) {
      if (charsPerSecond >= 8) pressure = 'high'
      else if (charsPerSecond >= 4) pressure = 'medium'
      else pressure = 'low'
    }

    return {
      typing,
      pressure,
      charsPerSecond,
      charsInWindow,
      eventsInWindow,
      lastInputAt: this.lastInputAt,
      updatedAt: now,
    }
  }

  private emit(snapshot: ActivitySnapshot): void {
    const signature = `${snapshot.typing}:${snapshot.pressure}:${Math.round(snapshot.charsPerSecond)}:${snapshot.eventsInWindow}`
    if (signature === this.lastEmittedSignature) return
    this.lastEmittedSignature = signature
    this.listeners.forEach((listener) => {
      try {
        listener(snapshot)
      } catch (error) {
        console.warn('⚠️ Activity monitor listener failed:', error)
      }
    })
  }

  private scheduleIdleEmission(): void {
    if (typeof window === 'undefined') return
    if (this.idleTimer) {
      window.clearTimeout(this.idleTimer)
      this.idleTimer = null
    }
    this.idleTimer = window.setTimeout(() => {
      this.idleTimer = null
      this.emit(this.computeSnapshot())
    }, ACTIVITY_IDLE_MS + 40)
  }

  recordTyping(charsChanged = 1): void {
    const now = Date.now()
    this.lastInputAt = now
    this.events.push({
      at: now,
      chars: clampChars(charsChanged),
    })
    this.prune(now)
    this.emit(this.computeSnapshot(now))
    this.scheduleIdleEmission()
  }

  getSnapshot(): ActivitySnapshot {
    return this.computeSnapshot()
  }

  subscribe(listener: ActivityListener, options?: { emitInitial?: boolean }): () => void {
    this.listeners.add(listener)
    if (options?.emitInitial !== false) {
      listener(this.computeSnapshot())
    }
    return () => {
      this.listeners.delete(listener)
    }
  }
}

export const activityMonitorService = new ActivityMonitorService()
