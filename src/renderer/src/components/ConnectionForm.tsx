import { useState, type FormEvent } from 'react'
import type { AuthType, ConnectionInput, ConnectionPublic } from '@shared/types'

interface ConnectionFormProps {
  initial?: ConnectionPublic
  groups: string[]
  connections: ConnectionPublic[]
  saving: boolean
  error: string | null
  onClose: () => void
  onSubmit: (input: ConnectionInput) => void
}

export function ConnectionForm({ initial, groups, connections, saving, error, onClose, onSubmit }: ConnectionFormProps) {
  const [name, setName] = useState(initial?.name ?? '')
  const [host, setHost] = useState(initial?.host ?? '')
  const [port, setPort] = useState(String(initial?.port ?? 22))
  const [username, setUsername] = useState(initial?.username ?? '')
  const [authType, setAuthType] = useState<AuthType>(initial?.authType ?? 'password')
  const [password, setPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [privateKeyPath, setPrivateKeyPath] = useState(initial?.privateKeyPath ?? '')
  const [passphrase, setPassphrase] = useState('')
  const [showPassphrase, setShowPassphrase] = useState(false)
  const [defaultDirectory, setDefaultDirectory] = useState(initial?.defaultDirectory ?? '')
  const [startupCommands, setStartupCommands] = useState(initial?.startupCommands.join('\n') ?? '')
  const [group, setGroup] = useState(initial?.group ?? '')
  const [jumpHostId, setJumpHostId] = useState(initial?.jumpHostId ?? '')
  const jumpChoices = connections.filter((c) => c.id !== initial?.id && !c.jumpHostId)
  const isBastion = Boolean(initial && connections.some((c) => c.jumpHostId === initial.id))
  const [localError, setLocalError] = useState<string | null>(null)

  async function browseKey(): Promise<void> {
    const picked = await window.easySsh.selectPrivateKey()
    if (picked) setPrivateKeyPath(picked)
  }

  function submit(event: FormEvent): void {
    event.preventDefault()
    if (authType === 'password' && !password && !initial?.hasPassword) {
      setLocalError('Enter a password. It is saved in the OS keychain, not in the connections file.')
      return
    }
    if (authType === 'privateKey' && !privateKeyPath.trim()) {
      setLocalError('Choose a private key file.')
      return
    }
    setLocalError(null)
    onSubmit({
      id: initial?.id,
      name,
      host,
      port: Number(port),
      username,
      authType,
      privateKeyPath,
      defaultDirectory,
      startupCommands,
      group,
      jumpHostId: jumpHostId || undefined,
      password: authType === 'password' && password ? password : undefined,
      passphrase: authType === 'privateKey' && passphrase ? passphrase : undefined,
      clearPassword: authType !== 'password',
      clearPassphrase: authType !== 'privateKey'
    })
  }

  const message = localError ?? error

  return (
    <div className="modal-backdrop" role="presentation">
      <form className="modal" role="dialog" aria-modal="true" aria-labelledby="connection-form-title" onSubmit={submit}>
        <header className="modal-head">
          <div>
            <h2 id="connection-form-title">{initial ? 'Edit connection' : 'New connection'}</h2>
            <p>Same details you would pass to ssh. The password never goes in the JSON file.</p>
          </div>
          <button type="button" className="icon-button" onClick={onClose} aria-label="Close">
            ×
          </button>
        </header>
        {message && <p className="form-error">{message}</p>}
        <div className="form-grid">
          <label className="field span-2">
            <span>Name</span>
            <input value={name} onChange={(event) => setName(event.target.value)} placeholder="Hostinger app" autoFocus required spellCheck={false} />
          </label>
          <label className="field">
            <span>Host</span>
            <input value={host} onChange={(event) => setHost(event.target.value)} placeholder="203.0.113.10" required spellCheck={false} />
          </label>
          <label className="field">
            <span>Port</span>
            <input
              value={port}
              onChange={(event) => setPort(event.target.value)}
              inputMode="numeric"
              required
              spellCheck={false}
            />
            <small>22 is the default. Hostinger often uses 65002.</small>
          </label>
          <label className="field">
            <span>Username</span>
            <input value={username} onChange={(event) => setUsername(event.target.value)} placeholder="u123456789" required spellCheck={false} />
          </label>
          <label className="field">
            <span>Group</span>
            <input value={group} onChange={(event) => setGroup(event.target.value)} placeholder="Production" list="connection-groups" spellCheck={false} />
            <datalist id="connection-groups">
              {groups.map((item) => (
                <option key={item} value={item} />
              ))}
            </datalist>
          </label>
          <label className="field span-2">
            <span>Jump host (bastion)</span>
            <select className="select" value={jumpHostId} onChange={(event) => setJumpHostId(event.target.value)} disabled={isBastion}>
              <option value="">None, connect directly</option>
              {jumpChoices.map((c) => (
                <option key={c.id} value={c.id}>{`${c.name} (${c.username}@${c.host})`}</option>
              ))}
            </select>
            <small>
              {isBastion
                ? 'Other connections jump through this one, so it connects directly.'
                : 'Like ssh -J: easy-ssh logs in to the bastion first, then tunnels to this host. Each host key is verified separately.'}
            </small>
          </label>
          <div className="field span-2">
            <span>Authentication</span>
            <div className="segmented" role="group" aria-label="Authentication type">
              <button type="button" aria-pressed={authType === 'password'} onClick={() => setAuthType('password')}>
                Password
              </button>
              <button type="button" aria-pressed={authType === 'privateKey'} onClick={() => setAuthType('privateKey')}>
                Private key
              </button>
            </div>
          </div>
          {authType === 'password' ? (
            <label className="field span-2">
              <span>Password</span>
              <span className="secret-row">
                <input
                  type={showPassword ? 'text' : 'password'}
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  placeholder={initial?.hasPassword ? 'Saved — leave blank to keep' : 'Stored in the OS keychain'}
                  autoComplete="off"
                  spellCheck={false}
                />
                <button type="button" className="text-button" onClick={() => setShowPassword((value) => !value)}>
                  {showPassword ? 'Hide' : 'Show'}
                </button>
              </span>
            </label>
          ) : (
            <>
              <label className="field span-2">
                <span>Private key</span>
                <span className="secret-row">
                  <input
                    value={privateKeyPath}
                    onChange={(event) => setPrivateKeyPath(event.target.value)}
                    placeholder="/home/you/.ssh/id_ed25519"
                    spellCheck={false}
                  />
                  <button type="button" className="text-button" onClick={() => void browseKey()}>
                    Browse
                  </button>
                </span>
              </label>
              <label className="field span-2">
                <span>Key passphrase</span>
                <span className="secret-row">
                  <input
                    type={showPassphrase ? 'text' : 'password'}
                    value={passphrase}
                    onChange={(event) => setPassphrase(event.target.value)}
                    placeholder={initial?.hasPassphrase ? 'Saved — leave blank to keep' : 'Optional'}
                    autoComplete="off"
                    spellCheck={false}
                  />
                  <button type="button" className="text-button" onClick={() => setShowPassphrase((value) => !value)}>
                    {showPassphrase ? 'Hide' : 'Show'}
                  </button>
                </span>
              </label>
            </>
          )}
          <label className="field span-2">
            <span>Default directory</span>
            <input
              value={defaultDirectory}
              onChange={(event) => setDefaultDirectory(event.target.value)}
              placeholder="domains/example.com/public_html"
              spellCheck={false}
            />
            <small>easy-ssh runs cd here after login, then leaves you in the shell.</small>
          </label>
          <label className="field span-2">
            <span>Startup commands</span>
            <textarea
              value={startupCommands}
              onChange={(event) => setStartupCommands(event.target.value)}
              placeholder={'echo ready\nphp artisan config:cache'}
              spellCheck={false}
            />
            <small>One command per line. They run after login, then the shell stays open.</small>
          </label>
        </div>
        <footer className="modal-actions">
          <button type="button" className="btn btn-ghost" onClick={onClose} disabled={saving}>
            Cancel
          </button>
          <button type="submit" className="btn btn-primary" disabled={saving}>
            {saving ? 'Saving…' : initial ? 'Save changes' : 'Save connection'}
          </button>
        </footer>
      </form>
    </div>
  )
}
