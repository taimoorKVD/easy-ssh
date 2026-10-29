import { Suspense, lazy, useCallback, useEffect, useRef, useState } from 'react'
import type { AppMeta, ConnectionInput, ConnectionPublic, HostKeyPrompt, SessionErrorCode, SessionPhase, SessionStatus } from '@shared/types'
import { ConnectionForm } from './components/ConnectionForm'
import { IconClose, LogoMark } from './components/Icons'
import { ConfirmDialog, HostKeyDialog, ProblemSheet, Toast } from './components/Overlays'
import { Sidebar } from './components/Sidebar'
import { TerminalView } from './components/TerminalView'
import { shSingleQuote } from '@shared/shell'
import { errorMessage } from './lib/errors'
import { backoffDelay, parseRestoreState, serializeRestoreState, shouldAutoReconnect } from '@shared/reconnect'

const ThemeGallery = lazy(() => import('./components/ThemeGallery'))
const StatsBar = lazy(() => import('./components/StatsBar'))
const STATS_KEY = 'easy-ssh.statsEnabled'
const RESTORE_KEY = 'easy-ssh.restoreTabs.v1'
const RESTORE_ENABLED_KEY = 'easy-ssh.restoreEnabled'

const loadFileManager = () => import('./components/FileManager').then((m) => ({ default: m.FileManager }))
const FileManager = lazy(loadFileManager)
const CommandPalette = lazy(() => import('./components/CommandPalette'))
const ForwardsPanel = lazy(() => import('./components/ForwardsPanel'))
const KeyManager = lazy(() => import('./components/KeyManager'))
// Warm the File Manager chunk once the app is idle so the first switch is instant.
setTimeout(() => void loadFileManager(), 1500)

interface Tab {
  id: string
  sessionId: string
  connectionId: string
  title: string
  phase: SessionPhase
  message?: string
  code?: SessionErrorCode
  mode: 'terminal' | 'files'
  filesOpened: boolean
  retryAt?: number
  /** Extra terminals split inside this tab (same host, separate sessions). */
  panes?: string[]
  splitDir?: 'row' | 'column'
  broadcast?: boolean
}

const MAX_TABS = 16

function phaseRank(phase: SessionPhase | undefined): number {
  if (phase === 'connected') return 4
  if (phase === 'connecting') return 3
  if (phase === 'error') return 2
  if (phase === 'disconnected') return 1
  return 0
}

function bestPhase(tabs: Tab[], connectionId: string): SessionPhase | undefined {
  let best: SessionPhase | undefined
  for (const tab of tabs) {
    if (tab.connectionId !== connectionId) continue
    if (phaseRank(tab.phase) > phaseRank(best)) best = tab.phase
  }
  return best
}

function problemTitle(tab: Tab): string {
  if (tab.phase === 'disconnected') return 'Disconnected'
  if (tab.code === 'auth') return 'Authentication failed'
  if (tab.code === 'hostkey') return 'Host key rejected'
  if (tab.code === 'timeout') return 'Timed out'
  if (tab.code === 'network') return 'Could not connect'
  if (tab.code === 'key') return 'Private key problem'
  return 'Connection failed'
}

export default function App() {
  const [meta, setMeta] = useState<AppMeta | null>(null)
  const [connections, setConnections] = useState<ConnectionPublic[]>([])
  const connectionsRef = useRef(connections)
  connectionsRef.current = connections
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [tabs, setTabs] = useState<Tab[]>([])
  const [activeTabId, setActiveTabId] = useState<string | null>(null)
  const [form, setForm] = useState<{ connection?: ConnectionPublic } | null>(null)
  const [formSaving, setFormSaving] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<ConnectionPublic | null>(null)
  const [deleting, setDeleting] = useState(false)
  const [hostKey, setHostKey] = useState<HostKeyPrompt | null>(null)
  const [toast, setToast] = useState<string | null>(null)
  const [paletteOpen, setPaletteOpen] = useState(false)

  const writers = useRef(new Map<string, (data: string) => void>())
  const buffers = useRef(new Map<string, string>())
  const pendingStatus = useRef(new Map<string, SessionStatus>())
  const ignored = useRef(new Set<string>())
  const tabsRef = useRef(tabs)
  const activeRef = useRef(activeTabId)
  const hostKeyRef = useRef(hostKey)
  const formRef = useRef(form)
  const deleteRef = useRef(deleteTarget)
  tabsRef.current = tabs
  activeRef.current = activeTabId
  hostKeyRef.current = hostKey
  formRef.current = form
  deleteRef.current = deleteTarget

  const notify = useCallback((message: string) => {
    setToast(message)
  }, [])

  const refresh = useCallback(async () => {
    const list = await window.easySsh.listConnections()
    setConnections(list)
    return list
  }, [])

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const [nextMeta, list] = await Promise.all([window.easySsh.getMeta(), window.easySsh.listConnections()])
        if (cancelled) return
        setMeta(nextMeta)
        setConnections(list)
      } catch (error) {
        if (!cancelled) setLoadError(errorMessage(error))
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    if (!toast) return
    const timer = setTimeout(() => setToast(null), 4200)
    return () => clearTimeout(timer)
  }, [toast])

  const registerWriter = useCallback((sessionId: string, write: ((data: string) => void) | null) => {
    if (!write) {
      writers.current.delete(sessionId)
      return
    }
    writers.current.set(sessionId, write)
    const pending = buffers.current.get(sessionId)
    if (pending) {
      buffers.current.delete(sessionId)
      write(pending)
    }
  }, [])

  const applySession = useCallback((sessionId: string, connection: ConnectionPublic, tabId: string) => {
    setTabs((current) => {
      const pending = pendingStatus.current.get(sessionId)
      pendingStatus.current.delete(sessionId)
      const nextTab: Tab = {
        id: tabId,
        sessionId,
        connectionId: connection.id,
        title: connection.name,
        phase: pending?.phase ?? 'connecting',
        message: pending?.message,
        code: pending?.code,
        mode: 'terminal',
        filesOpened: false
      }
      const exists = current.some((tab) => tab.id === tabId)
      if (!exists) return [...current, nextTab]
      return current.map((tab) =>
        tab.id === tabId ? { ...tab, ...nextTab, title: connection.name, mode: tab.mode, filesOpened: tab.filesOpened } : tab
      )
    })
    setActiveTabId(tabId)
  }, [])

  const reconnect = useCallback(
    async (tab: Tab) => {
      const connection = connections.find((item) => item.id === tab.connectionId)
      if (!connection) {
        notify('That connection was deleted.')
        return
      }
      ignored.current.add(tab.sessionId)
      writers.current.delete(tab.sessionId)
      try {
        await window.easySsh.disconnect(tab.sessionId)
      } catch {
        // The session may already be gone.
      }
      try {
        const sessionId = await window.easySsh.connect(connection.id)
        applySession(sessionId, connection, tab.id)
      } catch (error) {
        notify(errorMessage(error))
      }
    },
    [applySession, connections, notify]
  )

  const openSession = useCallback(
    async (connection: ConnectionPublic, forceNew = false) => {
      const existing = tabsRef.current.find((tab) => tab.connectionId === connection.id)
      if (existing && !forceNew) {
        setActiveTabId(existing.id)
        if (existing.phase === 'disconnected' || existing.phase === 'error') await reconnect(existing)
        return
      }
      if (tabsRef.current.length >= MAX_TABS) {
        notify('Close a tab before opening another session.')
        return
      }
      try {
        const sessionId = await window.easySsh.connect(connection.id)
        applySession(sessionId, connection, crypto.randomUUID())
      } catch (error) {
        notify(errorMessage(error))
      }
    },
    [applySession, notify, reconnect]
  )

  const closeTab = useCallback((tabId: string) => {
    const currentTabs = tabsRef.current
    const tab = currentTabs.find((item) => item.id === tabId)
    if (!tab) return
    ignored.current.add(tab.sessionId)
    if (hostKeyRef.current?.sessionId === tab.sessionId) {
      window.easySsh.respondHostKey(tab.sessionId, false, false)
      setHostKey(null)
    }
    void window.easySsh.disconnect(tab.sessionId)
    for (const pane of tab.panes ?? []) {
      ignored.current.add(pane)
      void window.easySsh.disconnect(pane)
    }
    const remaining = currentTabs.filter((item) => item.id !== tabId)
    setTabs(remaining)
    if (activeRef.current === tabId) {
      const index = currentTabs.findIndex((item) => item.id === tabId)
      setActiveTabId(remaining[Math.max(0, index - 1)]?.id ?? null)
    }
  }, [])

  useEffect(() => {
    const offStatus = window.easySsh.onSshStatus((status) => {
      if (ignored.current.has(status.sessionId)) return
      if (status.phase === 'connected') {
        const tab = tabsRef.current.find((t) => t.sessionId === status.sessionId)
        const conn = tab && connectionsRef.current.find((c) => c.id === tab.connectionId)
        for (const rule of conn?.forwards ?? []) {
          if (rule.autoStart) void window.easySsh.startForward(status.sessionId, rule.id).catch((err) => notify(`Tunnel ${rule.bindPort}: ${errorMessage(err)}`))
        }
      }
      setTabs((current) => {
        let found = false
        const next = current.map((tab) => {
          if (tab.sessionId !== status.sessionId) return tab
          found = true
          return { ...tab, phase: status.phase, message: status.message, code: status.code }
        })
        if (!found) pendingStatus.current.set(status.sessionId, status)
        return next
      })
    })
    const offData = window.easySsh.onSshData(({ sessionId, data }) => {
      if (ignored.current.has(sessionId)) return
      const writer = writers.current.get(sessionId)
      if (writer) writer(data)
      else buffers.current.set(sessionId, (buffers.current.get(sessionId) ?? '') + data)
    })
    const offHost = window.easySsh.onHostKey((prompt) => setHostKey(prompt))
    const offMenu = window.easySsh.onMenu((action) => {
      if (action === 'new') {
        setFormError(null)
        setForm({})
      }
      if (action === 'import') void importConnections()
      if (action === 'export') void exportConnections()
    })
    return () => {
      offStatus()
      offData()
      offHost()
      offMenu()
    }
    // Menu handlers are stable enough for the lifetime of the window; they call the latest refresh via closure on first mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      const meta = event.metaKey || event.ctrlKey
      const target = event.target instanceof HTMLElement ? event.target : null
      const typing = Boolean(target?.closest('input, textarea, [contenteditable="true"]'))
      const inTerminal = Boolean(target?.closest('.xterm'))
      if (meta && (event.key.toLowerCase() === 'k' || (event.shiftKey && event.key.toLowerCase() === 'p'))) {
        event.preventDefault()
        event.stopPropagation()
        setPaletteOpen((open) => !open)
      }
      if (meta && event.key.toLowerCase() === 'n' && !typing) {
        event.preventDefault()
        setFormError(null)
        setForm({})
      }
      if (meta && event.key.toLowerCase() === 'w' && !typing && !inTerminal && activeRef.current) {
        event.preventDefault()
        closeTab(activeRef.current)
      }
      if (event.key === 'Escape') {
        if (hostKeyRef.current) {
          window.easySsh.respondHostKey(hostKeyRef.current.sessionId, false, false)
          setHostKey(null)
        } else if (deleteRef.current) setDeleteTarget(null)
        else if (formRef.current) setForm(null)
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [closeTab])

  async function saveConnection(input: ConnectionInput): Promise<void> {
    setFormSaving(true)
    setFormError(null)
    try {
      const saved = await window.easySsh.saveConnection(input)
      setConnections((current) => {
        const exists = current.some((item) => item.id === saved.id)
        return exists ? current.map((item) => (item.id === saved.id ? saved : item)) : [...current, saved]
      })
      setTabs((current) => current.map((tab) => (tab.connectionId === saved.id ? { ...tab, title: saved.name } : tab)))
      setForm(null)
      notify(input.id ? 'Connection updated' : 'Connection saved')
    } catch (error) {
      setFormError(errorMessage(error))
    } finally {
      setFormSaving(false)
    }
  }

  async function confirmDelete(): Promise<void> {
    if (!deleteTarget) return
    const id = deleteTarget.id
    setDeleting(true)
    try {
      await window.easySsh.deleteConnection(id)
      for (const tab of tabsRef.current.filter((item) => item.connectionId === id)) {
        ignored.current.add(tab.sessionId)
        void window.easySsh.disconnect(tab.sessionId)
      }
      const remaining = tabsRef.current.filter((tab) => tab.connectionId !== id)
      setTabs(remaining)
      if (remaining.every((tab) => tab.id !== activeRef.current)) setActiveTabId(remaining[0]?.id ?? null)
      setDeleteTarget(null)
      await refresh()
      notify('Connection deleted. Its password was removed from the keychain.')
    } catch (error) {
      notify(errorMessage(error))
    } finally {
      setDeleting(false)
    }
  }

  async function toggleFavorite(connection: ConnectionPublic): Promise<void> {
    try {
      await window.easySsh.setMeta(connection.id, { favorite: !connection.favorite })
      await refresh()
    } catch (error) {
      notify(errorMessage(error))
    }
  }

  async function importConnections(fromSshConfig = false): Promise<void> {
    try {
      const result = fromSshConfig ? await window.easySsh.importSshConfig() : await window.easySsh.importConnections()
      if (result.canceled) return
      await refresh()
      notify(
        result.imported === 0
          ? 'No new connections imported.'
          : `Imported ${result.imported}${result.skipped ? `, skipped ${result.skipped}` : ''}. Passwords are not in the file — add them before connecting.`
      )
    } catch (error) {
      notify(errorMessage(error))
    }
  }

  async function exportConnections(): Promise<void> {
    try {
      const result = await window.easySsh.exportConnections()
      if (result.canceled) return
      notify(`Exported ${result.count} connection${result.count === 1 ? '' : 's'} without passwords or passphrases.`)
    } catch (error) {
      notify(errorMessage(error))
    }
  }

  async function openSystemTerminal(connection: ConnectionPublic): Promise<void> {
    try {
      const result = await window.easySsh.openSystemTerminal(connection.id)
      if (!result.ok) notify(result.error ?? 'Could not open a system terminal.')
      else notify('Opened in a system terminal. It asks for the password itself.')
    } catch (error) {
      notify(errorMessage(error))
    }
  }

  async function submitSecret(tab: Tab, secret: { password?: string; passphrase?: string }): Promise<void> {
    await window.easySsh.setSecret(tab.connectionId, secret)
    await refresh()
    await reconnect({ ...tab, sessionId: tabsRef.current.find((item) => item.id === tab.id)?.sessionId ?? tab.sessionId })
  }

  const setMode = useCallback((tabId: string, mode: Tab['mode']) => {
    setTabs((current) =>
      current.map((tab) => (tab.id === tabId ? { ...tab, mode, filesOpened: tab.filesOpened || mode === 'files' } : tab))
    )
  }, [])

  const openTerminalHere = useCallback(
    (tabId: string, path: string) => {
      const tab = tabsRef.current.find((item) => item.id === tabId)
      if (!tab) return
      setMode(tabId, 'terminal')
      window.easySsh.write(tab.sessionId, `cd ${shSingleQuote(path)}\r`)
    },
    [setMode]
  )

  // ---- Auto-reconnect with backoff (network drops only, on sessions that were live) ----
  const liveTabs = useRef(new Set<string>())
  const attempts = useRef(new Map<string, number>())
  const retryTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>())
  const reconnectRef = useRef(reconnect)
  reconnectRef.current = reconnect
  useEffect(() => {
    for (const tab of tabs) {
      if (tab.phase === 'connected') {
        liveTabs.current.add(tab.id)
        attempts.current.delete(tab.id)
        continue
      }
      if (retryTimers.current.has(tab.id)) continue
      const tries = attempts.current.get(tab.id) ?? 0
      if (!shouldAutoReconnect(tab, liveTabs.current.has(tab.id), tries)) continue
      const delay = backoffDelay(tries)
      attempts.current.set(tab.id, tries + 1)
      setTabs((current) => current.map((t) => (t.id === tab.id ? { ...t, retryAt: Date.now() + delay } : t)))
      retryTimers.current.set(
        tab.id,
        setTimeout(() => {
          retryTimers.current.delete(tab.id)
          const latest = tabsRef.current.find((t) => t.id === tab.id)
          if (latest && latest.phase !== 'connected') void reconnectRef.current(latest)
        }, delay)
      )
    }
    for (const [id, timer] of retryTimers.current) {
      if (!tabs.some((t) => t.id === id)) {
        clearTimeout(timer)
        retryTimers.current.delete(id)
      }
    }
  }, [tabs])

  // ---- Restore last session tabs (only connection ids + modes are stored) ----
  const [restoreEnabled, setRestoreEnabled] = useState(() => localStorage.getItem(RESTORE_ENABLED_KEY) !== '0')
  const restored = useRef(false)
  useEffect(() => {
    if (restored.current || loading || connections.length === 0) return
    restored.current = true
    if (!restoreEnabled) return
    const saved = parseRestoreState(localStorage.getItem(RESTORE_KEY), new Set(connections.map((c) => c.id)))
    void (async () => {
      for (const item of saved) {
        const connection = connections.find((c) => c.id === item.connectionId)
        if (!connection) continue
        await openSession(connection, true)
        if (item.mode === 'files') {
          const tab = tabsRef.current.find((t) => t.connectionId === connection.id)
          if (tab) setMode(tab.id, 'files')
        }
      }
    })()
  }, [loading, connections, restoreEnabled, openSession, setMode])
  useEffect(() => {
    if (!restored.current) return
    if (restoreEnabled) localStorage.setItem(RESTORE_KEY, serializeRestoreState(tabs))
    else localStorage.removeItem(RESTORE_KEY)
  }, [tabs, restoreEnabled])
  const [themeOpen, setThemeOpen] = useState(false)
  const [forwardsOpen, setForwardsOpen] = useState(false)
  const [keysOpen, setKeysOpen] = useState(false)
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => localStorage.getItem('easy-ssh.sidebarCollapsed') === '1')
  const toggleSidebar = useCallback((): void => {
    setSidebarCollapsed((v) => {
      localStorage.setItem('easy-ssh.sidebarCollapsed', v ? '0' : '1')
      return !v
    })
  }, [])
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'b') {
        // Ctrl+B is the tmux prefix: leave it to the terminal when it has focus.
        if ((e.target as HTMLElement | null)?.closest?.('.xterm')) return
        e.preventDefault()
        e.stopPropagation()
        toggleSidebar()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [toggleSidebar])
  const [statsEnabled, setStatsEnabled] = useState(() => localStorage.getItem(STATS_KEY) !== '0')
  const toggleStats = (): void => {
    setStatsEnabled((on) => {
      localStorage.setItem(STATS_KEY, on ? '0' : '1')
      return !on
    })
  }
  const toggleRestore = (): void => {
    setRestoreEnabled((on) => {
      localStorage.setItem(RESTORE_ENABLED_KEY, on ? '0' : '1')
      notify(on ? 'Tabs will not be restored on launch.' : 'Open tabs will be restored on launch.')
      return !on
    })
  }

  // ---- Split panes + broadcast input ----
  const splitTab = useCallback(async (tabId: string, dir: 'row' | 'column') => {
    const tab = tabsRef.current.find((t) => t.id === tabId)
    if (!tab) return
    if ((tab.panes?.length ?? 0) >= 3) {
      notify('A tab holds up to 4 terminals.')
      return
    }
    try {
      const sessionId = await window.easySsh.connect(tab.connectionId)
      setTabs((cur) => cur.map((t) => (t.id === tabId ? { ...t, mode: 'terminal', splitDir: dir, panes: [...(t.panes ?? []), sessionId] } : t)))
    } catch (err) {
      notify(errorMessage(err))
    }
  }, [notify])
  const closePane = useCallback((tabId: string, sessionId: string) => {
    ignored.current.add(sessionId)
    void window.easySsh.disconnect(sessionId)
    setTabs((cur) => cur.map((t) => {
      if (t.id !== tabId) return t
      const panes = (t.panes ?? []).filter((p) => p !== sessionId)
      return { ...t, panes, broadcast: panes.length ? t.broadcast : false }
    }))
  }, [])
  const toggleBroadcast = useCallback((tabId: string) => {
    setTabs((cur) => cur.map((t) => (t.id === tabId ? { ...t, broadcast: !t.broadcast } : t)))
  }, [])
  const broadcastTo = (tab: Tab) => (data: string): void => {
    for (const id of [tab.sessionId, ...(tab.panes ?? [])]) window.easySsh.write(id, data)
  }

  const activeTab = tabs.find((tab) => tab.id === activeTabId) ?? null
  const activeConnection = connections.find((connection) => connection.id === activeTab?.connectionId)
  const phases: Record<string, SessionPhase | undefined> = {}
  for (const connection of connections) phases[connection.id] = bestPhase(tabs, connection.id)
  const groups = [...new Set(connections.map((connection) => connection.group.trim()).filter(Boolean))]
  const copyHint = meta?.platform === 'darwin' ? '⌘C copy selection · ⌘V paste' : 'Ctrl+Shift+C copy · Ctrl+Shift+V paste'

  if (loading) {
    return (
      <main className="boot">
        <LogoMark />
        <p>Loading connections…</p>
      </main>
    )
  }

  if (loadError) {
    return (
      <main className="boot">
        <LogoMark />
        <h1>easy-ssh could not start</h1>
        <p>{loadError}</p>
        <button className="btn btn-primary" onClick={() => window.location.reload()}>
          Retry
        </button>
      </main>
    )
  }

  return (
    <div className={`app${meta?.platform === 'darwin' ? ' darwin' : ''}`}>
      <header className="titlebar" onDoubleClick={() => void window.easySsh.windowMaximize()}>
        <div className="brand">
          <LogoMark />
          <div>
            <strong>easy-ssh</strong>
            <span>Saved servers</span>
          </div>
        </div>
        <div className="title-spacer" />
        <button type="button" className="title-action" title="Appearance" aria-label="Appearance" onClick={() => setThemeOpen(true)} onDoubleClick={(e) => e.stopPropagation()}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"><path d="M12 3a9 9 0 1 0 0 18c1.1 0 1.6-.8 1.6-1.6 0-.5-.2-.8-.5-1.2-.3-.3-.5-.7-.5-1.2 0-.9.7-1.6 1.6-1.6H16a5 5 0 0 0 5-5C21 6.4 17 3 12 3Z" /><circle cx="7.5" cy="11" r="1" fill="currentColor" /><circle cx="10.5" cy="7" r="1" fill="currentColor" /><circle cx="15" cy="7.5" r="1" fill="currentColor" /></svg>
        </button>
        {meta?.platform !== 'darwin' && (
          <div className="window-controls" onDoubleClick={(event) => event.stopPropagation()}>
            <button type="button" aria-label="Minimize" onClick={() => void window.easySsh.windowMinimize()}>
              –
            </button>
            <button type="button" aria-label="Maximize" onClick={() => void window.easySsh.windowMaximize()}>
              □
            </button>
            <button type="button" className="close" aria-label="Close" onClick={() => void window.easySsh.windowClose()}>
              ×
            </button>
          </div>
        )}
      </header>
      <div className={`body${sidebarCollapsed ? ' rail-mode' : ''}`}>
        <Sidebar
          collapsed={sidebarCollapsed}
          onToggleCollapsed={toggleSidebar}
          connections={connections}
          phases={phases}
          activeConnectionId={activeTab?.connectionId}
          encryptionAvailable={meta?.encryptionAvailable ?? false}
          encryptionReason={meta?.encryptionReason}
          version={meta?.version ?? '1.0.0'}
          backend={meta?.encryptionBackend ?? 'keychain'}
          onConnect={(connection) => void openSession(connection)}
          onEdit={(connection) => {
            setFormError(null)
            setForm({ connection })
          }}
          onDelete={setDeleteTarget}
          onSystemTerminal={(connection) => void openSystemTerminal(connection)}
          onCreate={() => {
            setFormError(null)
            setForm({})
          }}
          onImport={() => void importConnections()}
          onImportSshConfig={() => void importConnections(true)}
          onToggleFavorite={(connection) => void toggleFavorite(connection)}
          onExport={() => void exportConnections()}
        />
        <section className="workspace">
          {tabs.length > 0 && (
            <div className="tabstrip" role="tablist" aria-label="Sessions">
              {tabs.map((tab) => (
                <div key={tab.id} className={`tab${tab.id === activeTabId ? ' active' : ''}`} role="tab" aria-selected={tab.id === activeTabId}>
                  <button type="button" className="tab-main" onClick={() => setActiveTabId(tab.id)} title={tab.title}>
                    <span className={`dot ${tab.phase}`} />
                    <span>{tab.title}</span>
                  </button>
                  <button type="button" className="tab-close" aria-label={`Close ${tab.title}`} onClick={() => closeTab(tab.id)}>
                    <IconClose />
                  </button>
                </div>
              ))}
              {activeConnection && (
                <button type="button" className="text-button tab-extra" onClick={() => void openSession(activeConnection, true)}>
                  New session
                </button>
              )}
            </div>
          )}
          {activeTab && (
            <div className="session-bar">
              <div className="session-title">
                <span className={`dot ${activeTab.phase}`} />
                <strong>{activeTab.title}</strong>
                {activeConnection && <span>{`${activeConnection.username}@${activeConnection.host}`}</span>}
              </div>
              <div className="split-tools">
                <button type="button" title="Port forwarding" aria-label="Port forwarding" className={activeConnection?.forwards.length ? 'has' : ''} onClick={() => setForwardsOpen(true)}>
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M4 8h13l-3-3M20 16H7l3 3" /></svg>
                </button>
                <button type="button" title="Split right" aria-label="Split right" onClick={() => void splitTab(activeTab.id, 'row')}>
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><rect x="3.5" y="4.5" width="17" height="15" rx="2" /><path d="M12 4.5v15" /></svg>
                </button>
                <button type="button" title="Split down" aria-label="Split down" onClick={() => void splitTab(activeTab.id, 'column')}>
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><rect x="3.5" y="4.5" width="17" height="15" rx="2" /><path d="M3.5 12h17" /></svg>
                </button>
                {(activeTab.panes?.length ?? 0) > 0 && (
                  <button type="button" className={activeTab.broadcast ? 'on' : ''} title="Type in all panes at once" aria-pressed={!!activeTab.broadcast} onClick={() => toggleBroadcast(activeTab.id)}>
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"><path d="M5 12a7 7 0 0 1 14 0M8.5 12a3.5 3.5 0 0 1 7 0" /><circle cx="12" cy="12" r="1.2" fill="currentColor" /><path d="M12 13v7" /></svg>
                  </button>
                )}
              </div>
              <div className="mode-toggle" role="tablist" aria-label="Session mode">
                <span className={`mode-thumb${activeTab.mode === 'files' ? ' right' : ''}`} aria-hidden="true" />
                <button
                  type="button"
                  role="tab"
                  aria-selected={activeTab.mode === 'terminal'}
                  onClick={() => setMode(activeTab.id, 'terminal')}
                >
                  <svg viewBox="0 0 24 24" aria-hidden="true">
                    <path d="M5 8l4 4-4 4M11 16h8" />
                  </svg>
                  Terminal
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={activeTab.mode === 'files'}
                  onClick={() => setMode(activeTab.id, 'files')}
                >
                  <svg viewBox="0 0 24 24" aria-hidden="true">
                    <path d="M3.5 7.5a2 2 0 0 1 2-2h4l2 2h7a2 2 0 0 1 2 2v7.5a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z" />
                  </svg>
                  File Manager
                </button>
              </div>
            </div>
          )}
          <div className="terminal-stage">
            {tabs.length === 0 && (
              <div className="welcome">
                <LogoMark />
                <h1>{connections.length === 0 ? 'Your servers, one click away' : 'Pick a server'}</h1>
                <p>
                  {connections.length === 0
                    ? 'Save the host, port, and user you usually type into ssh. Connect opens a terminal, cds into the directory you set, and runs any startup commands.'
                    : 'Open one from the sidebar. You can keep several shells in tabs, or open the same server again with New session.'}
                </p>
                {connections.length === 0 && (
                  <div className="welcome-actions">
                    <button className="btn btn-primary" onClick={() => setForm({})}>
                      Add a connection
                    </button>
                    <button className="btn btn-ghost" onClick={() => void importConnections()}>
                      Import
                    </button>
                  </div>
                )}
              </div>
            )}
            {tabs.map((tab) => {
              const shown = tab.id === activeTabId && tab.mode === 'terminal'
              const panes = tab.panes ?? []
              const input = tab.broadcast && panes.length ? broadcastTo(tab) : undefined
              return (
                <div key={tab.id} className={`tab-stage ${tab.splitDir ?? 'row'}${shown ? ' active' : ''}${input ? ' broadcasting' : ''}`}>
                  <TerminalView sessionId={tab.sessionId} active={shown} register={registerWriter} onInput={input} />
                  {panes.map((pane) => (
                    <div key={pane} className="split-pane">
                      <TerminalView sessionId={pane} active={shown} register={registerWriter} onInput={input} />
                      <button type="button" className="pane-close" title="Close pane" aria-label="Close pane" onClick={() => closePane(tab.id, pane)}>×</button>
                    </div>
                  ))}
                </div>
              )
            })}
            {activeTab?.broadcast && (activeTab.panes?.length ?? 0) > 0 && activeTab.mode === 'terminal' && (
              <div className="broadcast-badge" role="status">
                Broadcasting keystrokes to {(activeTab.panes?.length ?? 0) + 1} terminals
                <button type="button" onClick={() => toggleBroadcast(activeTab.id)}>Stop</button>
              </div>
            )}
            <Suspense fallback={null}>
            {tabs
              .filter((tab) => tab.filesOpened)
              .map((tab) => (
                <FileManager
                  key={`fm-${tab.id}`}
                  sessionId={tab.sessionId}
                  connectionId={tab.connectionId}
                  active={tab.id === activeTabId && tab.mode === 'files'}
                  connected={tab.phase === 'connected'}
                  notify={notify}
                  onOpenTerminalHere={(path) => openTerminalHere(tab.id, path)}
                />
              ))}
            </Suspense>
            {activeTab?.phase === 'connecting' && (
              <div className="connecting-banner">Connecting to {activeConnection ? `${activeConnection.username}@${activeConnection.host}` : activeTab.title}…</div>
            )}
            {activeTab?.phase === 'error' && activeTab.retryAt && (activeTab.code === 'network' || activeTab.code === 'timeout') && (
              <div className="connecting-banner">Connection lost. Reconnecting automatically with backoff…</div>
            )}
            {activeTab && (activeTab.phase === 'error' || activeTab.phase === 'disconnected') && (
              <ProblemSheet
                key={`${activeTab.id}:${activeTab.phase}:${activeTab.code ?? ''}:${activeTab.message ?? ''}`}
                title={problemTitle(activeTab)}
                message={activeTab.message}
                code={activeTab.code}
                connection={activeConnection}
                onReconnect={() => void reconnect(activeTab)}
                onSubmitSecret={(secret) => submitSecret(activeTab, secret)}
              />
            )}
          </div>
          <footer className="statusbar">
            <span className="status-main">
              <span className={`dot ${activeTab?.phase ?? 'idle'}`} />
              {activeConnection
                ? `${activeConnection.username}@${activeConnection.host}:${activeConnection.port}`
                : 'No session'}
              {activeTab?.message && activeTab.phase !== 'connecting' ? ` · ${activeTab.message}` : ''}
              {statsEnabled && activeTab?.phase === 'connected' && (
                <Suspense fallback={null}>
                  <StatsBar sessionId={activeTab.sessionId} />
                </Suspense>
              )}
            </span>
            <span className="status-actions">
              {activeTab && activeTab.phase !== 'connecting' && (
                <button type="button" className="text-button" onClick={() => void reconnect(activeTab)}>
                  Reconnect
                </button>
              )}
              {activeTab && activeTab.phase === 'connected' && (
                <button type="button" className="text-button" onClick={() => void window.easySsh.disconnect(activeTab.sessionId)}>
                  Disconnect
                </button>
              )}
              {activeConnection && (
                <button type="button" className="text-button" onClick={() => void openSystemTerminal(activeConnection)}>
                  System terminal
                </button>
              )}
              <span className="hint">{copyHint}</span>
            </span>
          </footer>
        </section>
      </div>
      {form && (
        <ConnectionForm
          initial={form.connection}
          groups={groups}
          connections={connections}
          saving={formSaving}
          error={formError}
          onClose={() => setForm(null)}
          onSubmit={(input) => void saveConnection(input)}
        />
      )}
      {deleteTarget && (
        <ConfirmDialog
          title={`Delete ${deleteTarget.name}?`}
          body="The saved password or key passphrase is removed from the OS keychain. The server itself is left alone."
          confirmLabel="Delete"
          busy={deleting}
          onCancel={() => setDeleteTarget(null)}
          onConfirm={() => void confirmDelete()}
        />
      )}
      {hostKey && (
        <HostKeyDialog
          prompt={hostKey}
          onReject={() => {
            window.easySsh.respondHostKey(hostKey.sessionId, false, false)
            setHostKey(null)
          }}
          onAcceptOnce={() => {
            window.easySsh.respondHostKey(hostKey.sessionId, true, false)
            setHostKey(null)
          }}
          onTrust={() => {
            window.easySsh.respondHostKey(hostKey.sessionId, true, true)
            setHostKey(null)
          }}
        />
      )}
      <Toast message={toast} />
      {paletteOpen && (
        <Suspense fallback={null}>
          <CommandPalette
            connections={connections}
            activeConnectionId={activeTab?.connectionId}
            activeSessionId={activeTab?.phase === 'connected' ? activeTab.sessionId : undefined}
            notify={notify}
            onClose={() => setPaletteOpen(false)}
            onConnect={(connection) => void openSession(connection)}
            onRunInTerminal={(sessionId, input) => {
              if (activeTab) setMode(activeTab.id, 'terminal')
              window.easySsh.write(sessionId, input)
            }}
            actions={[
              ...(activeTab
                ? [
                    { id: 'mode-terminal', label: 'Switch to Terminal', hint: activeTab.title, run: () => setMode(activeTab.id, 'terminal') },
                    { id: 'mode-files', label: 'Switch to File Manager', hint: activeTab.title, run: () => setMode(activeTab.id, 'files') },
                    { id: 'reconnect', label: 'Reconnect', hint: activeTab.title, run: () => void reconnect(activeTab) },
                    { id: 'close-tab', label: 'Close tab', hint: activeTab.title, run: () => closeTab(activeTab.id) }
                  ]
                : []),
              ...tabs.filter((t) => t.id !== activeTab?.id).map((t) => ({ id: `tab-${t.id}`, label: `Go to tab: ${t.title}`, run: () => setActiveTabId(t.id) })),
              ...(activeTab
                ? [
                    { id: 'forwards', label: 'Port forwarding…', run: () => setForwardsOpen(true) },
                    { id: 'split-right', label: 'Split terminal right', run: () => void splitTab(activeTab.id, 'row') },
                    { id: 'split-down', label: 'Split terminal down', run: () => void splitTab(activeTab.id, 'column') },
                    ...((activeTab.panes?.length ?? 0) > 0
                      ? [{ id: 'broadcast', label: activeTab.broadcast ? 'Stop broadcasting input' : 'Broadcast input to all panes', run: () => toggleBroadcast(activeTab.id) }]
                      : [])
                  ]
                : []),
              { id: 'keys', label: 'SSH keys…', run: () => setKeysOpen(true) },
              { id: 'import-ssh-config', label: 'Import from ~/.ssh/config', run: () => void importConnections(true) },
              { id: 'sidebar', label: sidebarCollapsed ? 'Expand server sidebar' : 'Collapse server sidebar', hint: 'Ctrl+B', run: toggleSidebar },
              { id: 'theme', label: 'Change theme…', hint: 'Appearance', run: () => setThemeOpen(true) },
              { id: 'toggle-stats', label: statsEnabled ? 'Hide server stats' : 'Show server stats (CPU, RAM, disk, uptime)', run: toggleStats },
              { id: 'toggle-restore', label: restoreEnabled ? 'Turn off restoring tabs on launch' : 'Turn on restoring tabs on launch', run: toggleRestore },
              { id: 'new-conn', label: 'New connection…', run: () => { setFormError(null); setForm({}) } }
            ]}
          />
        </Suspense>
      )}
      {keysOpen && (
        <Suspense fallback={null}>
          <KeyManager
            sessionId={activeTab?.phase === 'connected' ? activeTab.sessionId : null}
            serverLabel={activeConnection ? `${activeConnection.username}@${activeConnection.host}` : null}
            notify={notify}
            onClose={() => setKeysOpen(false)}
          />
        </Suspense>
      )}
      {forwardsOpen && activeTab && activeConnection && (
        <Suspense fallback={null}>
          <ForwardsPanel
            connection={activeConnection}
            sessionId={activeTab.sessionId}
            connected={activeTab.phase === 'connected'}
            onSaved={(saved) => setConnections((cur) => cur.map((c) => (c.id === saved.id ? saved : c)))}
            onClose={() => setForwardsOpen(false)}
          />
        </Suspense>
      )}
      {themeOpen && (
        <Suspense fallback={null}>
          <ThemeGallery onClose={() => setThemeOpen(false)} />
        </Suspense>
      )}
    </div>
  )
}
