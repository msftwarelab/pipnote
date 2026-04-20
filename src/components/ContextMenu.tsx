import { useEffect, useLayoutEffect, useRef } from 'react'
import { createPortal } from 'react-dom'

export interface ContextMenuItem {
  label: string
  icon?: React.ReactNode
  onClick: () => void
  danger?: boolean
  separator?: boolean
  disabled?: boolean
}

interface ContextMenuProps {
  x: number
  y: number
  items: ContextMenuItem[]
  onClose: () => void
}

function ContextMenu({ x, y, items, onClose }: ContextMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null)
  const MENU_MARGIN = 8

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        onClose()
      }
    }

    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onClose()
      }
    }

    document.addEventListener('mousedown', handleClickOutside)
    document.addEventListener('keydown', handleEscape)

    return () => {
      document.removeEventListener('mousedown', handleClickOutside)
      document.removeEventListener('keydown', handleEscape)
    }
  }, [onClose])

  // Adjust position if menu would go off-screen
  useLayoutEffect(() => {
    if (menuRef.current) {
      const rect = menuRef.current.getBoundingClientRect()
      const viewportWidth = window.innerWidth
      const viewportHeight = window.innerHeight

      let adjustedX = x
      let adjustedY = y

      if (rect.right > viewportWidth) {
        adjustedX = viewportWidth - rect.width - MENU_MARGIN
      }

      // Native-like behavior: if menu would overflow bottom, open upward from cursor.
      if (y + rect.height > viewportHeight - MENU_MARGIN) {
        adjustedY = y - rect.height
      }

      if (adjustedX < MENU_MARGIN) adjustedX = MENU_MARGIN
      if (adjustedY < MENU_MARGIN) {
        adjustedY = viewportHeight - rect.height - MENU_MARGIN
      }
      if (adjustedY < MENU_MARGIN) adjustedY = MENU_MARGIN

      menuRef.current.style.left = `${adjustedX}px`
      menuRef.current.style.top = `${adjustedY}px`
    }
  }, [x, y, items.length])

  const menu = (
    <div
      ref={menuRef}
      className="fixed z-[120] bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg shadow-2xl py-1 min-w-[180px] max-h-[calc(100vh-16px)] overflow-y-auto"
      style={{ left: x, top: y }}
    >
      {items.map((item, index) => {
        if (item.separator) {
          return (
            <div
              key={index}
              className="h-px bg-gray-200 dark:bg-gray-700 my-1"
            />
          )
        }

        return (
          <button
            key={index}
            disabled={item.disabled}
            onClick={(e) => {
              if (item.disabled) return
              e.preventDefault()
              e.stopPropagation()
              onClose()
              setTimeout(() => {
                item.onClick()
              }, 50)
            }}
            className={`w-full flex items-center gap-3 px-4 py-2 text-sm text-left transition-colors ${
              item.disabled
                ? 'text-gray-400 dark:text-gray-600 cursor-not-allowed'
                : item.danger
                ? 'text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20'
                : 'text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700'
            }`}
          >
            {item.icon && <span className="w-4 h-4 flex-shrink-0">{item.icon}</span>}
            <span>{item.label}</span>
          </button>
        )
      })}
    </div>
  )

  return createPortal(menu, document.body)
}

export default ContextMenu
