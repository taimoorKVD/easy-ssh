import { useEffect, useState } from 'react'
import type { UpdateState } from '@shared/update-state'

/** Themed update popup. All logic lives in main; this only renders state and sends choices. */
export default function UpdatePopup() {
  const [state, setState] = useState<UpdateState | null>(null)

  useEffect(() => {
    const off = window.easySsh.onUpdateState(setState)
    void window.easySsh.updateState().then(setState, () => undefined)
    return off
  }, [])

  useEffect(() => {
    if (!state?.visible || (state.phase !== 'uptodate' && state.phase !== 'checking')) return
    if (state.phase === 'checking') return
    const t = setTimeout(() => setState((s) => (s ? { ...s, visible: false } : s)), 4000)
    return () => clearTimeout(t)
  }, [state])

  if (!state?.visible) return null
  const later = (): void => {
    void window.easySsh.updateLater(state.version ?? '').catch(() => undefined)
    setState({ ...state, visible: false })
  }
  const close = (): void => setState({ ...state, visible: false })

  return (
    <div className="update-pop" role="status" aria-live="polite">
      {state.phase === 'checking' && <p className="update-title">Checking for updates…</p>}
      {state.phase === 'uptodate' && <p className="update-title">You're up to date (v{state.current}).</p>}
      {state.phase === 'error' && (
        <>
          <p className="update-title">Update check failed</p>
          <p className="update-notes">{state.error}</p>
          <div className="update-actions"><button className="btn btn-ghost" onClick={close}>Close</button></div>
        </>
      )}
      {(state.phase === 'available' || state.phase === 'downloading') && (
        <>
          <p className="update-title">easy-ssh v{state.version} is available</p>
          {state.notes && <p className="update-notes">{state.notes}</p>}
          <div className="update-bar"><span style={{ width: `${state.percent ?? 0}%` }} /></div>
          <p className="update-sub">Downloading in the background… {state.percent ?? 0}%</p>
          <div className="update-actions"><button className="btn btn-ghost" onClick={later}>Hide</button></div>
        </>
      )}
      {state.phase === 'ready' && (
        <>
          <p className="update-title">easy-ssh v{state.version} is ready</p>
          {state.notes && <p className="update-notes">{state.notes}</p>}
          <p className="update-sub">Restart now, or it installs the next time you quit.</p>
          <div className="update-actions">
            <button className="btn btn-ghost" onClick={later}>Later</button>
            <button className="btn btn-primary" onClick={() => void window.easySsh.updateInstall()}>Restart &amp; update</button>
          </div>
        </>
      )}
    </div>
  )
}
