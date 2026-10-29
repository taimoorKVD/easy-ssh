import { createHash, randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { StringDecoder } from 'node:string_decoder'
import { Client, type ClientChannel } from 'ssh2'
import { buildStartupScript } from '../shared/shell'
import type { HostKeyPrompt, SessionErrorCode, SessionStatus } from '../shared/types'
import { Store } from './store'

export interface SessionEvents {
  data(sessionId: string, data: string): void
  status(status: SessionStatus): void
  hostKey(prompt: HostKeyPrompt): void
}

interface PendingHostKey {
  fingerprint: string
  verify: (accept: boolean) => void
}

interface SecretBundle {
  password?: string
  passphrase?: string
}

export function fingerprintSha256(key: Buffer): string {
  const digest = createHash('sha256').update(key).digest('base64').replace(/=+$/g, '')
  return `SHA256:${digest}`
}

function classifyError(error: unknown): { message: string; code: SessionErrorCode } {
  const raw = error instanceof Error ? error.message : String(error)
  const code = error instanceof Error && 'code' in error ? String(error.code) : ''
  const msg = `${code} ${raw}`.toLowerCase()
  if (msg.includes('all configured authentication') || msg.includes('authentication methods failed')) {
    return { code: 'auth', message: 'Authentication failed. Check the username and password or key.' }
  }
  if (msg.includes('passphrase') || msg.includes('cannot parse privatekey') || msg.includes('unsupported key')) {
    return {
      code: 'key',
      message: 'Could not use the private key. The passphrase may be wrong, or the file is not a supported key.'
    }
  }
  if (msg.includes('host key verification') || msg.includes('host key')) {
    return { code: 'hostkey', message: 'Host key was rejected.' }
  }
  if (msg.includes('timed out') || msg.includes('timeout')) {
    return { code: 'timeout', message: 'Timed out while connecting.' }
  }
  if (msg.includes('econnrefused')) {
    return { code: 'network', message: 'Connection refused. Check that sshd is running and the port is right.' }
  }
  if (msg.includes('enotfound') || msg.includes('eai_again')) {
    return { code: 'network', message: 'Could not resolve that host name.' }
  }
  if (msg.includes('enetunreach') || msg.includes('ehostunreach') || msg.includes('econnreset')) {
    return { code: 'network', message: 'The connection to the server was lost.' }
  }
  return { code: 'unknown', message: raw.slice(0, 280) || 'Connection failed.' }
}

class SshSession {
  private client: Client | null = null
  private stream: ClientChannel | null = null
  private phase: 'starting' | 'open' | 'closed' = 'starting'
  private startupSent = false
  private startupTimer: NodeJS.Timeout | null = null
  private pendingInput = ''
  private stdout = new StringDecoder('utf8')
  private stderr = new StringDecoder('utf8')
  cols = 80
  rows = 24
  readonly host: string
  readonly port: number

  constructor(
    readonly sessionId: string,
    private readonly record: {
      host: string
      port: number
      username: string
      authType: 'password' | 'privateKey'
      privateKeyPath: string
      defaultDirectory: string
      startupCommands: string[]
    },
    private readonly secret: SecretBundle,
    private readonly events: SessionEvents,
    private readonly onHostKey: (key: Buffer, verify: (accept: boolean) => void) => void
  ) {
    this.host = record.host
    this.port = record.port
  }

  start(): void {
    if (this.record.authType === 'password' && !this.secret.password) {
      this.emitStatus('error', 'No password is saved for this connection.', 'auth')
      this.phase = 'closed'
      return
    }

    let privateKey: Buffer | undefined
    if (this.record.authType === 'privateKey') {
      if (!this.record.privateKeyPath) {
        this.emitStatus('error', 'Choose a private key file for this connection.', 'key')
        this.phase = 'closed'
        return
      }
      try {
        privateKey = readFileSync(this.record.privateKeyPath)
      } catch {
        this.emitStatus('error', `Could not read the private key at ${this.record.privateKeyPath}.`, 'key')
        this.phase = 'closed'
        return
      }
    }

    const client = new Client()
    this.client = client
    client.on('keyboard-interactive', (_name, _instructions, _lang, prompts, finish) => {
      const answer = this.secret.password ?? ''
      finish(prompts.map(() => answer))
    })
    client.on('banner', (message) => this.emitText(message))
    client.on('greeting', (message) => {
      if (message.trim()) this.emitText(message)
    })
    client.on('ready', () => this.openShell(client))
    client.on('error', (error) => this.fail(error))
    client.on('close', () => {
      if (this.phase !== 'closed') this.finish('disconnected', 'The server closed the connection.')
    })
    client.on('end', () => {
      if (this.phase !== 'closed') this.finish('disconnected', 'The server closed the connection.')
    })

    try {
      client.connect({
        host: this.record.host,
        port: this.record.port,
        username: this.record.username,
        password: this.record.authType === 'password' ? this.secret.password : undefined,
        privateKey,
        passphrase: this.record.authType === 'privateKey' ? this.secret.passphrase : undefined,
        tryKeyboard: this.record.authType === 'password',
        readyTimeout: 120_000,
        keepaliveInterval: 15_000,
        keepaliveCountMax: 4,
        hostVerifier: (key: Buffer | string, verify: (accept: boolean) => void) => {
          if (!Buffer.isBuffer(key)) {
            verify(false)
            return
          }
          this.onHostKey(key, verify)
        }
      })
    } catch (error) {
      this.fail(error)
    }
  }

  write(data: string): void {
    if (this.phase === 'closed') return
    if (this.stream && this.startupSent) this.stream.write(data)
    else this.pendingInput += data
  }

  resize(cols: number, rows: number): void {
    this.cols = Math.max(2, Math.min(500, cols))
    this.rows = Math.max(2, Math.min(200, rows))
    try {
      this.stream?.setWindow(this.rows, this.cols, 0, 0)
    } catch {
      // The channel can close between a resize and the write.
    }
  }

  disconnect(): void {
    this.finish('disconnected', 'Disconnected')
  }

  /** The live SSH client, available once the shell is open. Used for SFTP over the same connection. */
  openClient(): Client | null {
    return this.phase === 'open' ? this.client : null
  }

  isClosed(): boolean {
    return this.phase === 'closed'
  }

  private openShell(client: Client): void {
    if (this.phase === 'closed') return
    try {
      client.shell({ term: 'xterm-256color', cols: this.cols, rows: this.rows }, (error, stream) => {
        if (this.phase === 'closed') {
          stream?.close()
          return
        }
        if (error || !stream) {
          this.fail(error ?? new Error('The server did not open a shell.'))
          return
        }
        this.stream = stream
        this.phase = 'open'
        this.emitStatus('connected', 'Connected')
        this.armStartup(700)
        stream.on('data', (chunk: Buffer) => {
          this.emitData(this.stdout.write(chunk))
          this.armStartup(160)
        })
        const stderr = stream.stderr as NodeJS.ReadableStream
        stderr.on('data', (chunk: Buffer | string) => {
          this.emitData(this.stderr.write(chunk))
        })
        stream.on('close', () => {
          if (this.phase !== 'closed') this.finish('disconnected', 'The shell exited.')
        })
      })
    } catch (error) {
      this.fail(error)
    }
  }

  private armStartup(delay: number): void {
    if (this.startupSent || this.phase === 'closed') return
    if (this.startupTimer) clearTimeout(this.startupTimer)
    this.startupTimer = setTimeout(() => this.sendStartup(), delay)
  }

  private sendStartup(): void {
    if (this.startupSent || !this.stream || this.phase === 'closed') return
    this.startupSent = true
    this.startupTimer = null
    const script = buildStartupScript(this.record.defaultDirectory, this.record.startupCommands)
    if (script) this.stream.write(script)
    if (this.pendingInput) {
      this.stream.write(this.pendingInput)
      this.pendingInput = ''
    }
  }

  private emitText(message: string): void {
    const normalized = message.replace(/\r?\n/g, '\r\n')
    this.emitData(normalized.endsWith('\n') ? normalized : `${normalized}\r\n`)
  }

  private emitData(data: string): void {
    if (!data || this.phase === 'closed') return
    this.events.data(this.sessionId, data)
  }

  private emitStatus(phase: SessionStatus['phase'], message?: string, code?: SessionErrorCode): void {
    this.events.status({ sessionId: this.sessionId, phase, message, code })
  }

  private fail(error: unknown): void {
    const classified = classifyError(error)
    this.finish('error', classified.message, classified.code)
  }

  private finish(phase: 'disconnected' | 'error', message?: string, code?: SessionErrorCode): void {
    if (this.phase === 'closed') return
    this.phase = 'closed'
    if (this.startupTimer) clearTimeout(this.startupTimer)
    this.emitStatus(phase, message, code)
    try {
      this.stream?.close()
    } catch {
      // already closed
    }
    try {
      this.client?.end()
    } catch {
      // already closed
    }
  }
}

export class SessionManager {
  private sessions = new Map<string, SshSession>()
  private pendingHost = new Map<string, PendingHostKey>()

  constructor(
    private readonly store: Store,
    private readonly events: SessionEvents
  ) {}

  async connect(connectionId: string): Promise<string> {
    const record = this.store.get(connectionId)
    if (!record) throw new Error('That connection no longer exists.')
    const secret = await this.store.getSecrets(connectionId)
    const sessionId = randomUUID()
    const session = new SshSession(sessionId, record, secret, this.events, (key, verify) => {
      this.handleHostKey(session, key, verify)
    })
    this.sessions.set(sessionId, session)
    session.start()
    return sessionId
  }

  client(sessionId: string): Client | null {
    return this.sessions.get(sessionId)?.openClient() ?? null
  }

  write(sessionId: string, data: string): void {
    this.sessions.get(sessionId)?.write(data)
  }

  resize(sessionId: string, cols: number, rows: number): void {
    this.sessions.get(sessionId)?.resize(cols, rows)
  }

  disconnect(sessionId: string): void {
    const session = this.sessions.get(sessionId)
    session?.disconnect()
    this.sessions.delete(sessionId)
    const pending = this.pendingHost.get(sessionId)
    if (pending) {
      this.pendingHost.delete(sessionId)
      pending.verify(false)
    }
  }

  disconnectAll(): void {
    for (const sessionId of [...this.sessions.keys()]) this.disconnect(sessionId)
  }

  respondHostKey(sessionId: string, accept: boolean, save: boolean): void {
    const pending = this.pendingHost.get(sessionId)
    if (!pending) return
    this.pendingHost.delete(sessionId)
    const session = this.sessions.get(sessionId)
    if (accept && save && session) this.store.trustHost(session.host, session.port, pending.fingerprint)
    pending.verify(accept)
  }

  private handleHostKey(session: SshSession, key: Buffer, verify: (accept: boolean) => void): void {
    const fingerprint = fingerprintSha256(key)
    const known = this.store.getKnownHost(session.host, session.port)
    if (known?.fingerprint === fingerprint) {
      verify(true)
      return
    }
    if (process.env.EASY_SSH_SMOKE === '1') {
      this.store.trustHost(session.host, session.port, fingerprint)
      verify(true)
      return
    }
    let settled = false
    const finish = (accept: boolean): void => {
      if (settled) return
      settled = true
      verify(accept)
    }
    this.pendingHost.set(session.sessionId, { fingerprint, verify: finish })
    this.events.hostKey({
      sessionId: session.sessionId,
      host: session.host,
      port: session.port,
      fingerprint,
      changed: Boolean(known)
    })
  }
}
