import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { SessionStatus } from '../shared/types'
import type { SessionManager } from './ssh-manager'
import { encryptionStatus, type Store } from './store'

interface Transcript {
  text: string
  status?: SessionStatus
}

const transcripts = new Map<string, Transcript>()

export function recordSmokeData(sessionId: string, data: string): void {
  const row = transcripts.get(sessionId) ?? { text: '' }
  row.text += data
  transcripts.set(sessionId, row)
}

export function recordSmokeStatus(status: SessionStatus): void {
  const row = transcripts.get(status.sessionId) ?? { text: '' }
  row.status = status
  transcripts.set(status.sessionId, row)
}

function requiredEnv(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`Missing ${name}`)
  return value
}

async function waitFor(
  sessionId: string,
  accept: (row: Transcript) => boolean,
  rejectError: (row: Transcript) => boolean
): Promise<Transcript> {
  const started = Date.now()
  while (Date.now() - started < 20_000) {
    const row = transcripts.get(sessionId) ?? { text: '' }
    if (accept(row)) return row
    if (rejectError(row)) throw new Error(row.status?.message ?? 'Connection failed during smoke test')
    await new Promise((resolve) => setTimeout(resolve, 80))
  }
  const row = transcripts.get(sessionId)
  throw new Error(`Timed out waiting for the shell.\n${(row?.text ?? '').slice(-600)}`)
}

export async function runSmoke(store: Store, sessions: SessionManager): Promise<number> {
  const password = requiredEnv('EASY_SSH_SMOKE_PASSWORD')
  const directory = requiredEnv('EASY_SSH_SMOKE_DIR')
  const host = process.env.EASY_SSH_SMOKE_HOST ?? '127.0.0.1'
  const port = Number(process.env.EASY_SSH_SMOKE_PORT ?? '22')
  const username = requiredEnv('EASY_SSH_SMOKE_USER')
  const result: {
    ok: boolean
    error?: string
    encryptionBackend?: string
    plaintextLeak: boolean
    sawDirectory: boolean
    sawStartup: boolean
    authRejected: boolean
    outputSample?: string
  } = {
    ok: false,
    plaintextLeak: false,
    sawDirectory: false,
    sawStartup: false,
    authRejected: false
  }

  try {
    const encryption = await encryptionStatus()
    result.encryptionBackend = encryption.backend
    if (!encryption.available) throw new Error(encryption.reason ?? 'Encryption is not available')

    const saved = await store.save({
      name: 'Smoke test',
      host,
      port,
      username,
      authType: 'password',
      password,
      defaultDirectory: directory,
      startupCommands: ["printf 'EASY_SSH_DIR:%s\\n' \"$PWD\"", "printf 'EASY_SSH_STARTUP_OK\\n'"],
      group: 'Local'
    })

    const connectionsRaw = readFileSync(join(store.dataDirectory(), 'connections.json'), 'utf8')
    const secretsRaw = readFileSync(join(store.dataDirectory(), 'secrets.bin.json'), 'utf8')
    result.plaintextLeak = connectionsRaw.includes(password) || secretsRaw.includes(password)
    if (result.plaintextLeak) throw new Error('Password was written to disk in plaintext')
    const revealed = await store.getSecrets(saved.id)
    if (revealed.password !== password) throw new Error('Keychain round-trip did not return the password')

    const sessionId = await sessions.connect(saved.id)
    const connected = await waitFor(
      sessionId,
      (row) =>
        row.status?.phase === 'connected' &&
        row.text.includes('EASY_SSH_STARTUP_OK') &&
        row.text.includes(`EASY_SSH_DIR:${directory}`),
      (row) => row.status?.phase === 'error'
    )
    sessions.disconnect(sessionId)
    result.sawStartup = connected.text.includes('EASY_SSH_STARTUP_OK')
    result.sawDirectory = connected.text.includes(`EASY_SSH_DIR:${directory}`)
    result.outputSample = connected.text.slice(-800)

    await store.setSecret(saved.id, { password: `${password}-wrong` })
    const badId = await sessions.connect(saved.id)
    const failed = await waitFor(
      badId,
      (row) => row.status?.phase === 'error' && row.status.code === 'auth',
      (row) => row.status?.phase === 'error' && row.status.code !== 'auth'
    )
    sessions.disconnect(badId)
    result.authRejected = failed.status?.code === 'auth'
    if (!result.authRejected) throw new Error('Wrong password was not reported as an authentication failure')

    await store.remove(saved.id)
    if (store.get(saved.id)) throw new Error('Deleted connection is still listed')
    result.ok = true
  } catch (error) {
    result.error = error instanceof Error ? error.message : String(error)
  }

  const destination = process.env.EASY_SSH_SMOKE_RESULT ?? '/tmp/easy-ssh-smoke-result.json'
  writeFileSync(destination, `${JSON.stringify(result, null, 2)}\n`)
  console.log(JSON.stringify(result, null, 2))
  return result.ok ? 0 : 1
}
