export interface ReconnectStatus {
  phase: string
  code?: string
}

export const MAX_RECONNECT_ATTEMPTS = 8

/** Exponential backoff with jitter: ~1s, 2s, 4s, 8s, 16s, then 30s max. */
export function backoffDelay(attempt: number, random: () => number = Math.random): number {
  const base = Math.min(30_000, 1000 * 2 ** Math.max(0, attempt))
  return Math.round(base * (0.8 + random() * 0.4))
}

/** Only network drops on a session that had been up are retried; auth/host-key/key problems never are. */
export function shouldAutoReconnect(status: ReconnectStatus, wasConnected: boolean, attempts: number): boolean {
  if (!wasConnected || attempts >= MAX_RECONNECT_ATTEMPTS) return false
  return status.phase === 'error' && (status.code === 'network' || status.code === 'timeout')
}

export interface RestoredTab {
  connectionId: string
  mode: 'terminal' | 'files'
}

/** Restore state holds only connection ids and modes: never hosts, users, passwords, or output. */
export function parseRestoreState(raw: string | null, knownIds: Set<string>): RestoredTab[] {
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return []
    const out: RestoredTab[] = []
    for (const item of parsed.slice(0, 16)) {
      if (!item || typeof item !== 'object') continue
      const { connectionId, mode } = item as Record<string, unknown>
      if (typeof connectionId !== 'string' || !knownIds.has(connectionId)) continue
      if (out.some((t) => t.connectionId === connectionId)) continue
      out.push({ connectionId, mode: mode === 'files' ? 'files' : 'terminal' })
    }
    return out
  } catch {
    return []
  }
}

export function serializeRestoreState(tabs: Array<{ connectionId: string; mode: 'terminal' | 'files' }>): string {
  return JSON.stringify(tabs.slice(0, 16).map((t) => ({ connectionId: t.connectionId, mode: t.mode })))
}
