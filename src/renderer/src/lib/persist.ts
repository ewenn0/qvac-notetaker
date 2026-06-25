/**
 * Tiny typed wrapper around `localStorage` for persisting UI preferences
 * across app launches (model selections, summary rules, STT language, …).
 *
 * Everything is best-effort: a corrupt or unavailable store never throws, it
 * just falls back to the provided default so the app still boots cleanly.
 */

const PREFIX = 'qvac-notetaker:'

export function loadSetting<T>(key: string, fallback: T): T {
  try {
    const raw = window.localStorage.getItem(PREFIX + key)
    if (raw == null) return fallback
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}

export function saveSetting<T>(key: string, value: T): void {
  try {
    window.localStorage.setItem(PREFIX + key, JSON.stringify(value))
  } catch {
    /* storage full / unavailable — non-fatal, the setting just won't persist */
  }
}
