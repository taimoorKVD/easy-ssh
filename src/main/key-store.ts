import { createHash, randomUUID } from 'node:crypto'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { safeStorage } from 'electron'
import ssh2, { type ParsedKey } from 'ssh2'

// ssh2 is CommonJS; the ESM main bundle can only take its default export.
const { utils } = ssh2
import { isValidPublicKeyLine, sanitizeKeyName, type KeyPublic } from '../shared/keys'
import { dataDir, encryptionStatus, writePrivate } from './store'

interface StoredKey extends KeyPublic {
  privateKey: string
  passphrase?: string
}

const MAX_KEYS = 100

function parse(data: Buffer | string, passphrase?: string): ParsedKey {
  const parsed = utils.parseKey(data, passphrase)
  if (parsed instanceof Error) {
    const msg = parsed.message.toLowerCase()
    if (msg.includes('passphrase') || msg.includes('encrypted')) throw new Error('This key is encrypted. Enter its passphrase.')
    throw new Error(`Not a supported private key: ${parsed.message}`)
  }
  const key = Array.isArray(parsed) ? parsed[0] : parsed
  if (!key || key instanceof Error) throw new Error('Not a supported private key.')
  return key as ParsedKey
}

function fingerprintOf(publicSsh: Buffer): string {
  return `SHA256:${createHash('sha256').update(publicSsh).digest('base64').replace(/=+$/g, '')}`
}

/** Private keys live only inside one safeStorage-encrypted blob (keys.enc). */
export class KeyStore {
  private cache: StoredKey[] | null = null
  private file = join(dataDir(), 'keys.enc')

  async list(): Promise<KeyPublic[]> {
    return (await this.load()).map(({ privateKey: _p, passphrase: _s, ...pub }) => pub)
  }

  async generate(rawName: unknown): Promise<KeyPublic> {
    const name = sanitizeKeyName(rawName)
    const pair = utils.generateKeyPairSync('ed25519', { comment: name })
    const parsed = parse(pair.private)
    const publicKey = pair.public.trim()
    return this.add({ name, type: 'ed25519', publicKey, fingerprint: fingerprintOf(parsed.getPublicSSH()), privateKey: pair.private })
  }

  async importFile(path: string, rawName: unknown, passphrase: unknown): Promise<KeyPublic> {
    if (!existsSync(path) || statSync(path).size > 64 * 1024) throw new Error('That file is not a private key.')
    const data = readFileSync(path, 'utf8')
    const pass = typeof passphrase === 'string' && passphrase.length > 0 ? passphrase.slice(0, 1024) : undefined
    const parsed = parse(data, pass)
    if (!parsed.isPrivateKey()) throw new Error('That is a public key. Pick the private key file (without .pub).')
    const comment = sanitizeKeyName(parsed.comment || rawName || path.split(/[\\/]/).pop())
    const blob = parsed.getPublicSSH().toString('base64')
    const publicKey = `${parsed.type} ${blob} ${comment}`
    if (!isValidPublicKeyLine(publicKey)) throw new Error('Unsupported key type.')
    return this.add({
      name: sanitizeKeyName(rawName || comment),
      type: parsed.type.replace(/^ssh-/, ''),
      publicKey,
      fingerprint: fingerprintOf(parsed.getPublicSSH()),
      privateKey: data,
      passphrase: pass
    })
  }

  /** Full key material for an encrypted backup. Main process only. */
  async exportAll(): Promise<Array<{ id: string; name: string; privateKey: string; passphrase?: string }>> {
    return (await this.load()).map((k) => ({ id: k.id, name: k.name, privateKey: k.privateKey, passphrase: k.passphrase }))
  }

  /** Restore one key from a backup; returns the id of the new or already-present key. */
  async restore(rawName: unknown, privateKey: unknown, passphrase: unknown): Promise<string> {
    if (typeof privateKey !== 'string' || privateKey.length > 64 * 1024) throw new Error('Bad key in backup.')
    const pass = typeof passphrase === 'string' && passphrase.length > 0 ? passphrase.slice(0, 1024) : undefined
    const parsed = parse(privateKey, pass)
    if (!parsed.isPrivateKey()) throw new Error('Bad key in backup.')
    const fingerprint = fingerprintOf(parsed.getPublicSSH())
    const existing = (await this.load()).find((k) => k.fingerprint === fingerprint)
    if (existing) return existing.id
    const name = sanitizeKeyName(rawName || parsed.comment)
    const publicKey = `${parsed.type} ${parsed.getPublicSSH().toString('base64')} ${name}`
    if (!isValidPublicKeyLine(publicKey)) throw new Error('Unsupported key type.')
    const added = await this.add({ name, type: parsed.type.replace(/^ssh-/, ''), publicKey, fingerprint, privateKey, passphrase: pass })
    return added.id
  }

  async remove(id: string): Promise<void> {
    await this.persist((await this.load()).filter((k) => k.id !== id))
  }

  async publicKey(id: string): Promise<string> {
    const key = (await this.load()).find((k) => k.id === id)
    if (!key) throw new Error('That key no longer exists.')
    return key.publicKey
  }

  /** Decrypted material for an SSH login. Never sent to the renderer. */
  async material(id: string): Promise<{ privateKey: Buffer; passphrase?: string }> {
    const key = (await this.load()).find((k) => k.id === id)
    if (!key) throw new Error('The saved key for this connection was deleted.')
    return { privateKey: Buffer.from(key.privateKey, 'utf8'), passphrase: key.passphrase }
  }

  private async add(input: Omit<StoredKey, 'id' | 'createdAt' | 'hasPassphrase'>): Promise<KeyPublic> {
    const list = [...(await this.load())]
    if (list.length >= MAX_KEYS) throw new Error('Key limit reached.')
    if (list.some((k) => k.fingerprint === input.fingerprint)) throw new Error('That key is already in easy-ssh.')
    const stored: StoredKey = { ...input, id: randomUUID(), createdAt: Date.now(), hasPassphrase: Boolean(input.passphrase) }
    list.push(stored)
    await this.persist(list)
    const { privateKey: _p, passphrase: _s, ...pub } = stored
    return pub
  }

  private async load(): Promise<StoredKey[]> {
    if (this.cache) return this.cache
    if (!existsSync(this.file)) return (this.cache = [])
    const status = await encryptionStatus()
    if (!status.available) throw new Error('The OS keychain is unavailable, so saved keys cannot be read.')
    const raw = Buffer.from(readFileSync(this.file, 'utf8').trim(), 'base64')
    const { result } = await safeStorage.decryptStringAsync(raw)
    const parsed = JSON.parse(result) as { keys?: StoredKey[] }
    this.cache = Array.isArray(parsed.keys) ? parsed.keys : []
    return this.cache
  }

  private async persist(list: StoredKey[]): Promise<void> {
    const status = await encryptionStatus()
    if (!status.available) throw new Error('The OS keychain is unavailable, so keys cannot be saved securely.')
    const encrypted = await safeStorage.encryptStringAsync(JSON.stringify({ version: 1, keys: list }))
    writePrivate(this.file, `${Buffer.from(encrypted).toString('base64')}\n`)
    this.cache = list
  }
}
