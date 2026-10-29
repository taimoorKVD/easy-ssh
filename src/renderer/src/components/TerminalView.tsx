import { getXtermTheme, onThemeChange } from '../lib/theme'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { WebglAddon } from '@xterm/addon-webgl'
import { Terminal } from '@xterm/xterm'
import { useEffect, useRef } from 'react'

interface TerminalViewProps {
  sessionId: string
  active: boolean
  register: (sessionId: string, write: ((data: string) => void) | null) => void
  /** When set, keystrokes go here instead of only this session (broadcast). */
  onInput?: (data: string) => void
  onFocus?: () => void
}

export function TerminalView({ sessionId, active, register, onInput, onFocus }: TerminalViewProps) {
  const inputRef = useRef(onInput)
  inputRef.current = onInput
  const focusRef = useRef(onFocus)
  focusRef.current = onFocus
  const hostRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const sessionRef = useRef(sessionId)
  const activeRef = useRef(active)
  const registerRef = useRef(register)
  const seenSession = useRef<string | null>(null)
  sessionRef.current = sessionId
  activeRef.current = active
  registerRef.current = register

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    const term = new Terminal({
      cursorBlink: true,
      cursorStyle: 'bar',
      fontFamily: '"IBM Plex Mono", ui-monospace, monospace',
      fontSize: 14,
      lineHeight: 1.35,
      scrollback: 8000,
      smoothScrollDuration: 0,
      theme: getXtermTheme()
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.loadAddon(
      new WebLinksAddon((event, uri) => {
        event.preventDefault()
        if (/^https?:\/\//i.test(uri)) void window.easySsh.openExternal(uri)
      })
    )
    term.open(host)
    const offTheme = onThemeChange((t) => {
      term.options.theme = getXtermTheme(t)
    })
    // GPU renderer: much faster scrolling/redraw than the DOM renderer. Falls back if WebGL is unavailable or lost.
    try {
      const webgl = new WebglAddon()
      webgl.onContextLoss(() => webgl.dispose())
      term.loadAddon(webgl)
    } catch {
      // DOM renderer stays in place
    }
    termRef.current = term
    fitRef.current = fit

    term.attachCustomKeyEventHandler((event) => {
      const key = event.key.toLowerCase()
      const copyCombo =
        event.type === 'keydown' &&
        ((event.ctrlKey && event.shiftKey && (key === 'c' || key === 'v')) ||
          ((event.metaKey || event.ctrlKey) && key === 'c' && term.hasSelection()) ||
          ((event.metaKey || event.ctrlKey) && key === 'v' && !event.shiftKey))
      if (!copyCombo) return true
      if (key === 'c' && term.hasSelection()) {
        void window.easySsh.clipboardWrite(term.getSelection())
        return false
      }
      if (key === 'v') {
        void window.easySsh.clipboardRead().then((text) => {
          if (text) window.easySsh.write(sessionRef.current, text)
        })
        return false
      }
      return true
    })

    const onContext = (event: MouseEvent): void => {
      event.preventDefault()
      void window.easySsh.clipboardRead().then((text) => {
        if (text) window.easySsh.write(sessionRef.current, text)
      })
    }
    term.element?.addEventListener('contextmenu', onContext)

    term.onData((data) => {
      if (inputRef.current) inputRef.current(data)
      else window.easySsh.write(sessionRef.current, data)
    })
    term.textarea?.addEventListener('focus', () => focusRef.current?.())

    const applySize = (): void => {
      if (!activeRef.current) return
      fit.fit()
      if (term.cols > 1 && term.rows > 1) window.easySsh.resize(sessionRef.current, term.cols, term.rows)
    }
    let resizeTimer: ReturnType<typeof setTimeout> | null = null
    let lastSent = ''
    const applySizeNow = (): void => {
      if (!activeRef.current) return
      fit.fit()
      const key = `${term.cols}x${term.rows}`
      if (term.cols > 1 && term.rows > 1 && key !== lastSent) {
        lastSent = key
        window.easySsh.resize(sessionRef.current, term.cols, term.rows)
      }
    }
    const observer = new ResizeObserver(() => {
      if (resizeTimer) clearTimeout(resizeTimer)
      resizeTimer = setTimeout(applySizeNow, 50)
    })
    observer.observe(host)
    applySize()

    return () => {
      offTheme()
      if (resizeTimer) clearTimeout(resizeTimer)
      observer.disconnect()
      term.element?.removeEventListener('contextmenu', onContext)
      registerRef.current(sessionRef.current, null)
      term.dispose()
      termRef.current = null
      fitRef.current = null
    }
  }, [])

  useEffect(() => {
    const term = termRef.current
    if (!term) return
    if (seenSession.current && seenSession.current !== sessionId) {
      term.write('\r\n\x1b[38;2;126;224;198m── reconnecting ──\x1b[0m\r\n')
    }
    seenSession.current = sessionId
    registerRef.current(sessionId, (data) => term.write(data))
    return () => registerRef.current(sessionId, null)
  }, [sessionId])

  useEffect(() => {
    if (!active) return
    const term = termRef.current
    const fit = fitRef.current
    if (!term || !fit) return
    fit.fit()
    if (term.cols > 1 && term.rows > 1) window.easySsh.resize(sessionId, term.cols, term.rows)
    term.focus()
  }, [active, sessionId])

  return <div ref={hostRef} className={`terminal-pane${active ? ' active' : ''}`} />
}
