const RECENT_NOTES_KEY = 'vn_recent_notes_v1'
const FAVORITE_NOTES_KEY = 'vn_favorite_notes_v1'
const NOTE_COLLECTIONS_CHANGED_EVENT = 'vn:note-collections-changed'

function readList(key: string): string[] {
  try {
    const raw = localStorage.getItem(key)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
  } catch {
    return []
  }
}

function writeList(key: string, items: string[]): void {
  localStorage.setItem(key, JSON.stringify(items))
  window.dispatchEvent(new Event(NOTE_COLLECTIONS_CHANGED_EVENT))
}

function listsEqual(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((item, index) => item === b[index])
}

export const noteCollectionsService = {
  changedEvent: NOTE_COLLECTIONS_CHANGED_EVENT,

  getRecentNotes(): string[] {
    return readList(RECENT_NOTES_KEY)
  },

  touchRecent(path: string): void {
    if (!path) return
    const current = readList(RECENT_NOTES_KEY)
    const prev = current.filter((item) => item !== path)
    const next = [path, ...prev].slice(0, 5)
    if (listsEqual(current, next)) return
    writeList(RECENT_NOTES_KEY, next)
  },

  clearRecent(): void {
    writeList(RECENT_NOTES_KEY, [])
  },

  removeRecent(path: string): void {
    if (!path) return
    const prev = readList(RECENT_NOTES_KEY)
    writeList(RECENT_NOTES_KEY, prev.filter((item) => item !== path))
  },

  getFavoriteNotes(): string[] {
    return readList(FAVORITE_NOTES_KEY)
  },

  isFavorite(path: string): boolean {
    if (!path) return false
    return readList(FAVORITE_NOTES_KEY).includes(path)
  },

  addFavorite(path: string): void {
    if (!path) return
    const prev = readList(FAVORITE_NOTES_KEY)
    if (prev.includes(path)) return
    writeList(FAVORITE_NOTES_KEY, [path, ...prev])
  },

  removeFavorite(path: string): void {
    if (!path) return
    const prev = readList(FAVORITE_NOTES_KEY)
    const next = prev.filter((item) => item !== path)
    if (listsEqual(prev, next)) return
    writeList(FAVORITE_NOTES_KEY, next)
  },

  pruneMissing(validPaths: Iterable<string>): void {
    const validSet = new Set(validPaths)
    const nextRecent = readList(RECENT_NOTES_KEY).filter((item) => validSet.has(item))
    const nextFavorites = readList(FAVORITE_NOTES_KEY).filter((item) => validSet.has(item))
    const currentRecent = readList(RECENT_NOTES_KEY)
    const currentFavorites = readList(FAVORITE_NOTES_KEY)

    const recentChanged = nextRecent.length !== currentRecent.length
      || nextRecent.some((item, index) => item !== currentRecent[index])
    const favoritesChanged = nextFavorites.length !== currentFavorites.length
      || nextFavorites.some((item, index) => item !== currentFavorites[index])

    if (!recentChanged && !favoritesChanged) {
      return
    }

    localStorage.setItem(RECENT_NOTES_KEY, JSON.stringify(nextRecent))
    localStorage.setItem(FAVORITE_NOTES_KEY, JSON.stringify(nextFavorites))
    window.dispatchEvent(new Event(NOTE_COLLECTIONS_CHANGED_EVENT))
  },

  toggleFavorite(path: string): boolean {
    if (!path) return false
    const currentlyFavorite = this.isFavorite(path)
    if (currentlyFavorite) {
      this.removeFavorite(path)
      return false
    }
    this.addFavorite(path)
    return true
  },
}
