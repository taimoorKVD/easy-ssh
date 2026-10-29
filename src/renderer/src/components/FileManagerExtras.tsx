import { useEffect, useRef, useState } from 'react'
import type { LocalEntry } from '@shared/api'
import type { SearchHit, SearchMode } from '@shared/remote-search'
import { formatSize } from '@shared/remote-fs'
import { errorMessage } from '../lib/errors'

export function SearchPanel({
  sessionId,
  dir,
  onOpen,
  onClose
}: {
  sessionId: string
  dir: string
  onOpen: (hit: SearchHit) => void
  onClose: () => void
}) {
  const [mode, setMode] = useState<SearchMode>('name')
  const [pattern, setPattern] = useState('')
  const [hits, setHits] = useState<SearchHit[] | null>(null)
  const [running, setRunning] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const runningRef = useRef<string | null>(null)

  useEffect(() => () => {
    if (runningRef.current) void window.easySsh.sftpSearchCancel(runningRef.current)
  }, [])

  const start = async (): Promise<void> => {
    if (!pattern.trim()) return
    if (runningRef.current) void window.easySsh.sftpSearchCancel(runningRef.current)
    const id = crypto.randomUUID()
    runningRef.current = id
    setRunning(id)
    setError(null)
    setHits(null)
    try {
      const result = await window.easySsh.sftpSearch(sessionId, id, dir, mode, pattern)
      if (runningRef.current === id) setHits(result)
    } catch (err) {
      if (runningRef.current === id) setError(errorMessage(err))
    } finally {
      if (runningRef.current === id) {
        runningRef.current = null
        setRunning(null)
      }
    }
  }

  const cancel = (): void => {
    if (running) void window.easySsh.sftpSearchCancel(running)
  }

  return (
    <div className="fm-side fm-search">
      <div className="fm-side-head">
        <strong>Search in {dir}</strong>
        <button type="button" className="icon-button" onClick={onClose} aria-label="Close search">×</button>
      </div>
      <form
        className="fm-search-form"
        onSubmit={(e) => {
          e.preventDefault()
          void start()
        }}
      >
        <div className="segmented">
          <button type="button" className={mode === 'name' ? 'active' : ''} onClick={() => setMode('name')}>File names</button>
          <button type="button" className={mode === 'content' ? 'active' : ''} onClick={() => setMode('content')}>Contents</button>
        </div>
        <input autoFocus value={pattern} maxLength={200} onChange={(e) => setPattern(e.target.value)} placeholder={mode === 'name' ? 'part of a file name' : 'text to find (literal)'} spellCheck={false} />
        {running ? (
          <button type="button" className="btn btn-ghost fm-small" onClick={cancel}>Cancel</button>
        ) : (
          <button type="submit" className="btn btn-primary fm-small" disabled={!pattern.trim()}>Search</button>
        )}
      </form>
      <div className="fm-side-body">
        {running && <p className="hint">Searching…</p>}
        {error && <p className="form-error">{error}</p>}
        {hits && hits.length === 0 && <p className="hint">No matches.</p>}
        {hits && hits.length >= 500 && <p className="hint">Showing the first 500 matches.</p>}
        {hits?.map((hit, i) => (
          <button type="button" key={`${hit.path}:${hit.line ?? 0}:${i}`} className="fm-hit" onClick={() => onOpen(hit)} title={hit.path}>
            <span className="fm-hit-path">{hit.path.startsWith(dir) ? hit.path.slice(dir.length).replace(/^\//, '') : hit.path}{hit.line ? `:${hit.line}` : ''}</span>
            {hit.text && <span className="fm-hit-text">{hit.text}</span>}
          </button>
        ))}
      </div>
    </div>
  )
}

export function LocalPane({
  sessionId,
  remoteDir,
  remoteSelection,
  notify,
  onClose
}: {
  sessionId: string
  remoteDir: string | null
  remoteSelection: string[]
  notify: (message: string) => void
  onClose: () => void
}) {
  const [dir, setDir] = useState<string | null>(() => localStorage.getItem('easy-ssh.localPane') || null)
  const [listing, setListing] = useState<{ path: string; parent: string; entries: LocalEntry[] } | null>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [error, setError] = useState<string | null>(null)
  const [tick, setTick] = useState(0)

  useEffect(() => {
    if (dir) return
    void window.easySsh.localHome().then(setDir)
  }, [dir])

  useEffect(() => {
    if (!dir) return
    setError(null)
    window.easySsh.localList(dir).then(
      (result) => {
        result.entries.sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === 'dir' ? -1 : 1))
        setListing(result)
        setSelected(new Set())
        localStorage.setItem('easy-ssh.localPane', result.path)
      },
      (err) => setError(errorMessage(err))
    )
  }, [dir, tick])

  const refresh = (): void => setTick((t) => t + 1)

  const uploadSelected = async (): Promise<void> => {
    if (!remoteDir || selected.size === 0) return
    try {
      await window.easySsh.sftpUpload(sessionId, [...selected], remoteDir)
      notify(`Uploaded to ${remoteDir}`)
    } catch (err) {
      notify(errorMessage(err))
    }
  }
  const downloadHere = async (): Promise<void> => {
    if (!listing || remoteSelection.length === 0) return
    try {
      await window.easySsh.sftpDownloadTo(sessionId, remoteSelection, listing.path)
      notify(`Downloaded to ${listing.path}`)
      refresh()
    } catch (err) {
      notify(errorMessage(err))
    }
  }

  return (
    <div className="fm-side fm-local">
      <div className="fm-side-head">
        <strong title={listing?.path}>This computer</strong>
        <button type="button" className="icon-button" onClick={onClose} aria-label="Close local pane">×</button>
      </div>
      <div className="fm-local-bar">
        <button type="button" className="fm-btn" disabled={!listing || listing.parent === listing.path} onClick={() => listing && setDir(listing.parent)} title="Up">↑</button>
        <button type="button" className="fm-btn" onClick={refresh} title="Refresh">⟳</button>
        <span className="fm-local-path" title={listing?.path}>{listing?.path}</span>
      </div>
      <div className="fm-local-actions">
        <button type="button" className="btn btn-ghost fm-small" disabled={!selected.size || !remoteDir} onClick={() => void uploadSelected()}>Upload →</button>
        <button type="button" className="btn btn-ghost fm-small" disabled={!remoteSelection.length || !listing} onClick={() => void downloadHere()}>← Download selected</button>
      </div>
      <div className="fm-side-body">
        {error && <p className="form-error">{error}</p>}
        {listing?.entries.map((entry) => (
          <button
            type="button"
            key={entry.path}
            className={`fm-local-row${selected.has(entry.path) ? ' selected' : ''}`}
            onClick={(e) =>
              setSelected((cur) => {
                const next = new Set(e.ctrlKey || e.metaKey ? cur : [])
                if (cur.has(entry.path) && (e.ctrlKey || e.metaKey)) next.delete(entry.path)
                else next.add(entry.path)
                return next
              })
            }
            onDoubleClick={() => entry.kind === 'dir' && setDir(entry.path)}
          >
            <span>{entry.kind === 'dir' ? '📁' : '📄'}</span>
            <span className="fm-local-name">{entry.name}</span>
            <span className="hint">{entry.kind === 'file' ? formatSize(entry.size) : ''}</span>
          </button>
        ))}
      </div>
    </div>
  )
}
