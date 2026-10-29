// Parser for OpenSSH client config (~/.ssh/config). Self-contained so tests can import it directly.
// Only the fields easy-ssh understands are read; nothing secret ever lives in this file.

export interface SshConfigEntry {
  name: string
  host: string
  port: number
  username: string
  authType: 'password' | 'privateKey'
  privateKeyPath: string
  proxyJump?: string
  group: string
}

const ALIAS_RE = /^[A-Za-z0-9_.@:-]{1,80}$/
const MAX_BYTES = 512 * 1024

function expandHome(path: string, home: string): string {
  if (path === '~') return home
  if (path.startsWith('~/') || path.startsWith('~\\')) return home.replace(/[\\/]+$/, '') + path.slice(1)
  return path
}

function splitLine(line: string): [string, string] | null {
  const m = /^\s*([A-Za-z]+)\s*(?:=\s*|\s+)(.*?)\s*$/.exec(line)
  if (!m) return null
  let value = m[2]
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1)
  return [m[1].toLowerCase(), value]
}

export function parseSshConfig(text: string, home: string): SshConfigEntry[] {
  if (text.length > MAX_BYTES) throw new Error('That ssh config is too large to import.')
  const blocks: { aliases: string[]; opts: Map<string, string> }[] = []
  let current: { aliases: string[]; opts: Map<string, string> } | null = null
  let inMatch = false
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/(^|\s)#.*$/, '')
    if (!line.trim()) continue
    const kv = splitLine(line)
    if (!kv) continue
    const [key, value] = kv
    if (key === 'host') {
      inMatch = false
      const aliases = value.split(/\s+/).filter((a) => a && !/[*?!]/.test(a) && ALIAS_RE.test(a))
      current = { aliases, opts: new Map() }
      blocks.push(current)
      continue
    }
    if (key === 'match') {
      inMatch = true
      current = null
      continue
    }
    if (inMatch || !current) continue
    // First value wins, as in OpenSSH.
    if (!current.opts.has(key)) current.opts.set(key, value)
  }

  const out: SshConfigEntry[] = []
  const seen = new Set<string>()
  for (const block of blocks) {
    for (const alias of block.aliases) {
      const key = alias.toLowerCase()
      if (seen.has(key)) continue
      seen.add(key)
      const o = block.opts
      const host = (o.get('hostname') ?? alias).replace(/%h/g, alias)
      if (!/^[A-Za-z0-9_.:-]{1,253}$/.test(host)) continue
      const port = Number(o.get('port') ?? 22)
      const identity = o.get('identityfile')
      const jump = o.get('proxyjump')
      out.push({
        name: alias,
        host,
        port: Number.isInteger(port) && port > 0 && port < 65536 ? port : 22,
        username: (o.get('user') ?? '').slice(0, 64),
        authType: identity ? 'privateKey' : 'password',
        privateKeyPath: identity ? expandHome(identity, home) : '',
        proxyJump: jump && jump.toLowerCase() !== 'none' ? jump.split(',')[0].trim() : undefined,
        group: 'ssh config'
      })
    }
  }
  return out
}
