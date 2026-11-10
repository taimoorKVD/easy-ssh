import { useEffect, useState, type FormEvent } from 'react'
import { KEYBOARD_AUTH_TIMEOUT_MS, MAX_KEYBOARD_ANSWER } from '@shared/keyboard-auth'
import type { ConnectionPublic, HostKeyPrompt, KeyboardAuthPrompt, SessionErrorCode } from '@shared/types'

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
  const [verified, setVerified] = useState(false)
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
        {prompt.changed && (
          <>
            {prompt.previousFingerprint && <p className="dialog-body">Previously trusted: <code>{prompt.previousFingerprint}</code></p>}
            <label className="dialog-body" style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <input type="checkbox" checked={verified} onChange={(e) => setVerified(e.target.checked)} />
              I checked the new fingerprint with the server admin
            </label>
          </>
        )}
        <footer className="modal-actions">
          <button type="button" className="btn btn-ghost" onClick={onReject}>
            Reject
          </button>
          <button type="button" className="btn btn-ghost" onClick={onAcceptOnce} disabled={prompt.changed && !verified}>
            Accept once
          </button>
          <button type="button" className="btn btn-primary" onClick={onTrust} autoFocus={!prompt.changed} disabled={prompt.changed && !verified}>
            {prompt.changed ? 'Replace trusted key' : 'Trust this key'}
          </button>
        </footer>
      </div>
    </div>
  )
}

export function KeyboardAuthDialog({
  prompt,
  onCancel,
  onSubmit
}: {
  prompt: KeyboardAuthPrompt
  onCancel: () => void
  onSubmit: (answers: string[]) => void
}) {
  const [values, setValues] = useState<string[]>(() => prompt.prompts.map(() => ''))
  const seconds = Math.round(KEYBOARD_AUTH_TIMEOUT_MS / 1000)
  const heading = prompt.name.trim() || 'Authentication required'

  function submit(event: FormEvent): void {
    event.preventDefault()
    onSubmit(values)
  }

  return (
    <div className="modal-backdrop" role="presentation">
      <form className="modal modal-compact" role="dialog" aria-modal="true" aria-labelledby="kbd-title" onSubmit={submit}>
        <header className="modal-head">
          <div>
            <h2 id="kbd-title">{heading}</h2>
            <p>{prompt.label}</p>
          </div>
        </header>
        {prompt.instructions.trim() && <p className="dialog-body">{prompt.instructions}</p>}
        <div className="form-grid">
          {prompt.prompts.map((field, index) => (
            <label className="field span-2" key={`${index}:${field.prompt}`}>
              <span>{field.prompt.trim() || 'Response'}</span>
              <input
                type={field.echo ? 'text' : 'password'}
                value={values[index] ?? ''}
                autoFocus={index === 0}
                autoComplete="off"
                spellCheck={false}
                maxLength={MAX_KEYBOARD_ANSWER}
                aria-label={field.prompt.trim() || 'Response'}
                onChange={(event) => {
                  const next = values.slice()
                  next[index] = event.target.value
                  setValues(next)
                }}
              />
            </label>
          ))}
        </div>
        <p className="dialog-body">Used once for this sign-in and not saved. Closes after {seconds} seconds.</p>
        <footer className="modal-actions">
          <button type="button" className="btn btn-ghost" onClick={onCancel}>
            Cancel
          </button>
          <button type="submit" className="btn btn-primary">
            Continue
          </button>
        </footer>
      </form>
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
