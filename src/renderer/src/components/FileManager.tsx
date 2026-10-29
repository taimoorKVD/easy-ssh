import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent, type KeyboardEvent, type MouseEvent } from 'react'
import {
  breadcrumbs,
  filterHidden,
  formatMode,
  formatSize,
  isDirLike,
  isLikelyText,
  joinRemote,
  nextSelection,
  octalMode,
  parentRemote,
  parseOctalMode,
  sortEntries,
  validFileName,
  TEXT_EDIT_LIMIT,
  type RemoteEntry,
  type SortDir,
  type SortKey,
  type TransferProgress
} from '@shared/remote-fs'
import { errorMessage } from '../lib/errors'
import { ConfirmDialog } from './Overlays'

interface FileManagerProps {
  sessionId: string
  active: boolean
  connected: boolean
  notify: (message: string) => void
  onOpenTerminalHere: (path: string) => void
}

type Menu = { x: number; y: number; target: RemoteEntry | null }
type Editor = { path: string; name: string; original: string; content: string; saving: boolean; error: string | null }

const dateFormat = new Intl.DateTimeFormat(undefined, { year: 'numeric', month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit' })

function FileIcon({ entry }: { entry: RemoteEntry }) {
  if (isDirLike(entry)) {
    return (
      <svg className="fm-icon dir" viewBox="0 0 24 24" aria-hidden="true">
        <path d="M3.5 7.5a2 2 0 0 1 2-2h4l2 2h7a2 2 0 0 1 2 2v7.5a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z" />
        {entry.kind === 'link' && <path d="M10 14.5h4m-1.5-1.5 1.5 1.5-1.5 1.5" />}
      </svg>
    )
  }
  return (
    <svg className={`fm-icon ${entry.kind === 'link' ? 'link' : isLikelyText(entry.name) ? 'text' : 'file'}`} viewBox="0 0 24 24" aria-hidden="true">
      <path d="M6.5 3.5h7l4 4v12a1 1 0 0 1-1 1h-10a1 1 0 0 1-1-1v-15a1 1 0 0 1 1-1z" />
      <path d="M13.5 3.5v4h4" />
      {isLikelyText(entry.name) && <path d="M8.5 12.5h7m-7 3h5" />}
    </svg>
  )
}

export function FileManager({ sessionId, active, connected, notify, onOpenTerminalHere }: FileManagerProps) {
  const [path, setPath] = useState<string | null>(null)
  const [entries, setEntries] = useState<RemoteEntry[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [history, setHistory] = useState<string[]>([])
  const [editingPath, setEditingPath] = useState<string | null>(null)
  const [sortKey, setSortKey] = useState<SortKey>('name')
  const [sortDir, setSortDir] = useState<SortDir>('asc')
  const [showHidden, setShowHidden] = useState(false)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [anchor, setAnchor] = useState<string | null>(null)
  const [renaming, setRenaming] = useState<{ path: string; value: string } | null>(null)
  const [creating, setCreating] = useState<{ kind: 'dir' | 'file'; value: string } | null>(null)
  const [menu, setMenu] = useState<Menu | null>(null)
  const [confirmDelete, setConfirmDelete] = useState<RemoteEntry[] | null>(null)
  const [busy, setBusy] = useState(false)
  const [chmod, setChmod] = useState<{ entry: RemoteEntry; value: string } | null>(null)
  const [editor, setEditor] = useState<Editor | null>(null)
  const [transfers, setTransfers] = useState<TransferProgress[]>([])
  const [dragOver, setDragOver] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const loadSeq = useRef(0)

  const load = useCallback(
    async (target: string, pushHistory = true) => {
      const seq = ++loadSeq.current
      setLoading(true)
      setError(null)
      try {
        const result = await window.easySsh.sftpList(sessionId, target)
        if (seq !== loadSeq.current) return
        setPath((current) => {
          if (pushHistory && current && current !== result.path) setHistory((h) => [...h.slice(-49), current])
          return result.path
        })
        setEntries(result.entries)
        setSelected(new Set())
        setAnchor(null)
      } catch (err) {
        if (seq === loadSeq.current) setError(errorMessage(err))
      } finally {
        if (seq === loadSeq.current) setLoading(false)
      }
    },
    [sessionId]
  )

  // Start at the home directory the first time the file manager is shown on a live session.
  useEffect(() => {
    if (!active || !connected || path !== null || loading) return
    void (async () => {
      setLoading(true)
      try {
        const home = await window.easySsh.sftpHome(sessionId)
        await load(home, false)
      } catch (err) {
        setError(errorMessage(err))
        setLoading(false)
      }
    })()
  }, [active, connected, path, loading, sessionId, load])

  // A new session id (reconnect) keeps the folder but re-lists it.
  const lastSession = useRef(sessionId)
  useEffect(() => {
    if (lastSession.current === sessionId) return
    lastSession.current = sessionId
    if (path && connected) void load(path, false)
  }, [sessionId, connected, path, load])

  useEffect(() => {
    return window.easySsh.onSftpProgress((progress) => {
      if (progress.sessionId !== sessionId) return
      setTransfers((current) => {
        const others = current.filter((item) => item.transferId !== progress.transferId)
        return [...others, progress]
      })
      if (progress.state !== 'running') {
        setTimeout(() => setTransfers((current) => current.filter((item) => item.transferId !== progress.transferId)), progress.state === 'done' ? 2500 : 8000)
      }
    })
  }, [sessionId])

  useEffect(() => {
    if (active && !editor && !chmod && !confirmDelete) rootRef.current?.focus()
  }, [active, editor, chmod, confirmDelete])

  useEffect(() => {
    if (!menu) return
    const close = (): void => setMenu(null)
    window.addEventListener('click', close)
    window.addEventListener('blur', close)
    return () => {
      window.removeEventListener('click', close)
      window.removeEventListener('blur', close)
    }
  }, [menu])

  const visible = useMemo(() => sortEntries(filterHidden(entries, showHidden), sortKey, sortDir), [entries, showHidden, sortKey, sortDir])
  const order = useMemo(() => visible.map((entry) => entry.path), [visible])
  const selectedEntries = visible.filter((entry) => selected.has(entry.path))

  const refresh = (): void => {
    if (path) void load(path, false)
  }

  const goBack = (): void => {
    const previous = history[history.length - 1]
    if (!previous) return
    setHistory((h) => h.slice(0, -1))
    void load(previous, false)
  }

  const goUp = (): void => {
    if (path && path !== '/') void load(parentRemote(path))
  }

  async function run(action: () => Promise<unknown>, success?: string): Promise<boolean> {
    setBusy(true)
    try {
      await action()
      if (success) notify(success)
      return true
    } catch (err) {
      notify(errorMessage(err))
      return false
    } finally {
      setBusy(false)
    }
  }

  async function openEntry(entry: RemoteEntry): Promise<void> {
    if (isDirLike(entry)) {
      void load(entry.path)
      return
    }
    if (isLikelyText(entry.name) && entry.size <= TEXT_EDIT_LIMIT) {
      setBusy(true)
      try {
        const file = await window.easySsh.sftpReadText(sessionId, entry.path)
        setEditor({ path: entry.path, name: entry.name, original: file.content, content: file.content, saving: false, error: null })
        setBusy(false)
        return
      } catch (err) {
        setBusy(false)
        const message = errorMessage(err)
        if (!message.includes('binary')) {
          notify(message)
          return
        }
      }
    }
    await run(() => window.easySsh.sftpOpen(sessionId, entry.path), `Opened ${entry.name}`)
  }

  async function saveEditor(): Promise<void> {
    if (!editor) return
    setEditor({ ...editor, saving: true, error: null })
    try {
      await window.easySsh.sftpWriteText(sessionId, editor.path, editor.content)
      setEditor((current) => (current ? { ...current, original: current.content, saving: false } : current))
      notify(`Saved ${editor.name}`)
      refresh()
    } catch (err) {
      setEditor((current) => (current ? { ...current, saving: false, error: errorMessage(err) } : current))
    }
  }

  async function commitRename(): Promise<void> {
    if (!renaming) return
    const entry = entries.find((item) => item.path === renaming.path)
    const value = renaming.value.trim()
    setRenaming(null)
    if (!entry || value === entry.name) return
    const invalid = validFileName(value)
    if (invalid) {
      notify(invalid)
      return
    }
    if (await run(() => window.easySsh.sftpRename(sessionId, entry.path, joinRemote(parentRemote(entry.path), value)))) refresh()
  }

  async function commitCreate(): Promise<void> {
    if (!creating || !path) return
    const value = creating.value.trim()
    const kind = creating.kind
    setCreating(null)
    if (!value) return
    const invalid = validFileName(value)
    if (invalid) {
      notify(invalid)
      return
    }
    const target = joinRemote(path, value)
    const ok = await run(() => (kind === 'dir' ? window.easySsh.sftpMkdir(sessionId, target) : window.easySsh.sftpCreateFile(sessionId, target)))
    if (ok) refresh()
  }

  async function doDelete(): Promise<void> {
    if (!confirmDelete) return
    const items = confirmDelete
    const ok = await run(
      () => window.easySsh.sftpRemove(sessionId, items.map((item) => item.path)),
      items.length === 1 ? `Deleted ${items[0].name}` : `Deleted ${items.length} items`
    )
    setConfirmDelete(null)
    if (ok || items.length) refresh()
  }

  async function doChmod(): Promise<void> {
    if (!chmod) return
    const mode = parseOctalMode(chmod.value)
    if (mode === null) {
      notify('Enter permissions as octal, like 644 or 755.')
      return
    }
    const entry = chmod.entry
    setChmod(null)
    if (await run(() => window.easySsh.sftpChmod(sessionId, entry.path, mode), `Permissions of ${entry.name} set to ${octalMode(mode)}`)) refresh()
  }

  async function upload(folders: boolean): Promise<void> {
    if (!path) return
    const target = path
    try {
      const done = await window.easySsh.sftpUploadPick(sessionId, target, folders)
      if (done) refresh()
    } catch (err) {
      notify(errorMessage(err))
      refresh()
    }
  }

  async function download(items: RemoteEntry[]): Promise<void> {
    if (!items.length) return
    try {
      const single = items.length === 1 && !isDirLike(items[0])
      const done = await window.easySsh.sftpDownload(sessionId, items.map((item) => item.path), single)
      if (done) notify(items.length === 1 ? `Downloaded ${items[0].name}` : `Downloaded ${items.length} items`)
    } catch (err) {
      notify(errorMessage(err))
    }
  }

  async function onDrop(event: DragEvent<HTMLDivElement>): Promise<void> {
    event.preventDefault()
    setDragOver(false)
    if (!path) return
    const files = Array.from(event.dataTransfer.files)
    const locals = files.map((file) => window.easySsh.pathForFile(file)).filter(Boolean)
    if (!locals.length) return
    const target = path
    try {
      await window.easySsh.sftpUpload(sessionId, locals, target)
      notify(locals.length === 1 ? 'Upload finished' : `Uploaded ${locals.length} items`)
    } catch (err) {
      notify(errorMessage(err))
    }
    if (target === path) refresh()
  }

  function copyPath(items: RemoteEntry[]): void {
    const text = items.length ? items.map((item) => item.path).join('\n') : path ?? ''
    void window.easySsh.clipboardWrite(text)
    notify(items.length > 1 ? `Copied ${items.length} paths` : 'Path copied')
  }

  function clickRow(event: MouseEvent, entry: RemoteEntry): void {
    const result = nextSelection(order, selected, anchor, entry.path, { ctrl: event.ctrlKey || event.metaKey, shift: event.shiftKey })
    setSelected(result.selected)
    setAnchor(result.anchor)
  }

  function onContext(event: MouseEvent, entry: RemoteEntry | null): void {
    event.preventDefault()
    event.stopPropagation()
    if (entry && !selected.has(entry.path)) {
      setSelected(new Set([entry.path]))
      setAnchor(entry.path)
    }
    if (!entry) setSelected(new Set())
    const bounds = rootRef.current?.getBoundingClientRect()
    const x = Math.min(event.clientX, (bounds?.right ?? window.innerWidth) - 220)
    const y = Math.min(event.clientY, (bounds?.bottom ?? window.innerHeight) - 330)
    setMenu({ x, y, target: entry })
  }

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    const target = event.target as HTMLElement
    if (target.closest('input, textarea')) return
    const ctrl = event.ctrlKey || event.metaKey
    if (ctrl && event.key.toLowerCase() === 'a') {
      event.preventDefault()
      setSelected(new Set(order))
      return
    }
    if (event.key === 'Enter' && selectedEntries.length === 1) {
      event.preventDefault()
      void openEntry(selectedEntries[0])
    } else if (event.key === 'Backspace' || (event.altKey && event.key === 'ArrowUp')) {
      event.preventDefault()
      goUp()
    } else if (event.altKey && event.key === 'ArrowLeft') {
      event.preventDefault()
      goBack()
    } else if (event.key === 'Delete' && selectedEntries.length) {
      event.preventDefault()
      setConfirmDelete(selectedEntries)
    } else if (event.key === 'F2' && selectedEntries.length === 1) {
      event.preventDefault()
      setRenaming({ path: selectedEntries[0].path, value: selectedEntries[0].name })
    } else if (event.key === 'F5' || (ctrl && event.key.toLowerCase() === 'r')) {
      event.preventDefault()
      refresh()
    } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      if (!order.length) return
      const current = anchor ? order.indexOf(anchor) : -1
      const next = Math.max(0, Math.min(order.length - 1, current + (event.key === 'ArrowDown' ? 1 : -1)))
      const result = nextSelection(order, selected, anchor, order[next], { ctrl: false, shift: event.shiftKey })
      setSelected(result.selected)
      setAnchor(event.shiftKey ? result.anchor : order[next])
      document.getElementById(`fm-row-${sessionId}-${next}`)?.scrollIntoView({ block: 'nearest' })
    } else if (event.key === 'Escape') {
      setSelected(new Set())
    }
  }

  function sortBy(key: SortKey): void {
    if (key === sortKey) setSortDir(sortDir === 'asc' ? 'desc' : 'asc')
    else {
      setSortKey(key)
      setSortDir(key === 'name' ? 'asc' : 'desc')
    }
  }

  const header = (key: SortKey, label: string, className: string) => (
    <button type="button" className={`fm-col ${className}${sortKey === key ? ' sorted' : ''}`} onClick={() => sortBy(key)}>
      {label}
      {sortKey === key && <span className="fm-sort">{sortDir === 'asc' ? '▲' : '▼'}</span>}
    </button>
  )

  const menuTarget = menu?.target ?? null
  const menuItems = menuTarget ? selectedEntries : []

  return (
    <div
      ref={rootRef}
      className={`file-manager${active ? ' active' : ''}${dragOver ? ' drag-over' : ''}`}
      tabIndex={-1}
      onKeyDown={onKeyDown}
      onDragOver={(event) => {
        if (!event.dataTransfer.types.includes('Files')) return
        event.preventDefault()
        event.dataTransfer.dropEffect = 'copy'
        setDragOver(true)
      }}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragOver(false)
      }}
      onDrop={(event) => void onDrop(event)}
    >
      <div className="fm-toolbar">
        <div className="fm-nav">
          <button type="button" className="fm-btn" title="Back (Alt+←)" disabled={!history.length} onClick={goBack}>
            ←
          </button>
          <button type="button" className="fm-btn" title="Up (Backspace)" disabled={!path || path === '/'} onClick={goUp}>
            ↑
          </button>
          <button type="button" className="fm-btn" title="Refresh (F5)" disabled={!path} onClick={refresh}>
            ⟳
          </button>
        </div>
        {editingPath !== null ? (
          <form
            className="fm-path editing"
            onSubmit={(event) => {
              event.preventDefault()
              const value = editingPath.trim()
              setEditingPath(null)
              if (value) void load(value.startsWith('/') ? value : joinRemote(path ?? '/', value))
            }}
          >
            <input
              autoFocus
              value={editingPath}
              spellCheck={false}
              onChange={(event) => setEditingPath(event.target.value)}
              onBlur={() => setEditingPath(null)}
              onKeyDown={(event) => {
                if (event.key === 'Escape') setEditingPath(null)
              }}
            />
          </form>
        ) : (
          <div className="fm-path" onDoubleClick={() => setEditingPath(path ?? '/')} title="Double-click to type a path">
            {path &&
              breadcrumbs(path).map((crumb, index) => (
                <span key={crumb.path} className="fm-crumb-wrap">
                  {index > 1 && <span className="fm-sep">/</span>}
                  <button type="button" className="fm-crumb" onClick={() => void load(crumb.path)}>
                    {crumb.name}
                  </button>
                </span>
              ))}
            <button type="button" className="fm-edit-path" title="Edit path" onClick={() => setEditingPath(path ?? '/')}>
              ✎
            </button>
          </div>
        )}
        <div className="fm-actions">
          <button type="button" className="btn btn-ghost fm-small" disabled={!path || busy} onClick={() => setCreating({ kind: 'dir', value: '' })}>
            New folder
          </button>
          <button type="button" className="btn btn-ghost fm-small" disabled={!path || busy} onClick={() => setCreating({ kind: 'file', value: '' })}>
            New file
          </button>
          <button type="button" className="btn btn-ghost fm-small" disabled={!path} onClick={() => void upload(false)} title="Upload files (or drag them here)">
            Upload
          </button>
          <button type="button" className="btn btn-ghost fm-small" disabled={!path} onClick={() => void upload(true)} title="Upload folders">
            Upload folder
          </button>
          <button type="button" className="btn btn-ghost fm-small" disabled={!selectedEntries.length} onClick={() => void download(selectedEntries)}>
            Download
          </button>
          <label className="fm-toggle" title="Show hidden files">
            <input type="checkbox" checked={showHidden} onChange={(event) => setShowHidden(event.target.checked)} />
            Hidden
          </label>
        </div>
      </div>

      <div className="fm-table" role="grid" aria-busy={loading} onContextMenu={(event) => onContext(event, null)} onClick={(event) => {
        if (event.target === event.currentTarget) setSelected(new Set())
      }}>
        <div className="fm-head" role="row">
          <span className="fm-col icon-col" />
          {header('name', 'Name', 'name-col')}
          {header('size', 'Size', 'size-col')}
          {header('mtime', 'Modified', 'date-col')}
          {header('mode', 'Permissions', 'perm-col')}
        </div>
        <div className="fm-rows" onClick={(event) => {
          if (event.target === event.currentTarget) setSelected(new Set())
        }}>
          {creating && (
            <div className="fm-row creating">
              <span className="icon-col">
                <FileIcon entry={{ name: creating.value, path: '', kind: creating.kind === 'dir' ? 'dir' : 'file', size: 0, mtime: 0, mode: 0 }} />
              </span>
              <span className="name-col">
                <input
                  autoFocus
                  className="fm-inline-input"
                  placeholder={creating.kind === 'dir' ? 'Folder name' : 'File name'}
                  value={creating.value}
                  onChange={(event) => setCreating({ ...creating, value: event.target.value })}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') void commitCreate()
                    if (event.key === 'Escape') setCreating(null)
                  }}
                  onBlur={() => void commitCreate()}
                />
              </span>
            </div>
          )}
          {visible.map((entry, index) => (
            <div
              key={entry.path}
              id={`fm-row-${sessionId}-${index}`}
              role="row"
              aria-selected={selected.has(entry.path)}
              className={`fm-row${selected.has(entry.path) ? ' selected' : ''}${entry.name.startsWith('.') ? ' hidden-file' : ''}`}
              onClick={(event) => clickRow(event, entry)}
              onDoubleClick={() => void openEntry(entry)}
              onContextMenu={(event) => onContext(event, entry)}
            >
              <span className="icon-col">
                <FileIcon entry={entry} />
              </span>
              <span className="name-col" title={entry.path}>
                {renaming?.path === entry.path ? (
                  <input
                    autoFocus
                    className="fm-inline-input"
                    value={renaming.value}
                    onClick={(event) => event.stopPropagation()}
                    onDoubleClick={(event) => event.stopPropagation()}
                    onFocus={(event) => {
                      const dot = entry.name.lastIndexOf('.')
                      event.target.setSelectionRange(0, dot > 0 && !isDirLike(entry) ? dot : entry.name.length)
                    }}
                    onChange={(event) => setRenaming({ ...renaming, value: event.target.value })}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') void commitRename()
                      if (event.key === 'Escape') setRenaming(null)
                    }}
                    onBlur={() => void commitRename()}
                  />
                ) : (
                  <span className="fm-name">
                    {entry.name}
                    {entry.kind === 'link' && <span className="fm-badge">link</span>}
                  </span>
                )}
              </span>
              <span className="size-col">{isDirLike(entry) ? '—' : formatSize(entry.size)}</span>
              <span className="date-col">{entry.mtime ? dateFormat.format(entry.mtime) : '—'}</span>
              <span className="perm-col" title={octalMode(entry.mode)}>
                {formatMode(entry.mode)}
              </span>
            </div>
          ))}
          {!loading && !error && path && visible.length === 0 && !creating && (
            <div className="fm-empty">
              <strong>This folder is empty</strong>
              <p>{entries.length ? 'Only hidden files here. Turn on “Hidden” to see them.' : 'Drop files here to upload, or create a new file or folder.'}</p>
            </div>
          )}
          {error && (
            <div className="fm-empty error">
              <strong>Could not open this folder</strong>
              <p>{error}</p>
              <div className="welcome-actions">
                <button type="button" className="btn btn-ghost" onClick={() => (path ? refresh() : setPath(null))}>
                  Try again
                </button>
                {path && path !== '/' && (
                  <button type="button" className="btn btn-ghost" onClick={goUp}>
                    Go up
                  </button>
                )}
              </div>
            </div>
          )}
          {!connected && !path && !error && (
            <div className="fm-empty">
              <strong>Not connected</strong>
              <p>The file manager opens once the session is connected.</p>
            </div>
          )}
        </div>
        {(loading || busy) && <div className="fm-loading" aria-live="polite"><span className="fm-spinner" />{loading ? 'Loading…' : 'Working…'}</div>}
      </div>

      <div className="fm-statusline">
        <span>
          {visible.length} item{visible.length === 1 ? '' : 's'}
          {selectedEntries.length ? ` · ${selectedEntries.length} selected` : ''}
          {selectedEntries.length && selectedEntries.every((entry) => !isDirLike(entry))
            ? ` · ${formatSize(selectedEntries.reduce((sum, entry) => sum + entry.size, 0))}`
            : ''}
        </span>
        <span className="hint">Double-click to open · F2 rename · Del delete · Backspace up · drag files in to upload</span>
      </div>

      {transfers.length > 0 && (
        <div className="fm-transfers">
          {transfers.map((transfer) => {
            const pct = transfer.bytesTotal ? Math.min(100, Math.round((transfer.bytesDone / transfer.bytesTotal) * 100)) : transfer.state === 'done' ? 100 : 0
            return (
              <div key={transfer.transferId} className={`fm-transfer ${transfer.state}`}>
                <div className="fm-transfer-top">
                  <span>{transfer.label}</span>
                  <span>
                    {transfer.state === 'error'
                      ? 'Failed'
                      : transfer.state === 'done'
                        ? 'Done'
                        : `${pct}% · ${formatSize(transfer.bytesDone)} / ${formatSize(transfer.bytesTotal)}`}
                  </span>
                </div>
                <div className="fm-bar">
                  <span style={{ width: `${transfer.state === 'error' ? 100 : pct}%` }} />
                </div>
                {transfer.error && <small>{transfer.error}</small>}
                {transfer.filesTotal > 1 && transfer.state === 'running' && (
                  <small>
                    {transfer.filesDone} of {transfer.filesTotal} files
                  </small>
                )}
              </div>
            )
          })}
        </div>
      )}

      {dragOver && <div className="fm-drop">Drop to upload to {path}</div>}

      {menu && (
        <div className="fm-menu" style={{ left: menu.x, top: menu.y }} onClick={(event) => event.stopPropagation()} role="menu">
          {menuTarget && menuItems.length === 1 && (
            <button type="button" onClick={() => { setMenu(null); void openEntry(menuTarget) }}>
              {isDirLike(menuTarget) ? 'Open' : isLikelyText(menuTarget.name) ? 'Edit' : 'Open'}<kbd>Enter</kbd>
            </button>
          )}
          {menuTarget && menuItems.length === 1 && !isDirLike(menuTarget) && (
            <button type="button" onClick={() => { setMenu(null); void run(() => window.easySsh.sftpOpen(sessionId, menuTarget.path), `Opened ${menuTarget.name}`) }}>
              Open with system app
            </button>
          )}
          {menuItems.length > 0 && (
            <button type="button" onClick={() => { setMenu(null); void download(menuItems) }}>
              Download{menuItems.length > 1 ? ` ${menuItems.length} items` : ''}
            </button>
          )}
          {menuTarget && menuItems.length === 1 && (
            <button type="button" onClick={() => { setMenu(null); setRenaming({ path: menuTarget.path, value: menuTarget.name }) }}>
              Rename<kbd>F2</kbd>
            </button>
          )}
          {menuTarget && menuItems.length === 1 && (
            <button type="button" onClick={() => { setMenu(null); setChmod({ entry: menuTarget, value: octalMode(menuTarget.mode) }) }}>
              Permissions…
            </button>
          )}
          <button type="button" onClick={() => { setMenu(null); copyPath(menuItems) }}>
            Copy path
          </button>
          <button
            type="button"
            onClick={() => {
              setMenu(null)
              const dir = menuTarget && menuItems.length === 1 && isDirLike(menuTarget) ? menuTarget.path : path
              if (dir) onOpenTerminalHere(dir)
            }}
          >
            Open terminal here
          </button>
          <div className="fm-menu-sep" />
          <button type="button" onClick={() => { setMenu(null); setCreating({ kind: 'dir', value: '' }) }}>New folder</button>
          <button type="button" onClick={() => { setMenu(null); setCreating({ kind: 'file', value: '' }) }}>New file</button>
          <button type="button" onClick={() => { setMenu(null); void upload(false) }}>Upload files…</button>
          <button type="button" onClick={() => { setMenu(null); refresh() }}>Refresh<kbd>F5</kbd></button>
          {menuItems.length > 0 && (
            <>
              <div className="fm-menu-sep" />
              <button type="button" className="danger" onClick={() => { setMenu(null); setConfirmDelete(menuItems) }}>
                Delete{menuItems.length > 1 ? ` ${menuItems.length} items` : ''}<kbd>Del</kbd>
              </button>
            </>
          )}
        </div>
      )}

      {confirmDelete && (
        <ConfirmDialog
          title={confirmDelete.length === 1 ? `Delete ${confirmDelete[0].name}?` : `Delete ${confirmDelete.length} items?`}
          body={
            confirmDelete.some(isDirLike)
              ? 'Folders are deleted with everything inside them. This cannot be undone.'
              : 'This permanently deletes the file from the server. This cannot be undone.'
          }
          confirmLabel="Delete"
          busy={busy}
          onCancel={() => setConfirmDelete(null)}
          onConfirm={() => void doDelete()}
        />
      )}

      {chmod && <ChmodDialog entry={chmod.entry} value={chmod.value} onChange={(value) => setChmod({ ...chmod, value })} onCancel={() => setChmod(null)} onApply={() => void doChmod()} />}

      {editor && (
        <div className="modal-backdrop" role="presentation">
          <div className="modal fm-editor" role="dialog" aria-modal="true" aria-label={`Edit ${editor.name}`}>
            <header className="modal-head">
              <div>
                <h2>
                  {editor.name}
                  {editor.content !== editor.original && <span className="fm-dirty"> ●</span>}
                </h2>
                <p className="fm-editor-path">{editor.path}</p>
              </div>
            </header>
            <textarea
              autoFocus
              spellCheck={false}
              value={editor.content}
              onChange={(event) => setEditor({ ...editor, content: event.target.value })}
              onKeyDown={(event) => {
                if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
                  event.preventDefault()
                  void saveEditor()
                }
                if (event.key === 'Tab') {
                  event.preventDefault()
                  const el = event.currentTarget
                  const start = el.selectionStart
                  const next = `${editor.content.slice(0, start)}  ${editor.content.slice(el.selectionEnd)}`
                  setEditor({ ...editor, content: next })
                  requestAnimationFrame(() => el.setSelectionRange(start + 2, start + 2))
                }
                if (event.key === 'Escape' && editor.content === editor.original) setEditor(null)
              }}
            />
            {editor.error && <p className="form-error">{editor.error}</p>}
            <footer className="modal-actions">
              <span className="hint fm-editor-hint">Ctrl+S to save</span>
              <button
                type="button"
                className="btn btn-ghost"
                disabled={editor.saving}
                onClick={() => {
                  if (editor.content !== editor.original && !window.confirm('Discard unsaved changes?')) return
                  setEditor(null)
                }}
              >
                Close
              </button>
              <button type="button" className="btn btn-primary" disabled={editor.saving || editor.content === editor.original} onClick={() => void saveEditor()}>
                {editor.saving ? 'Saving…' : 'Save to server'}
              </button>
            </footer>
          </div>
        </div>
      )}
    </div>
  )
}

const PERM_LABELS = ['Owner', 'Group', 'Others']
const PERM_BITS = [
  ['Read', 4],
  ['Write', 2],
  ['Execute', 1]
] as const

function ChmodDialog({
  entry,
  value,
  onChange,
  onCancel,
  onApply
}: {
  entry: RemoteEntry
  value: string
  onChange: (value: string) => void
  onCancel: () => void
  onApply: () => void
}) {
  const mode = parseOctalMode(value)
  const bits = mode ?? 0
  const toggle = (who: number, bit: number): void => {
    const shift = (2 - who) * 3
    const next = bits ^ (bit << shift)
    onChange(octalMode(next))
  }
  return (
    <div className="modal-backdrop" role="presentation">
      <form
        className="modal modal-compact"
        role="dialog"
        aria-modal="true"
        onSubmit={(event) => {
          event.preventDefault()
          onApply()
        }}
      >
        <header className="modal-head">
          <div>
            <h2>Permissions</h2>
            <p>{entry.path}</p>
          </div>
        </header>
        <div className="fm-perm-grid">
          <span />
          {PERM_BITS.map(([label]) => (
            <span key={label} className="fm-perm-head">
              {label}
            </span>
          ))}
          {PERM_LABELS.map((who, index) => (
            <div key={who} className="fm-perm-row">
              <span>{who}</span>
              {PERM_BITS.map(([label, bit]) => (
                <label key={label}>
                  <input type="checkbox" checked={Boolean(bits & (bit << ((2 - index) * 3)))} disabled={mode === null} onChange={() => toggle(index, bit)} />
                </label>
              ))}
            </div>
          ))}
        </div>
        <label className="field">
          <span>Octal</span>
          <input autoFocus value={value} onChange={(event) => onChange(event.target.value)} spellCheck={false} />
          <small>{mode === null ? 'Use 3 or 4 octal digits, like 644 or 0755.' : formatMode((entry.mode & 0o170000) | mode)}</small>
        </label>
        <footer className="modal-actions">
          <button type="button" className="btn btn-ghost" onClick={onCancel}>
            Cancel
          </button>
          <button type="submit" className="btn btn-primary" disabled={mode === null}>
            Apply
          </button>
        </footer>
      </form>
    </div>
  )
}
