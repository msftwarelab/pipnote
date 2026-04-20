import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { ThemeProvider } from './contexts/ThemeContext.tsx'
import { SettingsProvider } from './contexts/SettingsContext.tsx'

async function bootstrap() {
  const url = new URL(window.location.href)
  const isE2E = url.searchParams.get('e2e') === '1'
  if (isE2E) {
    const { installE2EMocks } = await import('./testing/mockTauri.ts')
    await installE2EMocks()
  }

  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <ThemeProvider>
        <SettingsProvider>
          <App />
        </SettingsProvider>
      </ThemeProvider>
    </StrictMode>,
  )
}

void bootstrap()
