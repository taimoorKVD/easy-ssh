import { app, clipboard, dialog, ipcMain, shell, type BrowserWindow } from 'electron'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join } from 'node:path'
import type { ConnectionInput } from '../shared/types'
import { openSystemTerminal } from './system-terminal'
import { SessionManager } from './ssh-manager'
import { SftpManager } from './sftp-manager'
import { TEXT_EDIT_LIMIT, isLikelyText } from '../shared/remote-fs'
import { Store, encryptionStatus } from './store'

function asId(value: unknown, label = 'id'): string {
  if (typeof value !== 'string' || !/^[0-9a-f-]{8,80}$/i.test(value)) {
    throw new Error(`Invalid ${label}.`)
  }
  return value
}

function asRemotePath(value: unknown): string {
  if (typeof value !== 'string' || !value || value.length > 4096 || value.includes('\0')) throw new Error('Invalid remote path.')
  if (!value.startsWith('/') && value !== '.' && value !== '~') throw new Error('Remote paths must be absolute.')
  return value === '~' ? '.' : value
}

function asRemotePaths(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 5000) throw new Error('Invalid selection.')
  return value.map(asRemotePath)
}

function asLocalPaths(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 5000) throw new Error('Nothing to upload.')
  return value.map((item) => {
    if (typeof item !== 'string' || !isAbsolute(item) || item.includes('\0') || !existsSync(item)) {
      throw new Error('One of the dropped items could not be read.')
    }
    return item
  })
}

export function registerIpc(
  getWindow: () => BrowserWindow | null,
  store: Store,
  sessions: SessionManager,
  sftp: SftpManager
): void {
  const sid = (value: unknown): string => asId(value, 'session')
  ipcMain.handle('sftp:home', (_e, s: unknown) => sftp.home(sid(s)))
  ipcMain.handle('sftp:list', (_e, s: unknown, p: unknown) => sftp.list(sid(s), asRemotePath(p)))
  ipcMain.handle('sftp:mkdir', (_e, s: unknown, p: unknown) => sftp.mkdir(sid(s), asRemotePath(p)))
  ipcMain.handle('sftp:createFile', (_e, s: unknown, p: unknown) => sftp.createFile(sid(s), asRemotePath(p)))
  ipcMain.handle('sftp:rename', (_e, s: unknown, a: unknown, b: unknown) => sftp.rename(sid(s), asRemotePath(a), asRemotePath(b)))
  ipcMain.handle('sftp:remove', (_e, s: unknown, p: unknown) => sftp.remove(sid(s), asRemotePaths(p)))
  ipcMain.handle('sftp:chmod', (_e, s: unknown, p: unknown, mode: unknown) => {
    if (typeof mode !== 'number' || !Number.isInteger(mode) || mode < 0 || mode > 0o7777) throw new Error('Invalid permissions.')
    return sftp.chmod(sid(s), asRemotePath(p), mode)
  })
  ipcMain.handle('sftp:readText', (_e, s: unknown, p: unknown) => sftp.readText(sid(s), asRemotePath(p)))
  ipcMain.handle('sftp:writeText', (_e, s: unknown, p: unknown, content: unknown) => {
    if (typeof content !== 'string' || Buffer.byteLength(content, 'utf8') > TEXT_EDIT_LIMIT * 2) throw new Error('Invalid file content.')
    return sftp.writeText(sid(s), asRemotePath(p), content)
  })
  ipcMain.handle('sftp:open', async (_e, s: unknown, p: unknown) => {
    const local = await sftp.downloadToTemp(sid(s), asRemotePath(p))
    const error = await shell.openPath(local)
    if (error) throw new Error(`Downloaded, but no app could open it: ${error}`)
    return local
  })
  ipcMain.handle('sftp:upload', (_e, s: unknown, local: unknown, dir: unknown) => sftp.upload(sid(s), asLocalPaths(local), asRemotePath(dir)))
  ipcMain.handle('sftp:uploadPick', async (_e, s: unknown, dir: unknown, folders: unknown) => {
    const sessionId = sid(s)
    const remoteDir = asRemotePath(dir)
    const win = getWindow()
    if (!win) return false
    const result = await dialog.showOpenDialog(win, {
      title: folders === true ? 'Upload folders' : 'Upload files',
      properties: folders === true ? ['openDirectory', 'multiSelections'] : ['openFile', 'multiSelections']
    })
    if (result.canceled || result.filePaths.length === 0) return false
    await sftp.upload(sessionId, result.filePaths, remoteDir)
    return true
  })
  ipcMain.handle('sftp:download', async (_e, s: unknown, p: unknown, singleFile: unknown) => {
    const sessionId = sid(s)
    const paths = asRemotePaths(p)
    const win = getWindow()
    if (!win) return false
    if (paths.length === 1 && singleFile === true) {
      const name = paths[0].split('/').pop() || 'download'
      const result = await dialog.showSaveDialog(win, { title: 'Download file', defaultPath: join(app.getPath('downloads'), name) })
      if (result.canceled || !result.filePath) return false
      await sftp.download(sessionId, paths, dirname(result.filePath), undefined, basename(result.filePath))
      return true
    }
    const result = await dialog.showOpenDialog(win, {
      title: 'Choose a folder to download into',
      defaultPath: app.getPath('downloads'),
      properties: ['openDirectory', 'createDirectory']
    })
    if (result.canceled || !result.filePaths[0]) return false
    await sftp.download(sessionId, paths, result.filePaths[0])
    return true
  })
  ipcMain.handle('sftp:isText', (_e, name: unknown) => typeof name === 'string' && isLikelyText(name))

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
    sftp.release(asId(sessionId, 'session'))
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
