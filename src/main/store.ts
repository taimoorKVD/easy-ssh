import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { app, safeStorage } from 'electron'
import { splitStartupCommands } from '../shared/shell'
import { validateForwards, type ForwardRule } from '../shared/forwards'
import type { AuthType, ConnectionInput, ConnectionPublic, ExportBundle } from '../shared/types'

const SECRET_NOTE =
  'Ciphertext from Electron safeStorage. The key lives in the OS keychain (Windows DPAPI, macOS Keychain, or libsecret). This file is not usable on its own.'

interface StoredConnection {
  id: string
  name: string
  host: string
  port: number
  username: string
  authType: AuthType
  privateKeyPath: string
  defaultDirectory: string
  startupCommands: string[]
  group: string
  forwards?: ForwardRule[]
  jumpHostId?: string
  keyId?: string
  tags?: string[]
  favorite?: boolean
  tmuxSession?: string
  createdAt: string
  updatedAt: string
}

interface SecretItem {
  password?: string
  passphrase?: string
}

interface SecretFile {
  version: 1
  note: string
  items: Record<string, SecretItem>
}

interface KnownHost {
  host: string
  port: number
  fingerprint: string
  trustedAt: string
}

interface ConnectionFile {
  version: 1
  connections: StoredConnection[]
}

export interface EncryptionStatus {
  available: boolean
  backend: string
  reason?: string
}

export function dataDir(): string {
  const dir = app.getPath('userData')
  mkdirSync(dir, { recursive: true })
  return dir
}

export function writePrivate(path: string, contents: string): void {
  const tmp = `${path}.${process.pid}.tmp`
  writeFileSync(tmp, contents, { encoding: 'utf8', mode: 0o600 })
  try {
    chmodSync(tmp, 0o600)
  } catch {
    // Windows does not use POSIX modes.
  }
  renameSync(tmp, path)
}

function readJsonFile<T>(path: string): T | null {
  if (!existsSync(path)) return null
  const raw = readFileSync(path, 'utf8')
  try {
    return JSON.parse(raw) as T
  } catch {
    throw new Error(`Could not read ${path}. It is not valid JSON, so easy-ssh left it untouched.`)
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export async function encryptionStatus(): Promise<EncryptionStatus> {
  const available = await Promise.race([
    safeStorage.isAsyncEncryptionAvailable(),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 8000))
  ])
  let backend = 'os-keychain'
  if (process.platform === 'linux') backend = safeStorage.getSelectedStorageBackend()
  else if (process.platform === 'win32') backend = 'dpapi'
  else if (process.platform === 'darwin') backend = 'keychain'

  if (backend === 'basic_text') {
    return {
      available: false,
      backend,
      reason:
        'The OS keychain is unavailable, so passwords cannot be saved. On Linux, unlock a secret service such as gnome-keyring and restart easy-ssh.'
    }
  }
  if (!available) {
    return {
      available: false,
      backend,
      reason:
        process.platform === 'linux'
          ? 'libsecret has no unlocked keyring. Start gnome-keyring (or another secret service) and restart easy-ssh.'
          : 'The OS keychain is not available, so passwords cannot be saved.'
    }
  }
  return { available: true, backend }
}

export class Store {
  private connections: StoredConnection[]
  private secrets: SecretFile
  private knownHosts: KnownHost[]
  private queue: Promise<unknown> = Promise.resolve()

  constructor() {
    this.connections = this.loadConnections()
    this.secrets = this.loadSecrets()
    this.knownHosts = this.loadKnownHosts()
  }

  list(): ConnectionPublic[] {
    return this.connections.map((connection) => this.toPublic(connection))
  }

  get(id: string): StoredConnection | null {
    return this.connections.find((connection) => connection.id === id) ?? null
  }

  dataDirectory(): string {
    return dataDir()
  }

  async getSecrets(id: string): Promise<{ password?: string; passphrase?: string }> {
    return this.enqueue(async () => {
      const item = this.secrets.items[id]
      if (!item) return {}
      const password = await this.decryptField(id, 'password', item.password)
      const passphrase = await this.decryptField(id, 'passphrase', item.passphrase)
      return { password, passphrase }
    })
  }

  async save(input: ConnectionInput): Promise<ConnectionPublic> {
    return this.enqueue(async () => {
      const normalized = normalizeInput(input)
      const existing = normalized.id ? this.connections.find((connection) => connection.id === normalized.id) : undefined
      if (normalized.id && !existing) throw new Error('That connection no longer exists.')

      const id = existing?.id ?? randomUUID()
      const previous = this.secrets.items[id] ?? {}
      const nextSecrets: SecretItem = { ...previous }

      if (input.clearPassword) delete nextSecrets.password
      if (input.clearPassphrase) delete nextSecrets.passphrase
      if (typeof input.password === 'string' && input.password.length > 0) {
        nextSecrets.password = await this.encrypt(input.password)
      }
      if (typeof input.passphrase === 'string' && input.passphrase.length > 0) {
        nextSecrets.passphrase = await this.encrypt(input.passphrase)
      }

      if (normalized.authType === 'password' && !nextSecrets.password) {
        throw new Error('Enter a password. It is stored in the OS keychain, not in the connections file.')
      }
      const keyId = normalized.authType === 'privateKey' && typeof input.keyId === 'string' && /^[0-9a-f-]{8,80}$/i.test(input.keyId) ? input.keyId : undefined
      if (normalized.authType === 'privateKey' && !normalized.privateKeyPath && !keyId) {
        throw new Error('Choose a private key file or a saved key.')
      }

      const now = new Date().toISOString()
      const record: StoredConnection = {
        id,
        name: normalized.name,
        host: normalized.host,
        port: normalized.port,
        username: normalized.username,
        authType: normalized.authType,
        privateKeyPath: normalized.privateKeyPath,
        defaultDirectory: normalized.defaultDirectory,
        startupCommands: normalized.startupCommands,
        group: normalized.group,
        jumpHostId: this.checkJump(id, input.jumpHostId),
        keyId,
        tags: input.tags === undefined ? existing?.tags ?? [] : normalizeTags(input.tags),
        tmuxSession: normalizeTmux(input.tmuxSession),
        favorite: input.favorite === undefined ? existing?.favorite ?? false : input.favorite === true,
        forwards: input.forwards === undefined ? existing?.forwards ?? [] : validateForwards(input.forwards),
        createdAt: existing?.createdAt ?? now,
        updatedAt: now
      }

      if (nextSecrets.password || nextSecrets.passphrase) this.secrets.items[id] = nextSecrets
      else delete this.secrets.items[id]

      if (existing) {
        this.connections = this.connections.map((connection) => (connection.id === id ? record : connection))
      } else {
        this.connections.push(record)
      }
      this.flushConnections()
      this.flushSecrets()
      return this.toPublic(record)
    })
  }

  async setSecret(id: string, secret: { password?: string; passphrase?: string }): Promise<void> {
    return this.enqueue(async () => {
      const existing = this.connections.find((connection) => connection.id === id)
      if (!existing) throw new Error('That connection no longer exists.')
      const next: SecretItem = { ...(this.secrets.items[id] ?? {}) }
      if (typeof secret.password === 'string') {
        if (secret.password.length === 0) throw new Error('Enter a password.')
        if (secret.password.length > 1024) throw new Error('Password is too long.')
        next.password = await this.encrypt(secret.password)
      }
      if (typeof secret.passphrase === 'string') {
        if (secret.passphrase.length === 0) throw new Error('Enter a passphrase.')
        if (secret.passphrase.length > 1024) throw new Error('Passphrase is too long.')
        next.passphrase = await this.encrypt(secret.passphrase)
      }
      this.secrets.items[id] = next
      this.flushSecrets()
    })
  }

  private checkJump(id: string, raw: unknown): string | undefined {
    if (raw === undefined || raw === null || raw === '') return undefined
    if (typeof raw !== 'string' || !/^[0-9a-f-]{8,80}$/i.test(raw)) throw new Error('Invalid jump host.')
    if (raw === id) throw new Error('A connection cannot be its own jump host.')
    const hop = this.connections.find((c) => c.id === raw)
    if (!hop) throw new Error('That jump host no longer exists.')
    if (hop.jumpHostId) throw new Error('Pick a jump host that connects directly (it cannot use a jump host itself).')
    if (this.connections.some((c) => c.jumpHostId === id)) throw new Error('Other connections use this one as their jump host, so it must connect directly.')
    return raw
  }

  async setForwards(id: string, raw: unknown): Promise<ConnectionPublic> {
    return this.enqueue(async () => {
      const existing = this.connections.find((connection) => connection.id === id)
      if (!existing) throw new Error('That connection no longer exists.')
      existing.forwards = validateForwards(raw)
      existing.updatedAt = new Date().toISOString()
      this.flushConnections()
      return this.toPublic(existing)
    })
  }

  async setMeta(id: string, meta: unknown): Promise<ConnectionPublic> {
    return this.enqueue(async () => {
      const existing = this.connections.find((connection) => connection.id === id)
      if (!existing) throw new Error('That connection no longer exists.')
      if (!isRecord(meta)) throw new Error('Invalid update.')
      if ('favorite' in meta) existing.favorite = meta.favorite === true
      if ('tags' in meta) existing.tags = normalizeTags(meta.tags)
      this.flushConnections()
      return this.toPublic(existing)
    })
  }

  async remove(id: string): Promise<void> {
    return this.enqueue(async () => {
      this.connections = this.connections.filter((connection) => connection.id !== id)
      for (const c of this.connections) if (c.jumpHostId === id) delete c.jumpHostId
      delete this.secrets.items[id]
      this.flushConnections()
      this.flushSecrets()
    })
  }

  exportBundle(): ExportBundle {
    return {
      kind: 'easy-ssh-connections',
      version: 1,
      exportedAt: new Date().toISOString(),
      connections: this.connections.map((connection) => ({
        id: connection.id,
        name: connection.name,
        host: connection.host,
        port: connection.port,
        username: connection.username,
        authType: connection.authType,
        privateKeyPath: connection.privateKeyPath || undefined,
        defaultDirectory: connection.defaultDirectory || undefined,
        startupCommands: connection.startupCommands.length ? connection.startupCommands : undefined,
        group: connection.group || undefined,
        tags: connection.tags?.length ? connection.tags : undefined,
        favorite: connection.favorite || undefined,
        tmuxSession: connection.tmuxSession || undefined
      }))
    }
  }

  async importBundle(raw: unknown): Promise<{ imported: number; skipped: number }> {
    return this.enqueue(async () => {
      const entries = parseImportEntries(raw)
      let imported = 0
      let skipped = 0
      const now = new Date().toISOString()
      for (const entry of entries) {
        const normalized = tryNormalizeImport(entry)
        if (!normalized) {
          skipped += 1
          continue
        }
        const duplicate = this.connections.some(
          (connection) =>
            connection.name.toLowerCase() === normalized.name.toLowerCase() &&
            connection.host.toLowerCase() === normalized.host.toLowerCase() &&
            connection.port === normalized.port &&
            connection.username === normalized.username
        )
        if (duplicate) {
          skipped += 1
          continue
        }
        this.connections.push({
          id: randomUUID(),
          ...normalized,
          createdAt: now,
          updatedAt: now
        })
        imported += 1
      }
      let linked = false
      // Resolve ProxyJump aliases (from ~/.ssh/config) to direct-connecting saved hosts.
      for (const entry of entries) {
        if (!isRecord(entry) || typeof entry.proxyJump !== 'string' || typeof entry.name !== 'string') continue
        const target = this.connections.find((c) => c.name === entry.name && !c.jumpHostId)
        const hop = this.connections.find((c) => c.name === entry.proxyJump && !c.jumpHostId)
        if (!target || !hop || hop.id === target.id) continue
        if (this.connections.some((c) => c.jumpHostId === target.id)) continue
        target.jumpHostId = hop.id
        linked = true
      }
      if (imported > 0 || linked) this.flushConnections()
      return { imported, skipped }
    })
  }

  getKnownHost(host: string, port: number): KnownHost | null {
    const key = host.toLowerCase()
    return this.knownHosts.find((item) => item.host.toLowerCase() === key && item.port === port) ?? null
  }

  trustHost(host: string, port: number, fingerprint: string): void {
    const next: KnownHost = { host, port, fingerprint, trustedAt: new Date().toISOString() }
    const key = host.toLowerCase()
    const index = this.knownHosts.findIndex((item) => item.host.toLowerCase() === key && item.port === port)
    if (index >= 0) this.knownHosts[index] = next
    else this.knownHosts.push(next)
    this.flushKnownHosts()
  }

  private toPublic(connection: StoredConnection): ConnectionPublic {
    const item = this.secrets.items[connection.id]
    return {
      ...connection,
      forwards: connection.forwards ?? [],
      tags: connection.tags ?? [],
      favorite: connection.favorite === true,
      hasPassword: Boolean(item?.password),
      hasPassphrase: Boolean(item?.passphrase)
    }
  }

  private async encrypt(plain: string): Promise<string> {
    const status = await encryptionStatus()
    if (!status.available) throw new Error(status.reason ?? 'OS keychain is not available.')
    const encrypted = await safeStorage.encryptStringAsync(plain)
    return Buffer.from(encrypted).toString('base64')
  }

  private async decryptField(
    id: string,
    field: 'password' | 'passphrase',
    ciphertext: string | undefined
  ): Promise<string | undefined> {
    if (!ciphertext) return undefined
    let decoded: Buffer
    try {
      decoded = Buffer.from(ciphertext, 'base64')
    } catch {
      throw new Error('Saved secret could not be read.')
    }
    const status = await encryptionStatus()
    if (!status.available) throw new Error(status.reason ?? 'OS keychain is not available.')
    const decrypted = await safeStorage.decryptStringAsync(decoded)
    if (decrypted.shouldReEncrypt) {
      const refreshed = await safeStorage.encryptStringAsync(decrypted.result)
      const item = this.secrets.items[id]
      if (item) {
        item[field] = Buffer.from(refreshed).toString('base64')
        this.flushSecrets()
      }
    }
    return decrypted.result
  }

  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(task, task)
    this.queue = run.then(
      () => undefined,
      () => undefined
    )
    return run
  }

  private loadConnections(): StoredConnection[] {
    const file = readJsonFile<ConnectionFile>(join(dataDir(), 'connections.json'))
    if (!file) return []
    if (!file.connections || !Array.isArray(file.connections)) {
      throw new Error('connections.json is missing a connections list.')
    }
    return file.connections.filter((item) => item && typeof item.id === 'string' && typeof item.host === 'string')
  }

  private loadSecrets(): SecretFile {
    const file = readJsonFile<SecretFile>(join(dataDir(), 'secrets.bin.json'))
    if (!file) return { version: 1, note: SECRET_NOTE, items: {} }
    if (!isRecord(file.items)) return { version: 1, note: SECRET_NOTE, items: {} }
    return { version: 1, note: SECRET_NOTE, items: file.items }
  }

  private loadKnownHosts(): KnownHost[] {
    const file = readJsonFile<{ hosts?: KnownHost[] }>(join(dataDir(), 'known-hosts.json'))
    if (!file?.hosts || !Array.isArray(file.hosts)) return []
    return file.hosts.filter((item) => item && typeof item.host === 'string' && typeof item.fingerprint === 'string')
  }

  private flushConnections(): void {
    const payload: ConnectionFile = { version: 1, connections: this.connections }
    writePrivate(join(dataDir(), 'connections.json'), `${JSON.stringify(payload, null, 2)}\n`)
  }

  private flushSecrets(): void {
    this.secrets.note = SECRET_NOTE
    this.secrets.version = 1
    writePrivate(join(dataDir(), 'secrets.bin.json'), `${JSON.stringify(this.secrets, null, 2)}\n`)
  }

  private flushKnownHosts(): void {
    writePrivate(
      join(dataDir(), 'known-hosts.json'),
      `${JSON.stringify({ version: 1, hosts: this.knownHosts }, null, 2)}\n`
    )
  }
}

function normalizeInput(input: ConnectionInput): Omit<StoredConnection, 'id' | 'createdAt' | 'updatedAt'> & { id?: string } {
  const name = requiredText(input.name, 'Name', 80)
  const host = normalizeHost(requiredText(input.host, 'Host', 253))
  const username = requiredText(input.username, 'Username', 128)
  if (/\s/.test(username)) throw new Error('Username cannot contain spaces.')
  const port = normalizePort(input.port)
  const authType = input.authType === 'privateKey' ? 'privateKey' : input.authType === 'password' ? 'password' : null
  if (!authType) throw new Error('Choose password or private key authentication.')
  const privateKeyPath = (input.privateKeyPath ?? '').trim().slice(0, 1000)
  const defaultDirectory = (input.defaultDirectory ?? '').trim().slice(0, 400)
  const group = (input.group ?? '').trim().slice(0, 40)
  const startupCommands = splitStartupCommands(input.startupCommands).map((line) => line.slice(0, 500))
  if (typeof input.password === 'string' && input.password.length > 1024) throw new Error('Password is too long.')
  if (typeof input.passphrase === 'string' && input.passphrase.length > 1024) {
    throw new Error('Passphrase is too long.')
  }
  return {
    id: input.id,
    name,
    host,
    port,
    username,
    authType,
    privateKeyPath,
    defaultDirectory,
    startupCommands,
    group
  }
}

function requiredText(value: unknown, label: string, max: number): string {
  if (typeof value !== 'string') throw new Error(`${label} is required.`)
  const trimmed = value.trim()
  if (!trimmed) throw new Error(`${label} is required.`)
  if (trimmed.length > max) throw new Error(`${label} is too long.`)
  return trimmed
}

function normalizeHost(host: string): string {
  if (/^ssh\b/i.test(host) || host.includes('@') || host.includes(' ')) {
    throw new Error('Enter only the host. Put the user and port in their own fields.')
  }
  const withPort = /^([^:]+):(\d+)$/.exec(host)
  if (withPort) throw new Error('Put the port in the port field, not after the host.')
  if (host.startsWith('[') && host.endsWith(']')) return host.slice(1, -1)
  return host
}

function normalizePort(value: unknown): number {
  const port = typeof value === 'number' ? value : Number(value)
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Port must be between 1 and 65535.')
  return port
}

function parseImportEntries(raw: unknown): unknown[] {
  if (Array.isArray(raw)) return raw
  if (!isRecord(raw)) throw new Error('That file is not an easy-ssh export.')
  if ('version' in raw && raw.version !== 1 && raw.version !== undefined) {
    throw new Error('This export is from a newer easy-ssh and cannot be imported.')
  }
  if (!Array.isArray(raw.connections)) throw new Error('That file does not contain a connections list.')
  return raw.connections
}

function tryNormalizeImport(entry: unknown): Omit<StoredConnection, 'id' | 'createdAt' | 'updatedAt'> | null {
  if (!isRecord(entry)) return null
  try {
    const normalized = normalizeInput({
      name: String(entry.name ?? ''),
      host: String(entry.host ?? ''),
      port: Number(entry.port ?? 22),
      username: String(entry.username ?? ''),
      authType: entry.authType === 'privateKey' ? 'privateKey' : 'password',
      privateKeyPath: typeof entry.privateKeyPath === 'string' ? entry.privateKeyPath : '',
      defaultDirectory: typeof entry.defaultDirectory === 'string' ? entry.defaultDirectory : '',
      startupCommands: Array.isArray(entry.startupCommands)
        ? entry.startupCommands.filter((line): line is string => typeof line === 'string')
        : typeof entry.startupCommands === 'string'
          ? entry.startupCommands
          : [],
      group: typeof entry.group === 'string' ? entry.group : ''
    })
    if (normalized.authType === 'privateKey' && !normalized.privateKeyPath) return null
    return {
      name: normalized.name,
      host: normalized.host,
      port: normalized.port,
      username: normalized.username,
      authType: normalized.authType,
      privateKeyPath: normalized.privateKeyPath,
      defaultDirectory: normalized.defaultDirectory,
      startupCommands: normalized.startupCommands,
      group: normalized.group,
      tags: normalizeTags(entry.tags),
      tmuxSession: normalizeTmux(entry.tmuxSession),
      favorite: entry.favorite === true
    }
  } catch {
    return null
  }
}

export function normalizeTags(raw: unknown): string[] {
  if (!Array.isArray(raw)) return []
  const out: string[] = []
  for (const t of raw) {
    if (typeof t !== 'string') continue
    const tag = t.trim().toLowerCase().replace(/^#/, '')
    if (/^[a-z0-9_.-]{1,24}$/.test(tag) && !out.includes(tag)) out.push(tag)
    if (out.length >= 10) break
  }
  return out
}

function normalizeTmux(raw: unknown): string | undefined {
  if (raw === undefined || raw === null || raw === '') return undefined
  if (typeof raw !== 'string' || !/^[A-Za-z0-9_.-]{1,40}$/.test(raw.trim())) {
    throw new Error('tmux session names may use letters, numbers, dot, dash and underscore (up to 40).')
  }
  return raw.trim()
}
