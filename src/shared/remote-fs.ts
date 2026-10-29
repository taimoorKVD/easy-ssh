export type RemoteEntryKind = 'dir' | 'file' | 'link' | 'other'

export interface RemoteEntry {
  name: string
  path: string
  kind: RemoteEntryKind
  /** For symlinks: whether the target is a directory. */
  linkToDir?: boolean
  size: number
  mtime: number
  mode: number
}

export type SortKey = 'name' | 'size' | 'mtime' | 'mode'
export type SortDir = 'asc' | 'desc'

export interface TransferProgress {
  sessionId: string
  transferId: string
  kind: 'upload' | 'download'
  label: string
  bytesDone: number
  bytesTotal: number
  filesDone: number
  filesTotal: number
  state: 'queued' | 'running' | 'done' | 'error' | 'canceled'
  error?: string
  retryable?: boolean
}

export const TEXT_EDIT_LIMIT = 2 * 1024 * 1024

/** Collapse a POSIX path: removes empty, '.' and resolves '..'. Always absolute when input is absolute. */
export function normalizeRemote(input: string): string {
  const absolute = input.startsWith('/')
  const parts: string[] = []
  for (const part of input.split('/')) {
    if (!part || part === '.') continue
    if (part === '..') {
      if (parts.length && parts[parts.length - 1] !== '..') parts.pop()
      else if (!absolute) parts.push('..')
      continue
    }
    parts.push(part)
  }
  const joined = parts.join('/')
  if (absolute) return `/${joined}`
  return joined || '.'
}

export function joinRemote(base: string, ...names: string[]): string {
  let out = base || '/'
  for (const name of names) {
    if (!name) continue
    out = name.startsWith('/') ? name : `${out.replace(/\/+$/, '')}/${name}`
  }
  return normalizeRemote(out)
}

export function parentRemote(path: string): string {
  const normalized = normalizeRemote(path)
  if (normalized === '/') return '/'
  const index = normalized.lastIndexOf('/')
  return index <= 0 ? '/' : normalized.slice(0, index)
}

export function baseNameRemote(path: string): string {
  const normalized = normalizeRemote(path)
  if (normalized === '/') return '/'
  return normalized.slice(normalized.lastIndexOf('/') + 1)
}

export function breadcrumbs(path: string): Array<{ name: string; path: string }> {
  const normalized = normalizeRemote(path)
  const crumbs = [{ name: '/', path: '/' }]
  let current = ''
  for (const part of normalized.split('/').filter(Boolean)) {
    current += `/${part}`
    crumbs.push({ name: part, path: current })
  }
  return crumbs
}

/** A file name the user typed: no slashes, not '.', '..' or empty, no NUL. */
export function validFileName(name: string): string | null {
  const trimmed = name.trim()
  if (!trimmed) return 'Enter a name.'
  if (trimmed === '.' || trimmed === '..') return 'That name is reserved.'
  if (trimmed.includes('/')) return 'Names cannot contain "/".'
  if (trimmed.includes('\0')) return 'Names cannot contain NUL characters.'
  if (trimmed.length > 255) return 'That name is too long.'
  return null
}

export function formatSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—'
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB', 'TB', 'PB']
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${value >= 100 ? value.toFixed(0) : value.toFixed(1)} ${units[unit]}`
}

const S_IFMT = 0o170000
const TYPE_CHARS: Record<number, string> = {
  0o040000: 'd',
  0o120000: 'l',
  0o100000: '-',
  0o020000: 'c',
  0o060000: 'b',
  0o010000: 'p',
  0o140000: 's'
}

export function formatMode(mode: number): string {
  const type = TYPE_CHARS[mode & S_IFMT] ?? '-'
  const bits = 'rwxrwxrwx'
  let out = ''
  for (let i = 0; i < 9; i += 1) out += mode & (1 << (8 - i)) ? bits[i] : '-'
  const chars = out.split('')
  if (mode & 0o4000) chars[2] = chars[2] === 'x' ? 's' : 'S'
  if (mode & 0o2000) chars[5] = chars[5] === 'x' ? 's' : 'S'
  if (mode & 0o1000) chars[8] = chars[8] === 'x' ? 't' : 'T'
  return type + chars.join('')
}

export function octalMode(mode: number): string {
  return (mode & 0o7777).toString(8).padStart(3, '0')
}

/** Parse "755" / "0644" into permission bits, or null when invalid. */
export function parseOctalMode(text: string): number | null {
  const trimmed = text.trim()
  if (!/^[0-7]{3,4}$/.test(trimmed)) return null
  return parseInt(trimmed, 8)
}

export function kindFromMode(mode: number): RemoteEntryKind {
  const type = mode & S_IFMT
  if (type === 0o040000) return 'dir'
  if (type === 0o100000) return 'file'
  if (type === 0o120000) return 'link'
  return 'other'
}

export function isDirLike(entry: RemoteEntry): boolean {
  return entry.kind === 'dir' || (entry.kind === 'link' && Boolean(entry.linkToDir))
}

export function sortEntries(entries: RemoteEntry[], key: SortKey, dir: SortDir): RemoteEntry[] {
  const sign = dir === 'asc' ? 1 : -1
  const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })
  return [...entries].sort((a, b) => {
    const da = isDirLike(a) ? 0 : 1
    const db = isDirLike(b) ? 0 : 1
    if (da !== db) return da - db
    let cmp = 0
    if (key === 'size') cmp = a.size - b.size
    else if (key === 'mtime') cmp = a.mtime - b.mtime
    else if (key === 'mode') cmp = (a.mode & 0o7777) - (b.mode & 0o7777)
    if (cmp === 0) cmp = collator.compare(a.name, b.name)
    return cmp * sign
  })
}

export function filterHidden(entries: RemoteEntry[], showHidden: boolean): RemoteEntry[] {
  return showHidden ? entries : entries.filter((entry) => !entry.name.startsWith('.'))
}

const TEXT_EXT = new Set(
  'txt md markdown log conf cfg ini env json jsonc yaml yml toml xml html htm css scss less js mjs cjs ts tsx jsx php py rb go rs java kt c h cpp hpp cs sh bash zsh fish ps1 sql csv tsv service properties gradle lock gitignore dockerignore editorconfig htaccess vue svelte pl lua r swift dart tf hcl'.split(
    ' '
  )
)
const TEXT_NAMES = new Set(['dockerfile', 'makefile', 'readme', 'license', 'procfile', 'gemfile', 'vagrantfile', 'crontab', 'hosts', 'authorized_keys', 'known_hosts'])

export function isLikelyText(name: string): boolean {
  const lower = name.toLowerCase()
  if (TEXT_NAMES.has(lower)) return true
  if (lower.startsWith('.') && !lower.slice(1).includes('.')) return true
  const dot = lower.lastIndexOf('.')
  if (dot < 0) return false
  return TEXT_EXT.has(lower.slice(dot + 1))
}

/** Toggle/range selection like a desktop file manager. */
export function nextSelection(
  order: string[],
  current: Set<string>,
  anchor: string | null,
  clicked: string,
  mods: { ctrl: boolean; shift: boolean }
): { selected: Set<string>; anchor: string } {
  if (mods.shift && anchor && order.includes(anchor)) {
    const a = order.indexOf(anchor)
    const b = order.indexOf(clicked)
    const [lo, hi] = a < b ? [a, b] : [b, a]
    const range = new Set(order.slice(lo, hi + 1))
    if (mods.ctrl) for (const item of current) range.add(item)
    return { selected: range, anchor }
  }
  if (mods.ctrl) {
    const next = new Set(current)
    if (next.has(clicked)) next.delete(clicked)
    else next.add(clicked)
    return { selected: next, anchor: clicked }
  }
  return { selected: new Set([clicked]), anchor: clicked }
}

export function friendlySftpError(error: unknown, path?: string): string {
  const raw = error instanceof Error ? error.message : String(error)
  const code = error && typeof error === 'object' && 'code' in error ? (error as { code: unknown }).code : undefined
  const where = path ? ` (${path})` : ''
  const lower = raw.toLowerCase()
  if (code === 3 || lower.includes('permission denied')) return `Permission denied${where}.`
  if (code === 2 || lower.includes('no such file')) return `No such file or folder${where}.`
  if (lower.includes('not a directory')) return `Not a folder${where}.`
  if (lower.includes('directory not empty')) return `The folder is not empty${where}.`
  if (lower.includes('file exists') || lower.includes('already exists')) return `Something with that name already exists${where}.`
  if (code === 4 && path) return `The server refused the operation${where}.`
  if (lower.includes('no response') || lower.includes('not connected') || lower.includes('channel')) {
    return 'The SFTP connection was lost. Reconnect the session and try again.'
  }
  if (lower.includes('subsystem')) return 'This server does not offer SFTP, so the file manager is unavailable.'
  return (raw || 'The file operation failed.').slice(0, 280)
}
