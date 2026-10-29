import { useState } from 'react'
import { LogoMark } from './Icons'
import type { ConnectionPublic, SessionPhase } from '@shared/types'
import { IconEdit, IconExternal, IconPlus, IconSearch, IconTrash } from './Icons'

export interface ConnectionGroup {
  group: string
  items: ConnectionPublic[]
}

interface SidebarProps {
  connections: ConnectionPublic[]
  phases: Record<string, SessionPhase | undefined>
  activeConnectionId?: string
  encryptionAvailable: boolean
  encryptionReason?: string
  version: string
  backend: string
  onConnect: (connection: ConnectionPublic) => void
  onEdit: (connection: ConnectionPublic) => void
  onDelete: (connection: ConnectionPublic) => void
  onSystemTerminal: (connection: ConnectionPublic) => void
  onCreate: () => void
  onImport: () => void
  onExport: () => void
  collapsed: boolean
  onToggleCollapsed: () => void
}

export function groupConnections(connections: ConnectionPublic[], query: string): ConnectionGroup[] {
  const needle = query.trim().toLowerCase()
  const filtered = needle
    ? connections.filter((connection) =>
        [connection.name, connection.host, connection.username, connection.group, connection.defaultDirectory, `${connection.username}@${connection.host}`]
          .join(' ')
          .toLowerCase()
          .includes(needle)
      )
    : connections
  const groups = new Map<string, ConnectionPublic[]>()
  for (const connection of filtered) {
    const key = connection.group.trim()
    const list = groups.get(key) ?? []
    list.push(connection)
    groups.set(key, list)
  }
  return [...groups.keys()]
    .sort((a, b) => {
      if (!a) return 1
      if (!b) return -1
      return a.localeCompare(b)
    })
    .map((group) => ({
      group,
      items: (groups.get(group) ?? []).sort((a, b) => a.name.localeCompare(b.name))
    }))
}

const FOLD_KEY = 'easy-ssh.foldedGroups'

function initials(name: string): string {
  const parts = name.replace(/[^\p{L}\p{N}]+/gu, ' ').trim().split(' ').filter(Boolean)
  if (parts.length === 0) return '?'
  return (parts.length === 1 ? parts[0].slice(0, 2) : parts[0][0] + parts[1][0]).toUpperCase()
}

export function Sidebar({
  connections,
  phases,
  activeConnectionId,
  encryptionAvailable,
  encryptionReason,
  version,
  backend,
  onConnect,
  onEdit,
  onDelete,
  onSystemTerminal,
  onCreate,
  onImport,
  onExport,
  collapsed,
  onToggleCollapsed
}: SidebarProps) {
  const [query, setQuery] = useState('')
  const groups = groupConnections(connections, query)
  const [folded, setFolded] = useState<Set<string>>(() => {
    try {
      const v = JSON.parse(localStorage.getItem(FOLD_KEY) ?? '[]') as unknown
      return new Set(Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [])
    } catch {
      return new Set()
    }
  })
  const toggleGroup = (name: string): void => {
    setFolded((cur) => {
      const next = new Set(cur)
      if (next.has(name)) next.delete(name)
      else next.add(name)
      localStorage.setItem(FOLD_KEY, JSON.stringify([...next]))
      return next
    })
  }

  if (collapsed) {
    const all = groupConnections(connections, '').flatMap((g) => g.items)
    return (
      <aside className="sidebar rail" aria-label="Servers">
        <div className="rail-logo"><LogoMark /></div>
        <button className="rail-btn rail-new" title="New connection" aria-label="New connection" onClick={onCreate}>
          <IconPlus />
        </button>
        <div className="rail-scroll">
          {all.map((c) => {
            const phase = phases[c.id] ?? 'idle'
            return (
              <button
                key={c.id}
                className={`rail-avatar${c.id === activeConnectionId ? ' active' : ''}`}
                title={`${c.name}\n${c.username}@${c.host}:${c.port}`}
                aria-label={`Connect to ${c.name}`}
                onClick={() => onConnect(c)}
              >
                {initials(c.name)}
                <span className={`dot ${phase}`} />
              </button>
            )
          })}
        </div>
        <button className="rail-btn" title="Expand sidebar (Ctrl+B)" aria-label="Expand sidebar" onClick={onToggleCollapsed}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m9 6 6 6-6 6" /></svg>
        </button>
      </aside>
    )
  }

  return (
    <aside className="sidebar">
      <div className="sidebar-tools">
        <label className="search">
          <IconSearch />
          <input
            id="connection-search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search servers"
            spellCheck={false}
            aria-label="Search connections"
          />
        </label>
        <button className="btn btn-primary sidebar-new" onClick={onCreate}>
          <IconPlus />
          New
        </button>
        <button className="rail-btn sidebar-collapse" title="Collapse sidebar (Ctrl+B)" aria-label="Collapse sidebar" onClick={onToggleCollapsed}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m15 6-6 6 6 6" /></svg>
        </button>
      </div>
      {!encryptionAvailable && (
        <p className="keychain-warning">{encryptionReason ?? 'OS keychain is unavailable, so passwords cannot be saved.'}</p>
      )}
      <div className="connection-scroll">
        {connections.length === 0 && (
          <p className="sidebar-empty">No saved servers yet. Add the host, port, and user you usually type into ssh.</p>
        )}
        {connections.length > 0 && groups.length === 0 && (
          <p className="sidebar-empty">Nothing matches “{query.trim()}”.</p>
        )}
        {groups.map((group) => (
          <section key={group.group || 'ungrouped'} className="group">
            <h2>
              <button
                type="button"
                className={`group-toggle${folded.has(group.group) && !query ? ' folded' : ''}`}
                aria-expanded={!(folded.has(group.group) && !query)}
                onClick={() => toggleGroup(group.group)}
              >
                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><path d="m6 9 6 6 6-6" /></svg>
                {group.group || 'Ungrouped'}
                <span className="group-count">{group.items.length}</span>
              </button>
            </h2>
            {!(folded.has(group.group) && !query) && <ul>
              {group.items.map((connection) => {
                const phase = phases[connection.id]
                const active = connection.id === activeConnectionId
                return (
                  <li key={connection.id} className={active ? 'active' : ''}>
                    <button className="conn" onClick={() => onConnect(connection)}>
                      <span className={`dot ${phase ?? 'idle'}`} />
                      <span className="conn-text">
                        <span className="conn-name">
                          {connection.name}
                          {connection.authType === 'privateKey' && <span className="tag">key</span>}
                        </span>
                        <span className="conn-host">
                          {connection.username}@{connection.host}:{connection.port}
                        </span>
                        {connection.defaultDirectory && <span className="conn-dir">{connection.defaultDirectory}</span>}
                      </span>
                    </button>
                    <div className="conn-actions">
                      <button title="Open in system terminal" aria-label={`Open ${connection.name} in system terminal`} onClick={() => onSystemTerminal(connection)}>
                        <IconExternal />
                      </button>
                      <button title="Edit" aria-label={`Edit ${connection.name}`} onClick={() => onEdit(connection)}>
                        <IconEdit />
                      </button>
                      <button title="Delete" aria-label={`Delete ${connection.name}`} onClick={() => onDelete(connection)}>
                        <IconTrash />
                      </button>
                    </div>
                  </li>
                )
              })}
            </ul>}
          </section>
        ))}
      </div>
      <footer className="sidebar-foot">
        <span className="foot-actions">
          <button className="text-button" onClick={onImport}>
            Import
          </button>
          <button className="text-button" onClick={onExport} disabled={connections.length === 0}>
            Export
          </button>
        </span>
        <span>
          v{version} · {encryptionAvailable ? backend : 'keychain unavailable'}
        </span>
      </footer>
    </aside>
  )
}
