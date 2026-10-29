export interface ThemePreset {
  id: string
  name: string
  light?: boolean
  accent: string
  bg: string
  raised: string
  overlay: string
  inset: string
  text: string
  dim: string
  faint: string
}

export const THEMES: ThemePreset[] = [
  { id: 'emerald', name: 'Emerald', accent: '#7ee0c6', bg: '#0c0f14', raised: '#141922', overlay: '#1c2430', inset: '#090c11', text: '#e7edf4', dim: '#93a0b3', faint: '#6c7a8c' },
  { id: 'violet', name: 'Violet', accent: '#a78bfa', bg: '#0e0c18', raised: '#161325', overlay: '#211c35', inset: '#0a0812', text: '#ebe7fb', dim: '#9d96b8', faint: '#726b8e' },
  { id: 'ocean', name: 'Ocean', accent: '#60b8ff', bg: '#0a1019', raised: '#111a27', overlay: '#182536', inset: '#070c13', text: '#e5eef8', dim: '#8fa3ba', faint: '#677b92' },
  { id: 'amber', name: 'Amber', accent: '#f5b85a', bg: '#110e0a', raised: '#1a1610', overlay: '#251f17', inset: '#0c0a07', text: '#f3ece2', dim: '#ab9e8c', faint: '#807462' },
  { id: 'rose', name: 'Rose', accent: '#f58ab0', bg: '#120b10', raised: '#1b1218', overlay: '#271a23', inset: '#0d080b', text: '#f6e8ef', dim: '#b096a3', faint: '#856b78' },
  { id: 'paper', name: 'Paper', light: true, accent: '#0f9f7f', bg: '#f6f7f9', raised: '#ffffff', overlay: '#ffffff', inset: '#fbfbfc', text: '#1b2430', dim: '#5b6778', faint: '#8a94a3' }
]

export const HEX_RE = /^#[0-9a-f]{6}$/i

export function hexToRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

function luminance([r, g, b]: [number, number, number]): number {
  const f = (c: number): number => {
    const v = c / 255
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b)
}

export interface ThemeChoice {
  id: string
  accent?: string
}

export function resolveTheme(choice: ThemeChoice | null | undefined): ThemePreset {
  const base = THEMES.find((t) => t.id === choice?.id) ?? THEMES[0]
  const accent = choice?.accent && HEX_RE.test(choice.accent) ? choice.accent.toLowerCase() : base.accent
  return { ...base, accent }
}

export function parseThemeChoice(raw: string | null): ThemeChoice {
  try {
    const v = JSON.parse(raw ?? '') as Record<string, unknown>
    const id = typeof v.id === 'string' && THEMES.some((t) => t.id === v.id) ? v.id : 'emerald'
    const accent = typeof v.accent === 'string' && HEX_RE.test(v.accent) ? v.accent : undefined
    return accent ? { id, accent } : { id }
  } catch {
    return { id: 'emerald' }
  }
}

/** CSS custom properties for a theme. Values are generated from validated hex only. */
export function themeVars(t: ThemePreset): Record<string, string> {
  const rgb = hexToRgb(t.accent).join(', ')
  const ink = luminance(hexToRgb(t.accent)) > 0.35 ? '#0b0f14' : '#ffffff'
  const line = t.light ? '27, 36, 48' : '214, 224, 236'
  return {
    '--bg': t.bg,
    '--bg-raised': t.raised,
    '--bg-overlay': t.overlay,
    '--bg-inset': t.inset,
    '--text': t.text,
    '--text-dim': t.dim,
    '--text-faint': t.faint,
    '--accent': t.accent,
    '--accent-rgb': rgb,
    '--accent-ink': ink,
    '--accent-dim': `rgba(${rgb}, 0.14)`,
    '--line': `rgba(${line}, ${t.light ? 0.1 : 0.08})`,
    '--line-strong': `rgba(${line}, ${t.light ? 0.2 : 0.16})`,
    '--scroll-thumb': `rgba(${rgb}, 0.35)`,
    '--scroll-thumb-hover': `rgba(${rgb}, 0.65)`,
    'color-scheme': t.light ? 'light' : 'dark'
  }
}

export function terminalTheme(t: ThemePreset): Record<string, string> {
  const rgb = hexToRgb(t.accent).join(', ')
  const dark = {
    black: '#1b212b', red: '#ff8b8b', green: '#7ee0c6', yellow: '#f0c36a', blue: '#8eb6ff', magenta: '#d2b4ff', cyan: '#8ad7e8', white: '#d7dee8',
    brightBlack: '#667488', brightRed: '#ffb4b4', brightGreen: '#b6ffe8', brightYellow: '#ffe0a3', brightBlue: '#c5d8ff', brightMagenta: '#ead9ff', brightCyan: '#c6f1f8', brightWhite: '#ffffff'
  }
  const light = {
    black: '#1b2430', red: '#c62f3e', green: '#0f8a6c', yellow: '#a86b00', blue: '#2458c6', magenta: '#8a3fc2', cyan: '#0f7f99', white: '#c9ced6',
    brightBlack: '#5b6778', brightRed: '#e0485a', brightGreen: '#12a882', brightYellow: '#c98500', brightBlue: '#3a72e6', brightMagenta: '#a456de', brightCyan: '#1696b4', brightWhite: '#ffffff'
  }
  return {
    ...(t.light ? light : dark),
    background: t.inset,
    foreground: t.light ? '#1b2430' : '#d7dee8',
    cursor: t.accent,
    cursorAccent: t.inset,
    selectionBackground: `rgba(${rgb}, ${t.light ? 0.25 : 0.28})`
  }
}
