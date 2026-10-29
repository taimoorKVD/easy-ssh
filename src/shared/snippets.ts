// Kept local (same as shell.ts) so this file has no imports and runs under node's type stripping.
function shSingleQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

export interface Snippet {
  id: string
  name: string
  command: string
  /** null = global; otherwise only offered for this connection id. */
  connectionId: string | null
  updatedAt: number
}

export interface SnippetInput {
  id?: string
  name: string
  command: string
  connectionId: string | null
}

export interface Placeholder {
  name: string
  raw: boolean
}

const PLACEHOLDER = /\{\{\s*([a-zA-Z_][a-zA-Z0-9_-]{0,39})(:raw)?\s*\}\}/g

/** Unique placeholders in order of first use. `{{name:raw}}` inserts unquoted text. */
export function parsePlaceholders(command: string): Placeholder[] {
  const seen = new Map<string, Placeholder>()
  for (const match of command.matchAll(PLACEHOLDER)) {
    const name = match[1]
    const existing = seen.get(name)
    if (!existing) seen.set(name, { name, raw: Boolean(match[2]) })
    else if (!match[2]) existing.raw = false
  }
  return [...seen.values()]
}

/**
 * Fill placeholders. Values are single-quoted for the shell by default so a value
 * can never inject extra commands; only `{{x:raw}}` opts out.
 */
export function fillPlaceholders(command: string, values: Record<string, string>): string {
  return command.replace(PLACEHOLDER, (_all, name: string, raw?: string) => {
    const value = (values[name] ?? '').replace(/[\r\n]/g, ' ')
    return raw ? value : shSingleQuote(value)
  })
}

/** Text to type into the terminal: newlines become Enter. */
export function toTerminalInput(command: string): string {
  const lines = command.split(/\r?\n/).map((l) => l.trimEnd()).filter((l) => l.length > 0)
  return lines.length ? `${lines.join('\r')}\r` : ''
}

export function validateSnippet(input: unknown): SnippetInput {
  if (!input || typeof input !== 'object') throw new Error('Invalid snippet.')
  const body = input as Record<string, unknown>
  const name = typeof body.name === 'string' ? body.name.trim() : ''
  const command = typeof body.command === 'string' ? body.command.replace(/\r\n/g, '\n').trim() : ''
  if (!name || name.length > 80) throw new Error('Give the snippet a name (up to 80 characters).')
  if (!command || command.length > 8000) throw new Error('Enter a command (up to 8000 characters).')
  const idRe = /^[0-9a-f-]{8,80}$/i
  const id = typeof body.id === 'string' && idRe.test(body.id) ? body.id : undefined
  const connectionId = typeof body.connectionId === 'string' && idRe.test(body.connectionId) ? body.connectionId : null
  return { id, name, command, connectionId }
}

/** Simple fuzzy score: all query chars in order; higher is better, -1 = no match. */
export function fuzzyScore(query: string, text: string): number {
  const q = query.toLowerCase().trim()
  if (!q) return 0
  const t = text.toLowerCase()
  if (t.includes(q)) return 1000 - t.indexOf(q)
  let ti = 0
  let score = 0
  for (const ch of q) {
    if (ch === ' ') continue
    const found = t.indexOf(ch, ti)
    if (found < 0) return -1
    score += found === ti ? 5 : 1
    ti = found + 1
  }
  return score
}
