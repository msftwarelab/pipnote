import { createContext, useContext, useEffect, useState } from 'react'
import type { ReactNode } from 'react'

export type ThemeMode = 'light' | 'dark'
export type ThemeFamily = 'cobalt' | 'noir' | 'linen' | 'forge' | 'obsidian' | 'codex'

export interface ThemeFamilyOption {
  id: ThemeFamily
  name: string
  tagline: string
  insight: string
}

const THEME_FAMILY_OPTIONS: ThemeFamilyOption[] = [
  {
    id: 'cobalt',
    name: 'Cobalt Flow',
    tagline: 'Current Pipnote look',
    insight: 'Blue-forward, high-clarity product UI.',
  },
  {
    id: 'noir',
    name: 'Noir Carbon',
    tagline: 'Black-first premium',
    insight: 'Quiet power with restrained mint accents.',
  },
  {
    id: 'linen',
    name: 'Linen Glow',
    tagline: 'Off-white calm',
    insight: 'Warm, trustworthy tones inspired by quiet-luxury AI branding.',
  },
  {
    id: 'forge',
    name: 'Forge Nova',
    tagline: 'Bold builder energy',
    insight: 'High-contrast dark industrial palette with vivid signal highlights.',
  },
  {
    id: 'obsidian',
    name: 'Obsidian Mist',
    tagline: 'Minimal dark craftsmanship',
    insight: 'Muted graphite layers, low-noise borders, and typography-first reading focus.',
  },
  {
    id: 'codex',
    name: 'Codex Graphite',
    tagline: 'Jet black studio',
    insight: 'Deep graphite canvas with restrained electric-blue signals and calm contrast.',
  },
]

interface ThemeContextType {
  theme: ThemeMode
  mode: ThemeMode
  family: ThemeFamily
  themeFamilies: ThemeFamilyOption[]
  toggleTheme: () => void
  setMode: (mode: ThemeMode) => void
  setFamily: (family: ThemeFamily) => void
}

const ThemeContext = createContext<ThemeContextType | undefined>(undefined)
const LEGACY_THEME_KEY = 'pipnote-theme'
const THEME_MODE_KEY = 'pipnote-theme-mode'
const THEME_FAMILY_KEY = 'pipnote-theme-family'

function getInitialMode(): ThemeMode {
  const storedMode = localStorage.getItem(THEME_MODE_KEY)
  if (storedMode === 'light' || storedMode === 'dark') return storedMode

  const legacyMode = localStorage.getItem(LEGACY_THEME_KEY)
  if (legacyMode === 'light' || legacyMode === 'dark') return legacyMode

  if (window.matchMedia('(prefers-color-scheme: dark)').matches) return 'dark'
  return 'light'
}

function getInitialFamily(): ThemeFamily {
  const storedFamily = localStorage.getItem(THEME_FAMILY_KEY)
  if (storedFamily && THEME_FAMILY_OPTIONS.some((option) => option.id === storedFamily)) {
    return storedFamily as ThemeFamily
  }
  return 'obsidian'
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [mode, setMode] = useState<ThemeMode>(() => getInitialMode())
  const [family, setFamily] = useState<ThemeFamily>(() => getInitialFamily())

  useEffect(() => {
    const root = document.documentElement
    root.classList.toggle('dark', mode === 'dark')
    root.setAttribute('data-pipnote-theme-family', family)
    root.setAttribute('data-pipnote-theme-mode', mode)

    localStorage.setItem(LEGACY_THEME_KEY, mode)
    localStorage.setItem(THEME_MODE_KEY, mode)
    localStorage.setItem(THEME_FAMILY_KEY, family)
  }, [family, mode])

  const toggleTheme = () => {
    setMode((prev) => (prev === 'light' ? 'dark' : 'light'))
  }

  return (
    <ThemeContext.Provider
      value={{
        theme: mode,
        mode,
        family,
        themeFamilies: THEME_FAMILY_OPTIONS,
        toggleTheme,
        setMode,
        setFamily,
      }}
    >
      {children}
    </ThemeContext.Provider>
  )
}

export function useTheme() {
  const context = useContext(ThemeContext)
  if (context === undefined) {
    throw new Error('useTheme must be used within a ThemeProvider')
  }
  return context
}
