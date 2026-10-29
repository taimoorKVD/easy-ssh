/** Port forwarding rules. Pure, so the same checks run in the UI and in main. */
export type ForwardType = 'local' | 'remote' | 'dynamic'

export interface ForwardRule {
  id: string
  type: ForwardType
  bindHost: string
  bindPort: number
  destHost: string
  destPort: number
  autoStart: boolean
}

export const MAX_FORWARDS = 20
export const LOOPBACK_HOSTS = ['127.0.0.1', 'localhost', '::1']
export const ALLOWED_BIND_HOSTS = [...LOOPBACK_HOSTS, '0.0.0.0', '::']
const HOST_RE = /^[A-Za-z0-9.\-:_[\]]{1,253}$/
const ID_RE = /^[A-Za-z0-9-]{1,64}$/

/** True when the rule listens on every interface, so other machines can reach it. */
export function isExposed(rule: Pick<ForwardRule, 'bindHost'>): boolean {
  return !LOOPBACK_HOSTS.includes(rule.bindHost)
}

function port(value: unknown, label: string, allowZero = false): number {
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isInteger(n) || n < (allowZero ? 0 : 1) || n > 65535) throw new Error(`${label} must be between 1 and 65535.`)
  return n
}

export function validateForward(raw: unknown): ForwardRule {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new Error('Invalid forwarding rule.')
  const r = raw as Record<string, unknown>
  const type = r.type === 'local' || r.type === 'remote' || r.type === 'dynamic' ? r.type : null
  if (!type) throw new Error('Choose local, remote, or dynamic forwarding.')
  const id = typeof r.id === 'string' && ID_RE.test(r.id) ? r.id : null
  if (!id) throw new Error('Invalid forwarding rule id.')
  const bindHost = typeof r.bindHost === 'string' && r.bindHost.trim() ? r.bindHost.trim() : '127.0.0.1'
  if (!ALLOWED_BIND_HOSTS.includes(bindHost)) throw new Error('Bind address must be 127.0.0.1, localhost, ::1, 0.0.0.0, or ::.')
  const bindPort = port(r.bindPort, 'Listen port')
  let destHost = ''
  let destPort = 0
  if (type !== 'dynamic') {
    destHost = typeof r.destHost === 'string' ? r.destHost.trim() : ''
    if (!HOST_RE.test(destHost)) throw new Error('Enter a valid destination host.')
    destPort = port(r.destPort, 'Destination port')
  }
  return { id, type, bindHost, bindPort, destHost, destPort, autoStart: r.autoStart === true }
}

export function validateForwards(raw: unknown): ForwardRule[] {
  if (raw === undefined || raw === null) return []
  if (!Array.isArray(raw)) throw new Error('Invalid forwarding rules.')
  if (raw.length > MAX_FORWARDS) throw new Error(`At most ${MAX_FORWARDS} forwarding rules per host.`)
  const rules = raw.map(validateForward)
  const seen = new Set<string>()
  for (const rule of rules) {
    if (seen.has(rule.id)) throw new Error('Duplicate forwarding rule.')
    seen.add(rule.id)
  }
  return rules
}

export function describeForward(rule: ForwardRule): string {
  const bind = `${rule.bindHost}:${rule.bindPort}`
  if (rule.type === 'dynamic') return `SOCKS ${bind}`
  if (rule.type === 'local') return `${bind} → ${rule.destHost}:${rule.destPort}`
  return `server ${bind} → ${rule.destHost}:${rule.destPort}`
}

/** Parse a SOCKS5 CONNECT request. Returns null if more bytes are needed; throws on bad input. */
export function parseSocksConnect(buf: Uint8Array): { host: string; port: number; length: number } | null {
  if (buf.length < 5) return null
  if (buf[0] !== 5) throw new Error('Not SOCKS5')
  if (buf[1] !== 1) throw new Error('Only CONNECT is supported')
  const atyp = buf[3]
  let offset = 4
  let host: string
  if (atyp === 1) {
    if (buf.length < offset + 4 + 2) return null
    host = Array.from(buf.slice(offset, offset + 4)).join('.')
    offset += 4
  } else if (atyp === 3) {
    const len = buf[4]
    if (len === 0) throw new Error('Empty host')
    if (buf.length < 5 + len + 2) return null
    host = new TextDecoder().decode(buf.slice(5, 5 + len))
    offset = 5 + len
  } else if (atyp === 4) {
    if (buf.length < offset + 16 + 2) return null
    const parts: string[] = []
    for (let i = 0; i < 16; i += 2) parts.push(((buf[offset + i] << 8) | buf[offset + i + 1]).toString(16))
    host = parts.join(':')
    offset += 16
  } else {
    throw new Error('Bad address type')
  }
  const port = (buf[offset] << 8) | buf[offset + 1]
  return { host, port, length: offset + 2 }
}
