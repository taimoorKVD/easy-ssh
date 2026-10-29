import { app, BrowserWindow, Menu, nativeTheme, shell } from 'electron'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { SessionStatus } from '../shared/types'
import { registerIpc } from './ipc'
import { recordSmokeData, recordSmokeStatus, runSmoke } from './smoke'
import { OutputBatcher } from '../shared/batcher'
import { isSafeExternalUrl } from './security'
import { SessionManager } from './ssh-manager'
import { SftpManager } from './sftp-manager'
import { Store } from './store'

if (process.env.EASY_SSH_SMOKE_DATA) {
  app.setPath('userData', process.env.EASY_SSH_SMOKE_DATA)
}

if (process.platform === 'linux') {
  app.commandLine.appendSwitch('password-store', 'gnome-libsecret')
}

nativeTheme.themeSource = 'dark'

const gotLock = process.env.EASY_SSH_SMOKE === '1' ? true : app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
}

let mainWindow: BrowserWindow | null = null

function iconFile(): string | undefined {
  const candidates = [
    join(app.getAppPath(), 'build/icon.png'),
    join(process.cwd(), 'build/icon.png'),
    join(__dirname, '../../build/icon.png')
  ]
  return candidates.find((candidate) => existsSync(candidate))
}

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 960,
    minHeight: 640,
    show: false,
    backgroundColor: '#0c0f14',
    title: 'easy-ssh',
    frame: process.platform === 'darwin',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    trafficLightPosition: { x: 16, y: 12 },
    autoHideMenuBar: true,
    icon: iconFile(),
    webPreferences: {
      preload: join(__dirname, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      nodeIntegrationInSubFrames: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false,
      navigateOnDragDrop: false,
      spellcheck: false
    }
  })

  win.once('ready-to-show', () => win.show())
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isSafeExternalUrl(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (event, url) => {
    const current = win.webContents.getURL()
    if (url !== current) event.preventDefault()
  })
  win.webContents.on('will-redirect', (event) => event.preventDefault())
  win.webContents.on('will-attach-webview', (event) => event.preventDefault())

  if (!app.isPackaged) {
    win.webContents.on('before-input-event', (event, input) => {
      if (input.type === 'keyDown' && input.control && input.shift && input.key.toLowerCase() === 'i') {
        win.webContents.toggleDevTools()
        event.preventDefault()
      }
    })
  }

  const devUrl = process.env.ELECTRON_RENDERER_URL
  if (devUrl) void win.loadURL(devUrl)
  else void win.loadFile(join(__dirname, '../renderer/index.html'))

  return win
}

function sendMenu(action: 'new' | 'import' | 'export'): void {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('menu:action', action)
}

function installMenu(): void {
  const template: Electron.MenuItemConstructorOptions[] = [
    {
      label: 'File',
      submenu: [
        { label: 'New connection', accelerator: 'CmdOrCtrl+N', click: () => sendMenu('new') },
        { label: 'Import…', click: () => sendMenu('import') },
        { label: 'Export…', click: () => sendMenu('export') },
        { type: 'separator' },
        { role: 'quit' }
      ]
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' }
      ]
    },
    {
      label: 'View',
      submenu: [
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' }
      ]
    },
    {
      label: 'Window',
      submenu: [{ role: 'minimize' }, { role: 'close' }]
    }
  ]
  if (!app.isPackaged) {
    const view = template.find((item) => item.label === 'View')
    view?.submenu && Array.isArray(view.submenu) && view.submenu.push({ role: 'toggleDevTools' })
  }
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

if (gotLock) {
  app.on('second-instance', () => {
    if (!mainWindow) return
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.focus()
  })

  app.whenReady().then(async () => {
    const { session: electronSession } = await import('electron')
    // No camera, mic, notifications, geolocation, etc. for the renderer.
    electronSession.defaultSession.setPermissionRequestHandler((_wc, _perm, callback) => callback(false))
    electronSession.defaultSession.setPermissionCheckHandler(() => false)
    if (app.isPackaged) {
      const { session } = await import('electron')
      session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
        callback({
          responseHeaders: {
            ...details.responseHeaders,
            'Content-Security-Policy': [
              "default-src 'none'; style-src 'self' 'unsafe-inline'; script-src 'self'; img-src 'self' data:; font-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"
            ]
          }
        })
      })
    }

    const store = new Store()
    const send = (channel: string, payload: unknown): void => {
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload)
    }
    // Coalesce terminal output so floods become a few IPC messages per frame.
    const output = new OutputBatcher((sessionId, data) => send('ssh:data', { sessionId, data }))
    const sessions = new SessionManager(store, {
      data: (sessionId, data) => {
        if (process.env.EASY_SSH_SMOKE === '1') recordSmokeData(sessionId, data)
        output.push(sessionId, data)
      },
      status: (status: SessionStatus) => {
        output.flushKey(status.sessionId)
        if (process.env.EASY_SSH_SMOKE === '1') recordSmokeStatus(status)
        send('ssh:status', status)
      },
      hostKey: (prompt) => {
        send('ssh:hostkey', prompt)
      }
    })

    if (process.env.EASY_SSH_SMOKE === '1') {
      const code = await runSmoke(store, sessions)
      sessions.disconnectAll()
      app.exit(code)
      return
    }

    const sftp = new SftpManager(sessions, (progress) => send('sftp:progress', progress))
    registerIpc(() => mainWindow, store, sessions, sftp, send)
    installMenu()
    mainWindow = createWindow()
    app.on('before-quit', () => sessions.disconnectAll())
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) mainWindow = createWindow()
    })
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })
}
