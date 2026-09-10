// localStorage access that never throws (private browsing or disabled storage): preferences then live in memory only.

export function readStorage(key: string): string | null {
  try {
    return window.localStorage.getItem(key)
  } catch {
    return null
  }
}

export function writeStorage(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value)
  } catch {
    // Storage unavailable: the in-memory React state still applies for this session.
  }
}
