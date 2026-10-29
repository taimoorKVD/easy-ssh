import { useEffect, useState } from 'react'
import { errorMessage } from '../lib/errors'

interface Props {
  mode: 'create' | 'restore'
  notify: (message: string) => void
  onRestored: () => void
  onClose: () => void
}

/** Password-protected backup (scrypt + AES-256-GCM, done in the main process). */
export default function BackupDialog({ mode, notify, onRestored, onClose }: Props) {
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [includeKeys, setIncludeKeys] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const submit = async (): Promise<void> => {
    setError(null)
    if (mode === 'create' && password !== confirm) return setError('The passwords do not match.')
    setBusy(true)
    try {
      if (mode === 'create') {
        const r = await window.easySsh.backupCreate(password, includeKeys)
        if (r.canceled) return
        notify(`Backup saved: ${r.hosts} hosts, ${r.snippets} snippets${r.keys ? `, ${r.keys} keys` : ''}.`)
      } else {
        const r = await window.easySsh.backupRestore(password)
        if (r.canceled) return
        onRestored()
        notify(`Restored ${r.imported} hosts${r.skipped ? ` (skipped ${r.skipped} duplicates)` : ''}, ${r.snippets} snippets, ${r.keys} keys.`)
      }
      setPassword('')
      setConfirm('')
      onClose()
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <form className="modal keys-modal" role="dialog" aria-label="Encrypted backup" onSubmit={(e) => { e.preventDefault(); void submit() }}>
        <div className="modal-head">
          <div>
            <h2>{mode === 'create' ? 'Create encrypted backup' : 'Restore encrypted backup'}</h2>
            <p className="hint">
              {mode === 'create'
                ? 'Hosts and snippets are encrypted with your password (scrypt + AES-256-GCM). Saved passwords are never included. There is no recovery if you forget it.'
                : 'Pick an .essh file. Existing hosts with the same name and address are skipped.'}
            </p>
          </div>
          <button type="button" className="icon-button" onClick={onClose} aria-label="Close">×</button>
        </div>
        <label className="field">
          <span>Backup password</span>
          <input type="password" autoFocus value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" minLength={mode === 'create' ? 10 : 1} maxLength={1024} />
        </label>
        {mode === 'create' && (
          <>
            <label className="field">
              <span>Confirm password</span>
              <input type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="new-password" maxLength={1024} />
            </label>
            <label className="field-check">
              <input type="checkbox" checked={includeKeys} onChange={(e) => setIncludeKeys(e.target.checked)} /> Include saved SSH keys (private keys)
            </label>
          </>
        )}
        {error && <p className="form-error">{error}</p>}
        <div className="modal-actions">
          <button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn btn-primary" disabled={busy || !password}>{busy ? 'Working…' : mode === 'create' ? 'Save backup…' : 'Choose file…'}</button>
        </div>
      </form>
    </div>
  )
}
