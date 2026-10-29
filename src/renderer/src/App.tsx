import { Suspense, lazy, useCallback, useEffect, useRef, useState } from 'react'
import type { AppMeta, ConnectionInput, ConnectionPublic, HostKeyPrompt, SessionErrorCode, SessionPhase, SessionStatus } from '@shared/types'
import { ConnectionForm } from './components/ConnectionForm'
import { IconClose, LogoMark } from './components/Icons'
import { ConfirmDialog, HostKeyDialog, ProblemSheet, Toast } from './components/Overlays'
import { Sidebar } from './components/Sidebar'
import { TerminalView } from './components/TerminalView'
import { shSingleQuote } from '@shared/shell'
import { errorMessage } from './lib/errors'

const loadFileManager = () => import('./components/FileManager').then((m) => ({ default: m.FileManager }))
const FileManager = lazy(loadFileManager)
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
      if (meta && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        document.getElementById('connection-search')?.focus()
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
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
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

  async function importConnections(): Promise<void> {
    try {
      const result = await window.easySsh.importConnections()
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
      <div className="body">
        <Sidebar
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
            {tabs.map((tab) => (
              <TerminalView
                key={tab.id}
                sessionId={tab.sessionId}
                active={tab.id === activeTabId && tab.mode === 'terminal'}
                register={registerWriter}
              />
            ))}
            <Suspense fallback={null}>
            {tabs
              .filter((tab) => tab.filesOpened)
              .map((tab) => (
                <FileManager
                  key={`fm-${tab.id}`}
                  sessionId={tab.sessionId}
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
    </div>
  )
}
