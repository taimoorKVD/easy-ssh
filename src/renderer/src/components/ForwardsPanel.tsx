import { useEffect, useState } from 'react'
import { describeForward, isExposed, validateForward, type ForwardRule, type ForwardType } from '@shared/forwards'
import type { ConnectionPublic } from '@shared/types'
import { errorMessage } from '../lib/errors'

interface Props {
  connection: ConnectionPublic
  sessionId: string | null
  connected: boolean
  onSaved: (connection: ConnectionPublic) => void
  onClose: () => void
}

const blank = { type: 'local' as ForwardType, bindHost: '127.0.0.1', bindPort: '', destHost: 'localhost', destPort: '', autoStart: false }

export default function ForwardsPanel({ connection, sessionId, connected, onSaved, onClose }: Props) {
  const [active, setActive] = useState<Set<string>>(new Set())
  const [draft, setDraft] = useState(blank)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const rules = connection.forwards

  useEffect(() => {
    if (!sessionId) return
    void window.easySsh.listForwards(sessionId).then((ids) => setActive(new Set(ids)))
    return window.easySsh.onForwardState((state) => {
      if (state.sessionId !== sessionId) return
      setActive((cur) => {
        const next = new Set(cur)
        if (state.active) next.add(state.ruleId)
        else next.delete(state.ruleId)
        return next
      })
    })
  }, [sessionId])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const save = async (next: ForwardRule[]): Promise<void> => {
    onSaved(await window.easySsh.setForwards(connection.id, next))
  }

  const add = async (): Promise<void> => {
    setError(null)
    try {
      const rule = validateForward({ ...draft, id: crypto.randomUUID(), bindPort: Number(draft.bindPort), destPort: Number(draft.destPort) })
      if (isExposed(rule) && !window.confirm(`Listen on ${rule.bindHost}? Anyone who can reach this ${rule.type === 'remote' ? 'server' : 'computer'} on port ${rule.bindPort} will be able to use this tunnel.`)) return
      await save([...rules, rule])
      setDraft(blank)
    } catch (err) {
      setError(errorMessage(err))
    }
  }

  const toggle = async (rule: ForwardRule): Promise<void> => {
    if (!sessionId) return
    setError(null)
    setBusy(rule.id)
    try {
      if (active.has(rule.id)) await window.easySsh.stopForward(sessionId, rule.id)
      else await window.easySsh.startForward(sessionId, rule.id)
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setBusy(null)
    }
  }

  const remove = async (rule: ForwardRule): Promise<void> => {
    if (sessionId && active.has(rule.id)) await window.easySsh.stopForward(sessionId, rule.id)
    await save(rules.filter((r) => r.id !== rule.id))
  }

  const setAuto = (rule: ForwardRule): Promise<void> => save(rules.map((r) => (r.id === rule.id ? { ...r, autoStart: !r.autoStart } : r)))

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal fwd-modal" role="dialog" aria-label="Port forwarding">
        <div className="modal-head">
          <div>
            <h2>Port forwarding</h2>
            <p className="hint">{connection.name}: tunnels run over this host's SSH connection.</p>
          </div>
          <button className="icon-button" onClick={onClose} aria-label="Close">×</button>
        </div>
        <ul className="fwd-list">
          {rules.length === 0 && <li className="hint">No tunnels yet. Add one below.</li>}
          {rules.map((rule) => (
            <li key={rule.id} className={active.has(rule.id) ? 'on' : ''}>
              <button
                type="button"
                className={`switch${active.has(rule.id) ? ' on' : ''}`}
                role="switch"
                aria-checked={active.has(rule.id)}
                disabled={!connected || busy === rule.id}
                title={connected ? 'Start or stop' : 'Connect to start tunnels'}
                onClick={() => void toggle(rule)}
              />
              <span className={`fwd-kind ${rule.type}`}>{rule.type === 'local' ? '-L' : rule.type === 'remote' ? '-R' : '-D'}</span>
              <code>{describeForward(rule)}</code>
              {isExposed(rule) && <span className="fwd-warn" title="Reachable from other machines">exposed</span>}
              <label className="fwd-auto"><input type="checkbox" checked={rule.autoStart} onChange={() => void setAuto(rule)} /> auto</label>
              <button type="button" className="icon-button" aria-label="Delete tunnel" onClick={() => void remove(rule)}>×</button>
            </li>
          ))}
        </ul>
        <div className="fwd-form">
          <div className="segmented three">
            {(['local', 'remote', 'dynamic'] as ForwardType[]).map((t) => (
              <button key={t} type="button" aria-pressed={draft.type === t} onClick={() => setDraft({ ...draft, type: t })}>
                {t === 'local' ? 'Local (-L)' : t === 'remote' ? 'Remote (-R)' : 'SOCKS (-D)'}
              </button>
            ))}
          </div>
          <div className="fwd-row">
            <select value={draft.bindHost} onChange={(e) => setDraft({ ...draft, bindHost: e.target.value })} aria-label="Listen address">
              <option value="127.0.0.1">127.0.0.1 (only this {draft.type === 'remote' ? 'server' : 'PC'})</option>
              <option value="::1">::1</option>
              <option value="0.0.0.0">0.0.0.0 (everyone, risky)</option>
            </select>
            <input placeholder="listen port" inputMode="numeric" value={draft.bindPort} onChange={(e) => setDraft({ ...draft, bindPort: e.target.value })} />
            {draft.type !== 'dynamic' && (
              <>
                <span className="hint">→</span>
                <input placeholder="destination host" value={draft.destHost} onChange={(e) => setDraft({ ...draft, destHost: e.target.value })} />
                <input placeholder="port" inputMode="numeric" value={draft.destPort} onChange={(e) => setDraft({ ...draft, destPort: e.target.value })} />
              </>
            )}
            <button className="btn btn-primary" type="button" onClick={() => void add()}>Add</button>
          </div>
          {draft.bindHost === '0.0.0.0' && (
            <p className="form-error">0.0.0.0 exposes this tunnel to every network the {draft.type === 'remote' ? 'server' : 'computer'} is on. Prefer 127.0.0.1 unless you really need it.</p>
          )}
          <p className="hint">
            {draft.type === 'local' && 'Local: a port on this PC reaches a host:port as seen from the server (e.g. a database).'}
            {draft.type === 'remote' && 'Remote: a port on the server reaches a host:port as seen from this PC.'}
            {draft.type === 'dynamic' && 'SOCKS: point a browser or tool at this port to route traffic through the server.'}
          </p>
          {error && <p className="form-error">{error}</p>}
        </div>
      </div>
    </div>
  )
}
