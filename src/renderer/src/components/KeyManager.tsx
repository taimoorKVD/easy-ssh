import { useEffect, useState } from 'react'
import type { KeyPublic } from '@shared/keys'
import { errorMessage } from '../lib/errors'

interface Props {
  sessionId: string | null
  serverLabel: string | null
  notify: (message: string) => void
  onClose: () => void
}

export default function KeyManager({ sessionId, serverLabel, notify, onClose }: Props) {
  const [keys, setKeys] = useState<KeyPublic[] | null>(null)
  const [name, setName] = useState('')
  const [passphrase, setPassphrase] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const refresh = (): void => {
    void window.easySsh.listKeys().then(setKeys, (err) => setError(errorMessage(err)))
  }
  useEffect(refresh, [])
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const run = async (task: () => Promise<unknown>): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      await task()
      refresh()
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal keys-modal" role="dialog" aria-label="SSH keys">
        <div className="modal-head">
          <div>
            <h2>SSH keys</h2>
            <p className="hint">Private keys are encrypted with your OS keychain and never leave this app.</p>
          </div>
          <button className="icon-button" onClick={onClose} aria-label="Close">×</button>
        </div>
        <div className="keys-new">
          <input placeholder="Key name (e.g. laptop-2026)" value={name} onChange={(e) => setName(e.target.value)} spellCheck={false} />
          <button className="btn btn-primary" disabled={busy} onClick={() => void run(async () => { await window.easySsh.generateKey(name); setName('') })}>
            Generate ed25519
          </button>
          <input type="password" placeholder="Passphrase (if importing an encrypted key)" value={passphrase} onChange={(e) => setPassphrase(e.target.value)} autoComplete="off" />
          <button className="btn btn-ghost" disabled={busy} onClick={() => void run(async () => { if (await window.easySsh.importKey(name, passphrase)) { setName(''); setPassphrase('') } })}>
            Import file…
          </button>
        </div>
        <ul className="keys-list">
          {keys?.length === 0 && <li className="hint">No saved keys yet.</li>}
          {keys?.map((key) => (
            <li key={key.id}>
              <div className="key-main">
                <strong>{key.name}</strong>
                <span className="fwd-kind">{key.type}</span>
                {key.hasPassphrase && <span className="hint">passphrase saved</span>}
                <code title={key.fingerprint}>{key.fingerprint}</code>
              </div>
              <div className="key-actions">
                <button className="btn btn-ghost" onClick={() => void window.easySsh.clipboardWrite(key.publicKey).then(() => notify('Public key copied.'))}>Copy public key</button>
                <button
                  className="btn btn-ghost"
                  disabled={!sessionId || busy}
                  title={sessionId ? `Append to ~/.ssh/authorized_keys on ${serverLabel}` : 'Connect to a server first'}
                  onClick={() =>
                    void run(async () => {
                      const result = await window.easySsh.installKey(sessionId!, key.id)
                      notify(result === 'present' ? `Already authorized on ${serverLabel}.` : `Key added to ${serverLabel}. You can switch this host to key login now.`)
                    })
                  }
                >
                  Copy to server
                </button>
                <button className="btn btn-danger" disabled={busy} onClick={() => window.confirm(`Delete ${key.name}? Servers that trust it keep the public key.`) && void run(() => window.easySsh.removeKey(key.id))}>
                  Delete
                </button>
              </div>
            </li>
          ))}
        </ul>
        {error && <p className="form-error">{error}</p>}
      </div>
    </div>
  )
}
