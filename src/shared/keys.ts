/** SSH key manager helpers. Pure so they can be unit tested. */
export interface KeyPublic {
  id: string
  name: string
  type: string
  fingerprint: string
  publicKey: string
  hasPassphrase: boolean
  createdAt: number
}

const PUBKEY_RE = /^(ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp(?:256|384|521)|sk-ssh-ed25519@openssh\.com) [A-Za-z0-9+/]+={0,3}(?: [A-Za-z0-9._@+-]{1,100})?$/

function shSingleQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

export function sanitizeKeyName(raw: unknown): string {
  const text = typeof raw === 'string' ? raw : ''
  const cleaned = text.replace(/[^A-Za-z0-9._@+-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60)
  return cleaned || 'easy-ssh-key'
}

export function isValidPublicKeyLine(line: string): boolean {
  return line.length < 16_000 && PUBKEY_RE.test(line)
}

/**
 * Append-only install, like ssh-copy-id: never rewrites existing keys,
 * skips the append when the exact line is already present, and fixes permissions.
 */
export function authorizedKeysCommand(publicKey: string): string {
  const line = publicKey.trim()
  if (!isValidPublicKeyLine(line)) throw new Error('That is not a valid public key.')
  const q = shSingleQuote(line)
  return [
    'umask 077',
    'mkdir -p ~/.ssh',
    'touch ~/.ssh/authorized_keys',
    'chmod 700 ~/.ssh',
    'chmod 600 ~/.ssh/authorized_keys',
    `if grep -qxF ${q} ~/.ssh/authorized_keys; then echo EASYSSH_KEY_PRESENT; else printf '%s\\n' ${q} >> ~/.ssh/authorized_keys && echo EASYSSH_KEY_ADDED; fi`
  ].join(' && ')
}
