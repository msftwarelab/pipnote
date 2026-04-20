import { createContext, useContext, useState } from 'react'
import type { ReactNode } from 'react'

export interface OpenTab {
  path: string
  name: string
}

interface TabContextType {
  tabs: OpenTab[]
  activeTab: string | null
  openTab: (path: string, name: string) => void
  closeTab: (path: string) => void
  switchTab: (path: string) => void
  closeAllTabs: () => void
}

const TabContext = createContext<TabContextType | undefined>(undefined)

export function TabProvider({ children }: { children: ReactNode }) {
  const [tabs, setTabs] = useState<OpenTab[]>([])
  const [activeTab, setActiveTab] = useState<string | null>(null)

  const openTab = (path: string, name: string) => {
    setTabs((prevTabs) => {
      const exists = prevTabs.find((t) => t.path === path)
      if (exists) {
        setActiveTab(path)
        return prevTabs
      }
      const newTabs = [...prevTabs, { path, name }]
      setActiveTab(path)
      return newTabs
    })
  }

  const closeTab = (path: string) => {
    setTabs((prevTabs) => {
      const newTabs = prevTabs.filter((t) => t.path !== path)
      
      if (activeTab === path) {
        setActiveTab(newTabs.length > 0 ? newTabs[newTabs.length - 1].path : null)
      }
      
      return newTabs
    })
  }

  const switchTab = (path: string) => {
    if (tabs.find((t) => t.path === path)) {
      setActiveTab(path)
    }
  }

  const closeAllTabs = () => {
    setTabs([])
    setActiveTab(null)
  }

  return (
    <TabContext.Provider
      value={{
        tabs,
        activeTab,
        openTab,
        closeTab,
        switchTab,
        closeAllTabs,
      }}
    >
      {children}
    </TabContext.Provider>
  )
}

export function useTab() {
  const context = useContext(TabContext)
  if (!context) {
    throw new Error('useTab must be used within TabProvider')
  }
  return context
}
