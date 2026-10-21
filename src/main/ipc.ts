import { app, clipboard, dialog, ipcMain, shell, type BrowserWindow } from 'electron'
import { readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { ConnectionInput } from '../shared/types'
import { openSystemTerminal } from './system-terminal'
import { SessionManager } from './ssh-manager'
import { Store, encryptionStatus } from './store'

function asId(value: unknown, label = 'id'): string {
  if (typeof value !== 'string' || !/^[0-9a-f-]{8,80}$/i.test(value)) {
    throw new Error(`Invalid ${label}.`)
  }
  return value
}

export function registerIpc(getWindow: () => BrowserWindow | null, store: Store, sessions: SessionManager): void {
  ipcMain.handle('app:meta', async () => {
    const encryption = await encryptionStatus()
    return {
      version: app.getVersion(),
      encryptionAvailable: encryption.available,
      encryptionBackend: encryption.backend,
      encryptionReason: encryption.reason,
      dataDir: store.dataDirectory(),
      platform: process.platform
    }
  })

  ipcMain.handle('connections:list', () => store.list())

  ipcMain.handle('connections:save', (_event, input: ConnectionInput) => store.save(input))

  ipcMain.handle('connections:delete', (_event, id: unknown) => store.remove(asId(id)))

  ipcMain.handle('connections:setSecret', (_event, id: unknown, secret: unknown) => {
    if (!secret || typeof secret !== 'object') throw new Error('Missing secret.')
    const body = secret as { password?: unknown; passphrase?: unknown }
    return store.setSecret(asId(id), {
      password: typeof body.password === 'string' ? body.password : undefined,
      passphrase: typeof body.passphrase === 'string' ? body.passphrase : undefined
    })
  })

  ipcMain.handle('connections:export', async () => {
    const win = getWindow()
    if (!win) return { canceled: true, count: 0 }
    const bundle = store.exportBundle()
    const result = await dialog.showSaveDialog(win, {
      title: 'Export connections',
      defaultPath: 'easy-ssh-connections.json',
      filters: [{ name: 'JSON', extensions: ['json'] }]
    })
    if (result.canceled || !result.filePath) return { canceled: true, count: 0 }
    writeFileSync(result.filePath, `${JSON.stringify(bundle, null, 2)}\n`, 'utf8')
    return { canceled: false, path: result.filePath, count: bundle.connections.length }
  })

  ipcMain.handle('connections:import', async () => {
    const win = getWindow()
    if (!win) return { canceled: true, imported: 0, skipped: 0 }
    const result = await dialog.showOpenDialog(win, {
      title: 'Import connections',
      filters: [{ name: 'JSON', extensions: ['json'] }],
      properties: ['openFile']
    })
    if (result.canceled || !result.filePaths[0]) return { canceled: true, imported: 0, skipped: 0 }
    let parsed: unknown
    try {
      parsed = JSON.parse(readFileSync(result.filePaths[0], 'utf8'))
    } catch {
      throw new Error('That file is not valid JSON.')
    }
    const outcome = await store.importBundle(parsed)
    return { canceled: false, ...outcome }
  })

  ipcMain.handle('dialog:privateKey', async () => {
    const win = getWindow()
    if (!win) return null
    const result = await dialog.showOpenDialog(win, {
      title: 'Choose a private key',
      defaultPath: join(homedir(), '.ssh'),
      properties: ['openFile', 'dontAddToRecent']
    })
    if (result.canceled || !result.filePaths[0]) return null
    return result.filePaths[0]
  })

  ipcMain.handle('ssh:connect', (_event, connectionId: unknown) => sessions.connect(asId(connectionId, 'connection')))

  ipcMain.handle('ssh:disconnect', (_event, sessionId: unknown) => {
    sessions.disconnect(asId(sessionId, 'session'))
  })

  ipcMain.on('ssh:write', (_event, sessionId: unknown, data: unknown) => {
    if (typeof sessionId !== 'string' || typeof data !== 'string') return
    if (data.length > 1_000_000) return
    sessions.write(sessionId, data)
  })

  ipcMain.on('ssh:resize', (_event, sessionId: unknown, cols: unknown, rows: unknown) => {
    if (typeof sessionId !== 'string' || typeof cols !== 'number' || typeof rows !== 'number') return
    sessions.resize(sessionId, cols, rows)
  })

  ipcMain.on('ssh:hostkey', (_event, sessionId: unknown, accept: unknown, save: unknown) => {
    if (typeof sessionId !== 'string' || typeof accept !== 'boolean' || typeof save !== 'boolean') return
    sessions.respondHostKey(sessionId, accept, save)
  })

  ipcMain.handle('ssh:systemTerminal', (_event, connectionId: unknown) => {
    const record = store.get(asId(connectionId, 'connection'))
    if (!record) throw new Error('That connection no longer exists.')
    return openSystemTerminal(record)
  })

  ipcMain.handle('shell:openExternal', (_event, url: unknown) => {
    if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) return
    return shell.openExternal(url)
  })

  ipcMain.handle('clipboard:read', () => clipboard.readText())

  ipcMain.handle('clipboard:write', (_event, text: unknown) => {
    if (typeof text !== 'string') return
    clipboard.writeText(text.slice(0, 1_000_000))
  })

  ipcMain.handle('window:minimize', () => getWindow()?.minimize())
  ipcMain.handle('window:maximize', () => {
    const win = getWindow()
    if (!win) return
    if (win.isMaximized()) win.unmaximize()
    else win.maximize()
  })
  ipcMain.handle('window:close', () => getWindow()?.close())
}
