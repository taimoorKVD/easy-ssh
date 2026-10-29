import { parseThemeChoice, resolveTheme, terminalTheme, themeVars, type ThemeChoice, type ThemePreset } from '@shared/theme'

const KEY = 'easy-ssh.theme.v1'
let current: ThemePreset = resolveTheme(parseThemeChoice(localStorage.getItem(KEY)))
const listeners = new Set<(t: ThemePreset) => void>()
let animTimer: ReturnType<typeof setTimeout> | undefined

function paint(t: ThemePreset, animate: boolean): void {
  const root = document.documentElement
  if (animate) {
    root.classList.add('theme-anim')
    clearTimeout(animTimer)
    animTimer = setTimeout(() => root.classList.remove('theme-anim'), 380)
  }
  for (const [k, v] of Object.entries(themeVars(t))) {
    if (k === 'color-scheme') root.style.colorScheme = v
    else root.style.setProperty(k, v)
  }
  for (const fn of listeners) fn(t)
}

export function getTheme(): ThemePreset {
  return current
}
export function getXtermTheme(t: ThemePreset = current): Record<string, string> {
  return terminalTheme(t)
}
export function onThemeChange(fn: (t: ThemePreset) => void): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}
/** Temporarily show a theme (hover preview) without saving it. */
export function previewTheme(choice: ThemeChoice | null): void {
  paint(choice ? resolveTheme(choice) : current, true)
}
export function setTheme(choice: ThemeChoice): void {
  current = resolveTheme(choice)
  localStorage.setItem(KEY, JSON.stringify(choice))
  paint(current, true)
}
export function savedChoice(): ThemeChoice {
  return parseThemeChoice(localStorage.getItem(KEY))
}
export function initTheme(): void {
  paint(current, false)
}
