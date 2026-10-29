import { nextListIndex } from '@shared/list-nav'
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import type { ConnectionPublic } from '@shared/types'
import { fillPlaceholders, fuzzyScore, parsePlaceholders, toTerminalInput, type Snippet } from '@shared/snippets'
import { errorMessage } from '../lib/errors'

export interface PaletteAction {
  id: string
  label: string
  hint?: string
  run: () => void
}

interface Props {
  connections: ConnectionPublic[]
  activeConnectionId?: string
  activeSessionId?: string
  actions: PaletteAction[]
  onConnect: (connection: ConnectionPublic) => void
  onRunInTerminal: (sessionId: string, input: string) => void
  notify: (message: string) => void
  onClose: () => void
}

type View =
  | { kind: 'list' }
  | { kind: 'fill'; snippet: Snippet; values: Record<string, string> }
  | { kind: 'edit'; draft: { id?: string; name: string; command: string; connectionId: string | null } }

interface Item {
  id: string
  group: string
  label: string
  hint?: string
  run: () => void
  edit?: () => void
}

export default function CommandPalette(props: Props) {
  const { connections, activeConnectionId, activeSessionId, actions, onConnect, onRunInTerminal, notify, onClose } = props
  const [query, setQuery] = useState('')
  const [snippets, setSnippets] = useState<Snippet[]>([])
  const [index, setIndex] = useState(0)
  const [view, setView] = useState<View>({ kind: 'list' })
  const [error, setError] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    window.easySsh.listSnippets().then(setSnippets, (err) => setError(errorMessage(err)))
  }, [])
  useEffect(() => {
    if (view.kind === 'list') inputRef.current?.focus()
  }, [view.kind])

  const run = (snippet: Snippet, values: Record<string, string>): void => {
    if (!activeSessionId) {
      notify('Open a connected terminal first.')
      return
    }
    const text = toTerminalInput(fillPlaceholders(snippet.command, values))
    if (text) onRunInTerminal(activeSessionId, text)
    onClose()
  }

  const startSnippet = (snippet: Snippet): void => {
    const placeholders = parsePlaceholders(snippet.command)
    if (placeholders.length === 0) run(snippet, {})
    else setView({ kind: 'fill', snippet, values: Object.fromEntries(placeholders.map((p) => [p.name, ''])) })
  }

  const items = useMemo<Item[]>(() => {
    const all: Item[] = []
    for (const s of snippets) {
      if (s.connectionId && s.connectionId !== activeConnectionId) continue
      all.push({
        id: `s:${s.id}`,
        group: s.connectionId ? 'Snippets · this host' : 'Snippets',
        label: s.name,
        hint: s.command.split('\n')[0],
        run: () => startSnippet(s),
        edit: () => setView({ kind: 'edit', draft: { ...s } })
      })
    }
    for (const c of connections) {
      all.push({ id: `c:${c.id}`, group: 'Connect', label: c.name, hint: `${c.username}@${c.host}`, run: () => { onConnect(c); onClose() } })
    }
    for (const a of actions) all.push({ id: `a:${a.id}`, group: 'Actions', label: a.label, hint: a.hint, run: () => { a.run(); onClose() } })
    all.push({
      id: 'new-snippet',
      group: 'Actions',
      label: 'New snippet…',
      hint: 'Use {{name}} for values asked before running',
      run: () => setView({ kind: 'edit', draft: { name: query.trim(), command: '', connectionId: null } })
    })
    if (!query.trim()) return all
    return all
      .map((item) => ({ item, score: Math.max(fuzzyScore(query, item.label), fuzzyScore(query, item.hint ?? '') - 50) }))
      .filter((x) => x.score >= 0)
      .sort((a, b) => b.score - a.score)
      .map((x) => x.item)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [snippets, connections, actions, query, activeConnectionId])

  const listRef = useRef<HTMLDivElement>(null)
  const navByKeyboard = useRef(true)
  useEffect(() => {
    navByKeyboard.current = true
    setIndex(0)
  }, [query])

  const pageSize = (): number => {
    const list = listRef.current
    const row = list?.querySelector<HTMLElement>('.palette-item')
    return list && row ? Math.max(1, Math.floor(list.clientHeight / row.offsetHeight) - 1) : 8
  }
  // Keep the active row (and its group header when it opens a group) in view, but only for keyboard moves.
  useEffect(() => {
    if (!navByKeyboard.current) return
    const list = listRef.current
    if (!list) return
    if (index === 0) {
      list.scrollTop = 0
      return
    }
    const row = list.querySelector<HTMLElement>(`[data-index="${index}"]`)
    if (!row) return
    const wrapper = row.parentElement
    const target = wrapper && wrapper.firstElementChild?.classList.contains('palette-group') ? wrapper : row
    const top = target.offsetTop
    const bottom = row.offsetTop + row.offsetHeight
    if (top < list.scrollTop) list.scrollTop = top
    else if (bottom > list.scrollTop + list.clientHeight) list.scrollTop = bottom - list.clientHeight
  }, [index, items])

  const onKey = (event: KeyboardEvent): void => {
    if (event.key === 'Escape') {
      event.stopPropagation()
      if (view.kind !== 'list') setView({ kind: 'list' })
      else onClose()
      return
    }
    if (view.kind !== 'list') return
    const next = nextListIndex(event.key, index, items.length, pageSize())
    if (next !== null && !((event.key === 'Home' || event.key === 'End') && query)) {
      event.preventDefault()
      navByKeyboard.current = true
      setIndex(next)
    } else if (event.key === 'Enter') {
      event.preventDefault()
      items[index]?.run()
    } else if (event.key === 'e' && (event.ctrlKey || event.metaKey)) {
      event.preventDefault()
      items[index]?.edit?.()
    }
  }

  const saveDraft = async (draft: { id?: string; name: string; command: string; connectionId: string | null }): Promise<void> => {
    try {
      const saved = await window.easySsh.saveSnippet(draft)
      setSnippets((list) => (list.some((s) => s.id === saved.id) ? list.map((s) => (s.id === saved.id ? saved : s)) : [...list, saved]))
      setView({ kind: 'list' })
      setError(null)
    } catch (err) {
      setError(errorMessage(err))
    }
  }

  const removeDraft = async (id: string): Promise<void> => {
    try {
      await window.easySsh.deleteSnippet(id)
      setSnippets((list) => list.filter((s) => s.id !== id))
      setView({ kind: 'list' })
    } catch (err) {
      setError(errorMessage(err))
    }
  }

  let lastGroup = ''
  return (
    <div className="modal-backdrop palette-backdrop" role="presentation" onMouseDown={onClose}>
      <div className="palette" role="dialog" aria-modal="true" aria-label="Command palette" onMouseDown={(e) => e.stopPropagation()} onKeyDown={onKey}>
        {view.kind === 'list' && (
          <>
            <input
              ref={inputRef}
              className="palette-input"
              placeholder="Run a snippet, connect to a host, or switch mode…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            <div className="palette-list" role="listbox" ref={listRef}>
              {items.map((item, i) => {
                const header = item.group !== lastGroup ? item.group : null
                lastGroup = item.group
                return (
                  <div key={item.id}>
                    {header && <div className="palette-group">{header}</div>}
                    <div
                      role="option"
                      aria-selected={i === index}
                      className={`palette-item${i === index ? ' active' : ''}`}
                      data-index={i}
                      onMouseMove={() => {
                        if (i === index) return
                        navByKeyboard.current = false
                        setIndex(i)
                      }}
                      onClick={() => item.run()}
                    >
                      <span>{item.label}</span>
                      {item.hint && <small>{item.hint}</small>}
                      {item.edit && (
                        <button type="button" className="palette-edit" onClick={(e) => { e.stopPropagation(); item.edit?.() }}>
                          Edit
                        </button>
                      )}
                    </div>
                  </div>
                )
              })}
              {items.length === 0 && <div className="palette-empty">Nothing matches. Press ↓ then Enter on “New snippet…” to save one.</div>}
            </div>
            <footer className="palette-foot">↑↓ move · Enter run · Ctrl+E edit snippet · Esc close</footer>
          </>
        )}
        {view.kind === 'fill' && (
          <form
            className="palette-form"
            onSubmit={(e) => {
              e.preventDefault()
              run(view.snippet, view.values)
            }}
          >
            <h3>{view.snippet.name}</h3>
            <code className="palette-preview">{fillPlaceholders(view.snippet.command, view.values)}</code>
            {Object.keys(view.values).map((name, i) => (
              <label key={name} className="field">
                <span>{name}</span>
                <input
                  autoFocus={i === 0}
                  value={view.values[name]}
                  onChange={(e) => setView({ ...view, values: { ...view.values, [name]: e.target.value } })}
                />
              </label>
            ))}
            <small className="hint">Values are shell-quoted automatically, so they cannot run extra commands.</small>
            <div className="modal-actions">
              <button type="button" className="btn btn-ghost" onClick={() => setView({ kind: 'list' })}>Back</button>
              <button type="submit" className="btn btn-primary">Run in terminal</button>
            </div>
          </form>
        )}
        {view.kind === 'edit' && (
          <form
            className="palette-form"
            onSubmit={(e) => {
              e.preventDefault()
              void saveDraft(view.draft)
            }}
          >
            <h3>{view.draft.id ? 'Edit snippet' : 'New snippet'}</h3>
            <label className="field">
              <span>Name</span>
              <input autoFocus value={view.draft.name} onChange={(e) => setView({ kind: 'edit', draft: { ...view.draft, name: e.target.value } })} />
            </label>
            <label className="field">
              <span>Command</span>
              <textarea
                rows={4}
                spellCheck={false}
                placeholder="sudo systemctl restart {{service}}"
                value={view.draft.command}
                onChange={(e) => setView({ kind: 'edit', draft: { ...view.draft, command: e.target.value } })}
              />
            </label>
            <label className="field">
              <span>Available on</span>
              <select
                value={view.draft.connectionId ?? ''}
                onChange={(e) => setView({ kind: 'edit', draft: { ...view.draft, connectionId: e.target.value || null } })}
              >
                <option value="">All hosts</option>
                {connections.map((c) => (
                  <option key={c.id} value={c.id}>{c.name}</option>
                ))}
              </select>
            </label>
            <small className="hint">{'{{name}}'} asks for a value (auto-quoted). {'{{name:raw}}'} inserts it as-is. Stored encrypted by your OS keychain.</small>
            {error && <p className="form-error">{error}</p>}
            <div className="modal-actions">
              {view.draft.id && (
                <button type="button" className="btn btn-ghost danger" onClick={() => void removeDraft(view.draft.id as string)}>Delete</button>
              )}
              <button type="button" className="btn btn-ghost" onClick={() => setView({ kind: 'list' })}>Cancel</button>
              <button type="submit" className="btn btn-primary">Save</button>
            </div>
          </form>
        )}
        {error && view.kind === 'list' && <p className="form-error palette-error">{error}</p>}
      </div>
    </div>
  )
}
