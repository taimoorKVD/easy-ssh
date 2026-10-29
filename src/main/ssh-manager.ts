import { createHash, randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { StringDecoder } from 'node:string_decoder'
import { Client, type ClientChannel } from 'ssh2'
import { buildStartupScript } from '../shared/shell'
import type { HostKeyPrompt, SessionErrorCode, SessionStatus } from '../shared/types'
import { Store } from './store'
import { KeyStore } from './key-store'

export interface SessionEvents {
  data(sessionId: string, data: string): void
  status(status: SessionStatus): void
  hostKey(prompt: HostKeyPrompt): void
}

interface PendingHostKey {
  host: string
  port: number
  fingerprint: string
  verify: (accept: boolean) => void
}

interface SecretBundle {
  password?: string
  passphrase?: string
  /** Decrypted managed key (from keys.enc), used instead of a key file. */
  privateKey?: Buffer
}

interface HopRecord {
  host: string
  port: number
  username: string
  authType: 'password' | 'privateKey'
  privateKeyPath: string
}

export interface JumpHop {
  record: HopRecord & { name: string }
  secret: SecretBundle
}

type HostKeyHandler = (key: Buffer, verify: (accept: boolean) => void, host: string, port: number) => void

/** Auth options for one hop, or a user-facing error. */
function authFor(record: HopRecord, secret: SecretBundle): { error: string; code: SessionErrorCode } | { privateKey?: Buffer } {
  if (record.authType === 'password') {
    if (!secret.password) return { error: 'No password is saved for this connection.', code: 'auth' }
    return {}
  }
  if (secret.privateKey) return { privateKey: secret.privateKey }
  if (!record.privateKeyPath) return { error: 'Choose a private key file for this connection.', code: 'key' }
  try {
    return { privateKey: readFileSync(record.privateKeyPath) }
  } catch {
    return { error: `Could not read the private key at ${record.privateKeyPath}.`, code: 'key' }
  }
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
    readonly record: {
      id: string
      host: string
      port: number
      username: string
      authType: 'password' | 'privateKey'
      privateKeyPath: string
      defaultDirectory: string
      startupCommands: string[]
      tmuxSession?: string
    },
    private readonly secret: SecretBundle,
    private readonly events: SessionEvents,
    private readonly onHostKey: HostKeyHandler,
    private readonly jump: JumpHop | null = null
  ) {
    this.host = record.host
    this.port = record.port
  }

  private jumpClient: Client | null = null

  start(): void {
    const auth = authFor(this.record, this.secret)
    if ('error' in auth) {
      this.emitStatus('error', auth.error, auth.code)
      this.phase = 'closed'
      return
    }
    let jumpAuth: { privateKey?: Buffer } | null = null
    if (this.jump) {
      const result = authFor(this.jump.record, this.jump.secret)
      if ('error' in result) {
        this.emitStatus('error', `Jump host ${this.jump.record.name}: ${result.error}`, result.code)
        this.phase = 'closed'
        return
      }
      jumpAuth = result
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
    client.on('connect', () => {
      // Disable Nagle so each keystroke goes out immediately.
      const sock = (client as unknown as { _sock?: { setNoDelay?: (v: boolean) => void } })._sock
      try {
        sock?.setNoDelay?.(true)
      } catch {
        // not a TCP socket
      }
    })
    client.on('error', (error) => this.fail(error))
    client.on('close', () => {
      if (this.phase !== 'closed') this.finish('disconnected', 'The server closed the connection.')
    })
    client.on('end', () => {
      if (this.phase !== 'closed') this.finish('disconnected', 'The server closed the connection.')
    })

    const target = {
      username: this.record.username,
      password: this.record.authType === 'password' ? this.secret.password : undefined,
      privateKey: auth.privateKey,
      passphrase: this.record.authType === 'privateKey' ? this.secret.passphrase : undefined,
      tryKeyboard: this.record.authType === 'password',
      readyTimeout: 120_000,
      keepaliveInterval: 15_000,
      keepaliveCountMax: 4,
      // Every hop's key is checked against easy-ssh's known hosts on its own.
      hostVerifier: this.verifierFor(this.record.host, this.record.port)
    }

    if (!this.jump || !jumpAuth) {
      try {
        client.connect({ ...target, host: this.record.host, port: this.record.port })
      } catch (error) {
        this.fail(error)
      }
      return
    }

    const hop = this.jump
    const jumpClient = new Client()
    this.jumpClient = jumpClient
    this.emitText(`\x1b[2mConnecting through jump host ${hop.record.name} (${hop.record.host})…\x1b[0m`)
    jumpClient.on('keyboard-interactive', (_n, _i, _l, prompts, finish) => finish(prompts.map(() => hop.secret.password ?? '')))
    jumpClient.on('error', (error) => {
      const classified = classifyError(error)
      this.finish('error', `Jump host ${hop.record.name}: ${classified.message}`, classified.code)
    })
    jumpClient.on('close', () => {
      if (this.phase !== 'closed') this.finish('disconnected', `The jump host ${hop.record.name} closed the connection.`)
    })
    jumpClient.on('ready', () => {
      if (this.phase === 'closed') return
      jumpClient.forwardOut('127.0.0.1', 0, this.record.host, this.record.port, (err, stream) => {
        if (this.phase === 'closed') return void stream?.close()
        if (err || !stream) {
          this.finish('error', `The jump host could not reach ${this.record.host}:${this.record.port}. ${err?.message ?? ''}`.trim(), 'network')
          return
        }
        try {
          client.connect({ ...target, sock: stream })
        } catch (error) {
          this.fail(error)
        }
      })
    })
    try {
      jumpClient.connect({
        host: hop.record.host,
        port: hop.record.port,
        username: hop.record.username,
        password: hop.record.authType === 'password' ? hop.secret.password : undefined,
        privateKey: jumpAuth.privateKey,
        passphrase: hop.record.authType === 'privateKey' ? hop.secret.passphrase : undefined,
        tryKeyboard: hop.record.authType === 'password',
        readyTimeout: 120_000,
        keepaliveInterval: 15_000,
        keepaliveCountMax: 4,
        hostVerifier: this.verifierFor(hop.record.host, hop.record.port)
      })
    } catch (error) {
      this.fail(error)
    }
  }

  private verifierFor(host: string, port: number) {
    return (key: Buffer | string, verify: (accept: boolean) => void): void => {
      if (!Buffer.isBuffer(key)) {
        verify(false)
        return
      }
      this.onHostKey(key, verify, host, port)
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
        this.armStartup(350)
        stream.on('data', (chunk: Buffer) => {
          this.emitData(this.stdout.write(chunk))
          this.armStartup(90)
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
    const script = buildStartupScript(this.record.defaultDirectory, this.record.startupCommands, this.record.tmuxSession)
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
    try {
      this.jumpClient?.end()
    } catch {
      // already closed
    }
  }
}

export class SessionManager {
  readonly keys = new KeyStore()
  private sessions = new Map<string, SshSession>()
  private pendingHost = new Map<string, PendingHostKey>()

  constructor(
    private readonly store: Store,
    private readonly events: SessionEvents
  ) {}

  private async secretsFor(record: { id: string; authType: string; keyId?: string }): Promise<SecretBundle> {
    const secret: SecretBundle = await this.store.getSecrets(record.id)
    if (record.authType === 'privateKey' && record.keyId) {
      const material = await this.keys.material(record.keyId)
      secret.privateKey = material.privateKey
      secret.passphrase = material.passphrase
    }
    return secret
  }

  async connect(connectionId: string, plain = false): Promise<string> {
    const saved = this.store.get(connectionId)
    if (!saved) throw new Error('That connection no longer exists.')
    const record = plain ? { ...saved, tmuxSession: undefined } : saved
    const secret = await this.secretsFor(record)
    let jump: JumpHop | null = null
    if (record.jumpHostId) {
      const hop = this.store.get(record.jumpHostId)
      if (!hop) throw new Error('The jump host for this connection was deleted. Edit the connection and pick another.')
      if (hop.id === record.id || hop.jumpHostId) throw new Error('A jump host cannot itself use a jump host.')
      jump = { record: hop, secret: await this.secretsFor(hop) }
    }
    const sessionId = randomUUID()
    const session = new SshSession(
      sessionId,
      record,
      secret,
      this.events,
      (key, verify, host, port) => this.handleHostKey(session, key, verify, host, port),
      jump
    )
    this.sessions.set(sessionId, session)
    session.start()
    return sessionId
  }

  connectionOf(sessionId: string): string | null {
    return this.sessions.get(sessionId)?.record.id ?? null
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
    if (accept && save && this.sessions.has(sessionId)) this.store.trustHost(pending.host, pending.port, pending.fingerprint)
    pending.verify(accept)
  }

  private handleHostKey(session: SshSession, key: Buffer, verify: (accept: boolean) => void, host: string, port: number): void {
    const fingerprint = fingerprintSha256(key)
    const known = this.store.getKnownHost(host, port)
    if (known?.fingerprint === fingerprint) {
      verify(true)
      return
    }
    if (process.env.EASY_SSH_SMOKE === '1') {
      this.store.trustHost(host, port, fingerprint)
      verify(true)
      return
    }
    let settled = false
    const finish = (accept: boolean): void => {
      if (settled) return
      settled = true
      verify(accept)
    }
    this.pendingHost.set(session.sessionId, { host, port, fingerprint, verify: finish })
    this.events.hostKey({
      sessionId: session.sessionId,
      host,
      port,
      fingerprint,
      changed: Boolean(known),
      previousFingerprint: known?.fingerprint
    })
  }
}
