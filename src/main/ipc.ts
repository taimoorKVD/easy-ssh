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
import { SnippetStore } from './snippets'
import { validateSnippet } from '../shared/snippets'
import { ID_RE, isExecutableName, isSafeExternalUrl } from './security'
import type { IpcMainEvent, IpcMainInvokeEvent } from 'electron'

/** Only our own bundled page may call privileged IPC. */
function trustedSender(event: IpcMainEvent | IpcMainInvokeEvent): boolean {
  const url = event.senderFrame?.url ?? ''
  if (url.startsWith('file://')) return true
  const dev = process.env.ELECTRON_RENDERER_URL
  return Boolean(dev && !app.isPackaged && url.startsWith(dev))
}

type Handler = (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown
type Listener = (event: IpcMainEvent, ...args: unknown[]) => void
function handle(channel: string, fn: Handler): void {
  ipcMain.handle(channel, (event, ...args) => {
    if (!trustedSender(event)) throw new Error('Blocked an IPC call from an untrusted page.')
    return fn(event, ...args)
  })
}
function on(channel: string, fn: Listener): void {
  ipcMain.on(channel, (event, ...args) => {
    if (trustedSender(event)) fn(event, ...args)
  })
}

function asId(value: unknown, label = 'id'): string {
  if (typeof value !== 'string' || !ID_RE.test(value)) {
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
  const snippets = new SnippetStore()
  handle('snippets:list', () => snippets.list())
  handle('snippets:save', (_e, input: unknown) => snippets.save(validateSnippet(input)))
  handle('snippets:delete', (_e, id: unknown) => snippets.remove(asId(id, 'snippet')))
  handle('sftp:home', (_e, s: unknown) => sftp.home(sid(s)))
  handle('sftp:list', (_e, s: unknown, p: unknown) => sftp.list(sid(s), asRemotePath(p)))
  handle('sftp:mkdir', (_e, s: unknown, p: unknown) => sftp.mkdir(sid(s), asRemotePath(p)))
  handle('sftp:createFile', (_e, s: unknown, p: unknown) => sftp.createFile(sid(s), asRemotePath(p)))
  handle('sftp:rename', (_e, s: unknown, a: unknown, b: unknown) => sftp.rename(sid(s), asRemotePath(a), asRemotePath(b)))
  handle('sftp:remove', (_e, s: unknown, p: unknown) => sftp.remove(sid(s), asRemotePaths(p)))
  handle('sftp:chmod', (_e, s: unknown, p: unknown, mode: unknown) => {
    if (typeof mode !== 'number' || !Number.isInteger(mode) || mode < 0 || mode > 0o7777) throw new Error('Invalid permissions.')
    return sftp.chmod(sid(s), asRemotePath(p), mode)
  })
  handle('sftp:readText', (_e, s: unknown, p: unknown) => sftp.readText(sid(s), asRemotePath(p)))
  handle('sftp:writeText', (_e, s: unknown, p: unknown, content: unknown) => {
    if (typeof content !== 'string' || Buffer.byteLength(content, 'utf8') > TEXT_EDIT_LIMIT * 2) throw new Error('Invalid file content.')
    return sftp.writeText(sid(s), asRemotePath(p), content)
  })
  handle('sftp:open', async (_e, s: unknown, p: unknown) => {
    const remote = asRemotePath(p)
    if (isExecutableName(remote.split('/').pop() ?? '')) {
      throw new Error('For your safety, easy-ssh will not open programs or scripts from a server. Download it instead.')
    }
    const local = await sftp.downloadToTemp(sid(s), remote)
    const error = await shell.openPath(local)
    if (error) throw new Error(`Downloaded, but no app could open it: ${error}`)
    return local
  })
  handle('sftp:upload', (_e, s: unknown, local: unknown, dir: unknown) => sftp.upload(sid(s), asLocalPaths(local), asRemotePath(dir)))
  handle('sftp:uploadPick', async (_e, s: unknown, dir: unknown, folders: unknown) => {
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
  handle('sftp:download', async (_e, s: unknown, p: unknown, singleFile: unknown) => {
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
  handle('sftp:isText', (_e, name: unknown) => typeof name === 'string' && isLikelyText(name))

  handle('app:meta', async () => {
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

  handle('connections:list', () => store.list())

  handle('connections:save', (_event, input: unknown) => {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Invalid connection.')
    return store.save(input as ConnectionInput)
  })

  handle('connections:delete', (_event, id: unknown) => store.remove(asId(id)))

  handle('connections:setSecret', (_event, id: unknown, secret: unknown) => {
    if (!secret || typeof secret !== 'object') throw new Error('Missing secret.')
    const body = secret as { password?: unknown; passphrase?: unknown }
    for (const v of [body.password, body.passphrase]) if (typeof v === 'string' && v.length > 1024) throw new Error('Secret is too long.')
    return store.setSecret(asId(id), {
      password: typeof body.password === 'string' ? body.password : undefined,
      passphrase: typeof body.passphrase === 'string' ? body.passphrase : undefined
    })
  })

  handle('connections:export', async () => {
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

  handle('connections:import', async () => {
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

  handle('dialog:privateKey', async () => {
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

  handle('ssh:connect', (_event, connectionId: unknown) => sessions.connect(asId(connectionId, 'connection')))

  handle('ssh:disconnect', (_event, sessionId: unknown) => {
    sftp.release(asId(sessionId, 'session'))
    sessions.disconnect(asId(sessionId, 'session'))
  })

  on('ssh:write', (_event, sessionId: unknown, data: unknown) => {
    if (typeof sessionId !== 'string' || !ID_RE.test(sessionId) || typeof data !== 'string') return
    if (data.length > 1_000_000) return
    sessions.write(sessionId, data)
  })

  on('ssh:resize', (_event, sessionId: unknown, cols: unknown, rows: unknown) => {
    if (typeof sessionId !== 'string' || !ID_RE.test(sessionId)) return
    if (!Number.isInteger(cols) || !Number.isInteger(rows)) return
    sessions.resize(sessionId, cols as number, rows as number)
  })

  on('ssh:hostkey', (_event, sessionId: unknown, accept: unknown, save: unknown) => {
    if (typeof sessionId !== 'string' || !ID_RE.test(sessionId) || typeof accept !== 'boolean' || typeof save !== 'boolean') return
    sessions.respondHostKey(sessionId, accept, save)
  })

  handle('ssh:systemTerminal', (_event, connectionId: unknown) => {
    const record = store.get(asId(connectionId, 'connection'))
    if (!record) throw new Error('That connection no longer exists.')
    return openSystemTerminal(record)
  })

  handle('shell:openExternal', (_event, url: unknown) => {
    if (!isSafeExternalUrl(url)) return
    return shell.openExternal(url)
  })

  handle('clipboard:read', () => clipboard.readText())

  handle('clipboard:write', (_event, text: unknown) => {
    if (typeof text !== 'string') return
    clipboard.writeText(text.slice(0, 1_000_000))
  })

  handle('window:minimize', () => getWindow()?.minimize())
  handle('window:maximize', () => {
    const win = getWindow()
    if (!win) return
    if (win.isMaximized()) win.unmaximize()
    else win.maximize()
  })
  handle('window:close', () => getWindow()?.close())
}
