import { createContext, useContext, useEffect, useState } from 'react'
import type { ReactNode } from 'react'

export type DefaultEditorViewMode = 'edit' | 'preview' | 'split'
export type EmbeddingQueueSchedulingMode = 'manual' | 'adaptive'

export interface AppSettings {
  defaultEditorViewMode: DefaultEditorViewMode
  defaultReadingMode: boolean
  showQAPanelByDefault: boolean
  showSidebarByDefault: boolean
  showTopBarByDefault: boolean
  pinFavoritesInSidebar: boolean
  pinRecentInSidebar: boolean
  embeddingQueueConcurrency: number
  embeddingQueueSchedulingMode: EmbeddingQueueSchedulingMode
}

interface SettingsContextType {
  settings: AppSettings
  updateSetting: <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => void
  resetSettings: () => void
}

const SETTINGS_KEY = 'vn_app_settings_v1'
const MIN_EMBEDDING_QUEUE_CONCURRENCY = 1
const MAX_EMBEDDING_QUEUE_CONCURRENCY = 4

const DEFAULT_SETTINGS: AppSettings = {
  defaultEditorViewMode: 'edit',
  defaultReadingMode: true,
  showQAPanelByDefault: false,
  showSidebarByDefault: true,
  showTopBarByDefault: true,
  pinFavoritesInSidebar: true,
  pinRecentInSidebar: true,
  embeddingQueueConcurrency: 2,
  embeddingQueueSchedulingMode: 'adaptive',
}

const SettingsContext = createContext<SettingsContextType | undefined>(undefined)

export function SettingsProvider({ children }: { children: ReactNode }) {
  const [settings, setSettings] = useState<AppSettings>(() => {
    try {
      const raw = localStorage.getItem(SETTINGS_KEY)
      if (!raw) return DEFAULT_SETTINGS
      const parsed = JSON.parse(raw) as Partial<AppSettings>
      const parsedConcurrency = Number(parsed.embeddingQueueConcurrency ?? DEFAULT_SETTINGS.embeddingQueueConcurrency)
      const parsedSchedulingMode = parsed.embeddingQueueSchedulingMode === 'manual'
        ? 'manual'
        : 'adaptive'
      return {
        ...DEFAULT_SETTINGS,
        ...parsed,
        embeddingQueueConcurrency: Math.min(
          MAX_EMBEDDING_QUEUE_CONCURRENCY,
          Math.max(
            MIN_EMBEDDING_QUEUE_CONCURRENCY,
            Number.isFinite(parsedConcurrency) ? Math.round(parsedConcurrency) : DEFAULT_SETTINGS.embeddingQueueConcurrency,
          ),
        ),
        embeddingQueueSchedulingMode: parsedSchedulingMode,
      }
    } catch {
      return DEFAULT_SETTINGS
    }
  })

  useEffect(() => {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings))
  }, [settings])

  const updateSetting = <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => {
    setSettings((prev) => ({ ...prev, [key]: value }))
  }

  const resetSettings = () => {
    setSettings(DEFAULT_SETTINGS)
  }

  return (
    <SettingsContext.Provider value={{ settings, updateSetting, resetSettings }}>
      {children}
    </SettingsContext.Provider>
  )
}

export function useSettings() {
  const context = useContext(SettingsContext)
  if (!context) {
    throw new Error('useSettings must be used within a SettingsProvider')
  }
  return context
}
