import { useEffect, useState, type FormEvent } from 'react'
import type { ConnectionPublic, HostKeyPrompt, SessionErrorCode } from '@shared/types'

export function Toast({ message }: { message: string | null }) {
  if (!message) return null
  return (
    <div className="toast" role="status">
      {message}
    </div>
  )
}

export function ConfirmDialog({
  title,
  body,
  confirmLabel,
  busy,
  onCancel,
  onConfirm
}: {
  title: string
  body: string
  confirmLabel: string
  busy?: boolean
  onCancel: () => void
  onConfirm: () => void
}) {
  return (
    <div className="modal-backdrop" role="presentation">
      <div className="modal modal-compact" role="dialog" aria-modal="true" aria-labelledby="confirm-title">
        <header className="modal-head">
          <h2 id="confirm-title">{title}</h2>
        </header>
        <p className="dialog-body">{body}</p>
        <footer className="modal-actions">
          <button type="button" className="btn btn-ghost" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
          <button type="button" className="btn btn-danger" onClick={onConfirm} disabled={busy}>
            {busy ? 'Working…' : confirmLabel}
          </button>
        </footer>
      </div>
    </div>
  )
}

export function HostKeyDialog({
  prompt,
  onReject,
  onAcceptOnce,
  onTrust
}: {
  prompt: HostKeyPrompt
  onReject: () => void
  onAcceptOnce: () => void
  onTrust: () => void
}) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onReject()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onReject])

  return (
    <div className="modal-backdrop" role="presentation">
      <div className="modal modal-compact" role="dialog" aria-modal="true" aria-labelledby="hostkey-title">
        <header className="modal-head">
          <div>
            <h2 id="hostkey-title">{prompt.changed ? 'Host key changed' : 'Unknown host key'}</h2>
            <p>
              {prompt.host}:{prompt.port}
            </p>
          </div>
        </header>
        <p className="dialog-body">
          {prompt.changed
            ? 'The key for this server does not match the one you trusted before. A reinstall can cause that. So can someone intercepting the connection.'
            : 'This server has not been verified yet. Trusting it saves the fingerprint with this connection’s host and port.'}
        </p>
        <button
          type="button"
          className="fingerprint"
          onClick={() => void window.easySsh.clipboardWrite(prompt.fingerprint)}
          title="Copy fingerprint"
        >
          {prompt.fingerprint}
        </button>
        <footer className="modal-actions">
          <button type="button" className="btn btn-ghost" onClick={onReject}>
            Reject
          </button>
          <button type="button" className="btn btn-ghost" onClick={onAcceptOnce}>
            Accept once
          </button>
          <button type="button" className="btn btn-primary" onClick={onTrust} autoFocus>
            {prompt.changed ? 'Replace trusted key' : 'Trust this key'}
          </button>
        </footer>
      </div>
    </div>
  )
}

export function ProblemSheet({
  title,
  message,
  code,
  connection,
  onReconnect,
  onSubmitSecret
}: {
  title: string
  message?: string
  code?: SessionErrorCode
  connection?: ConnectionPublic
  onReconnect: () => void
  onSubmitSecret: (secret: { password?: string; passphrase?: string }) => Promise<void>
}) {
  const askPassword = code === 'auth' && connection?.authType !== 'privateKey'
  const askPassphrase = (code === 'key' || code === 'auth') && connection?.authType === 'privateKey'
  const [value, setValue] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault()
    if (!value) {
      setError(askPassphrase ? 'Enter the key passphrase.' : 'Enter the password.')
      return
    }
    setBusy(true)
    setError(null)
    try {
      await onSubmitSecret(askPassphrase ? { passphrase: value } : { password: value })
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not save that secret.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <form className="problem" onSubmit={(event) => void submit(event)}>
      <div>
        <strong>{title}</strong>
        {message && <p>{message}</p>}
        {error && <p className="form-error inline">{error}</p>}
      </div>
      {askPassword || askPassphrase ? (
        <div className="problem-actions">
          <input
            type="password"
            value={value}
            onChange={(event) => setValue(event.target.value)}
            placeholder={askPassphrase ? 'Key passphrase' : 'Password'}
            autoFocus
            autoComplete="off"
            spellCheck={false}
            aria-label={askPassphrase ? 'Key passphrase' : 'Password'}
          />
          <button className="btn btn-primary" type="submit" disabled={busy}>
            {busy ? 'Saving…' : 'Save and reconnect'}
          </button>
        </div>
      ) : (
        <button className="btn btn-primary" type="button" onClick={onReconnect}>
          Reconnect
        </button>
      )}
    </form>
  )
}
