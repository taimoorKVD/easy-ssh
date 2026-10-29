/** Pure update state machine shared by main (driver) and renderer (view). No Node or DOM imports. */
export type UpdatePhase = 'idle' | 'checking' | 'available' | 'downloading' | 'ready' | 'uptodate' | 'error'

export interface UpdateState {
  phase: UpdatePhase
  current: string
  version?: string
  notes?: string
  percent?: number
  error?: string
  /** True when the user asked (palette/menu); only then show "up to date" and errors. */
  manual: boolean
  /** Whether the renderer should show the popup at all. */
  visible: boolean
}

export type UpdateEvent =
  | { type: 'check'; manual: boolean }
  | { type: 'available'; version: string; notes?: string }
  | { type: 'none' }
  | { type: 'progress'; percent: number }
  | { type: 'downloaded'; version: string }
  | { type: 'error'; message: string }
  | { type: 'dismiss' }

export const VERSION_RE = /^\d{1,4}\.\d{1,4}\.\d{1,6}$/

/** Compare plain x.y.z versions. Returns >0 when a is newer. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number)
  const pb = b.split('.').map(Number)
  for (let i = 0; i < 3; i += 1) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0)
  return 0
}

export function initialUpdateState(current: string): UpdateState {
  return { phase: 'idle', current, manual: false, visible: false }
}

/** Release notes from GitHub arrive as HTML or markdown; keep a short plain-text summary. */
export function summarizeNotes(raw: unknown): string | undefined {
  const text = Array.isArray(raw) ? raw.map((n) => (n && typeof n === 'object' ? String((n as { note?: unknown }).note ?? '') : '')).join('\n') : typeof raw === 'string' ? raw : ''
  const plain = text
    .replace(/<[^>]*>/g, ' ')
    .replace(/&[a-z#0-9]+;/gi, ' ')
    .replace(/[#*_`>]+/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  if (!plain) return undefined
  return plain.length > 280 ? `${plain.slice(0, 277)}…` : plain
}

export function friendlyUpdateError(message: string): string {
  const m = message.toLowerCase()
  if (/enotfound|eai_again|err_internet_disconnected|err_name_not_resolved|enetunreach|econnrefused|etimedout|socket hang up|network/.test(m)) {
    return "Couldn't reach GitHub to check for updates. Check your internet connection and try again."
  }
  if (/404|latest\.yml|no published versions|cannot find/.test(m)) return 'No published release was found yet.'
  if (/sha512|checksum|signature/.test(m)) return 'The downloaded update failed its integrity check and was discarded.'
  if (/rate limit|403/.test(m)) return 'GitHub is rate-limiting update checks. Try again later.'
  return 'The update check failed. Try again later.'
}

/**
 * Reducer. `snoozed` is the version the user chose "Later" for; automatic checks stay quiet about it.
 * Downgrades and same-version offers are ignored.
 */
export function reduceUpdate(state: UpdateState, event: UpdateEvent, snoozed?: string): UpdateState {
  switch (event.type) {
    case 'check':
      if (state.phase === 'downloading' || state.phase === 'ready') return { ...state, manual: state.manual || event.manual, visible: state.visible || event.manual }
      return { phase: 'checking', current: state.current, manual: event.manual, visible: event.manual }
    case 'available': {
      if (!VERSION_RE.test(event.version) || compareVersions(event.version, state.current) <= 0) {
        return { ...state, phase: 'uptodate', version: undefined, visible: state.manual }
      }
      const quiet = !state.manual && snoozed === event.version
      return { ...state, phase: 'available', version: event.version, notes: summarizeNotes(event.notes), visible: !quiet }
    }
    case 'none':
      return { ...state, phase: 'uptodate', visible: state.manual }
    case 'progress':
      return { ...state, phase: 'downloading', percent: Math.max(0, Math.min(100, Math.round(event.percent))) }
    case 'downloaded':
      return { ...state, phase: 'ready', percent: 100, version: event.version, visible: !(snoozed === event.version && !state.manual) }
    case 'error':
      // A failed background check never pops up; a failed download or manual check does.
      return { ...state, phase: 'error', error: friendlyUpdateError(event.message), visible: state.manual || state.phase === 'downloading' }
    case 'dismiss':
      return { ...state, visible: false, manual: false }
  }
}
