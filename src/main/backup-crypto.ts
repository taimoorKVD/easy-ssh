import { createCipheriv, createDecipheriv, randomBytes, scrypt as scryptCb, type ScryptOptions } from 'node:crypto'

/** Password-protected backup envelope: scrypt key derivation + AES-256-GCM (authenticated). */
export const BACKUP_KIND = 'easy-ssh-backup'
export const MIN_BACKUP_PASSWORD = 10
const MAX_FILE = 8 * 1024 * 1024
const DEFAULT_N = 1 << 17

export interface BackupEnvelope {
  kind: typeof BACKUP_KIND
  version: 1
  kdf: { name: 'scrypt'; N: number; r: number; p: number; salt: string }
  cipher: 'aes-256-gcm'
  iv: string
  tag: string
  data: string
}

function derive(password: string, salt: Buffer, N: number, r: number, p: number): Promise<Buffer> {
  const options: ScryptOptions = { N, r, p, maxmem: 256 * N * r + 1024 * 1024 }
  return new Promise((resolve, reject) =>
    scryptCb(password.normalize('NFKC'), salt, 32, options, (err, key) => (err ? reject(err) : resolve(key)))
  )
}

function header(env: Pick<BackupEnvelope, 'kind' | 'version' | 'kdf' | 'cipher' | 'iv'>): Buffer {
  return Buffer.from(JSON.stringify([env.kind, env.version, env.kdf, env.cipher, env.iv]), 'utf8')
}

export function checkBackupPassword(password: unknown): string {
  if (typeof password !== 'string' || password.length < MIN_BACKUP_PASSWORD) {
    throw new Error(`Use a backup password of at least ${MIN_BACKUP_PASSWORD} characters.`)
  }
  if (password.length > 1024) throw new Error('Backup password is too long.')
  return password
}

export async function encryptBackup(payload: unknown, password: string, N = DEFAULT_N): Promise<string> {
  checkBackupPassword(password)
  const salt = randomBytes(16)
  const iv = randomBytes(12)
  const kdf = { name: 'scrypt' as const, N, r: 8, p: 1, salt: salt.toString('base64') }
  const key = await derive(password, salt, N, 8, 1)
  const base = { kind: BACKUP_KIND as typeof BACKUP_KIND, version: 1 as const, kdf, cipher: 'aes-256-gcm' as const, iv: iv.toString('base64') }
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  cipher.setAAD(header(base))
  const data = Buffer.concat([cipher.update(JSON.stringify(payload), 'utf8'), cipher.final()])
  key.fill(0)
  const env: BackupEnvelope = { ...base, tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') }
  return `${JSON.stringify(env, null, 1)}\n`
}

export async function decryptBackup(text: string, password: unknown): Promise<unknown> {
  if (typeof password !== 'string' || !password || password.length > 1024) throw new Error('Enter the backup password.')
  if (text.length > MAX_FILE) throw new Error('That backup file is too large.')
  let env: BackupEnvelope
  try {
    env = JSON.parse(text) as BackupEnvelope
  } catch {
    throw new Error('That is not an easy-ssh backup file.')
  }
  if (!env || env.kind !== BACKUP_KIND || env.version !== 1 || env.cipher !== 'aes-256-gcm' || !env.kdf || env.kdf.name !== 'scrypt') {
    throw new Error('That is not an easy-ssh backup file.')
  }
  const { N, r, p } = env.kdf
  // Bound the KDF cost so a crafted file cannot exhaust memory or CPU.
  if (!Number.isInteger(N) || N < 1 << 14 || N > 1 << 20 || (N & (N - 1)) !== 0 || r !== 8 || p !== 1) {
    throw new Error('Unsupported backup parameters.')
  }
  const salt = Buffer.from(String(env.kdf.salt), 'base64')
  const iv = Buffer.from(String(env.iv), 'base64')
  const tag = Buffer.from(String(env.tag), 'base64')
  if (salt.length !== 16 || iv.length !== 12 || tag.length !== 16) throw new Error('That backup file is damaged.')
  const key = await derive(password, salt, N, r, p)
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, iv)
    decipher.setAAD(header(env))
    decipher.setAuthTag(tag)
    const plain = Buffer.concat([decipher.update(Buffer.from(String(env.data), 'base64')), decipher.final()])
    return JSON.parse(plain.toString('utf8'))
  } catch {
    throw new Error('Wrong password, or the backup file was modified.')
  } finally {
    key.fill(0)
  }
}
