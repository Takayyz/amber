export type Theme = 'light' | 'dark' | 'system'

const STORAGE_KEY = 'amber-theme'
const DARK_QUERY = '(prefers-color-scheme: dark)'

function isTheme(value: unknown): value is Theme {
  return value === 'light' || value === 'dark' || value === 'system'
}

/**
 * The stored preference, or 'system' when none has been made.
 *
 * Reading is guarded: a browser with storage blocked should fall back to
 * following the device rather than failing to start.
 */
export function readTheme(): Theme {
  try {
    const stored: unknown = window.localStorage.getItem(STORAGE_KEY)
    return isTheme(stored) ? stored : 'system'
  } catch {
    return 'system'
  }
}

export function storeTheme(theme: Theme): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, theme)
  } catch {
    // A preference that cannot be saved still applies for this visit.
  }
}

/** Whether `theme` should render dark right now. */
export function resolvesToDark(theme: Theme): boolean {
  if (theme !== 'system') return theme === 'dark'
  return window.matchMedia(DARK_QUERY).matches
}

/**
 * Puts the class the stylesheet keys off (`@custom-variant dark (&:is(.dark
 * *))`) on the root element. Everything else follows from the variables.
 */
export function applyTheme(theme: Theme): void {
  document.documentElement.classList.toggle('dark', resolvesToDark(theme))
}

/**
 * Calls back when the device's own setting changes, so 'system' keeps
 * following it after the page has loaded -- picking it up only at startup
 * would leave a tab open through dusk still showing the daytime theme.
 */
export function watchSystemTheme(onChange: () => void): () => void {
  const query = window.matchMedia(DARK_QUERY)
  query.addEventListener('change', onChange)
  return () => query.removeEventListener('change', onChange)
}
