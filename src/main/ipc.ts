import { app, clipboard, dialog, ipcMain, shell, type BrowserWindow } from 'electron'
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { homedir, userInfo } from 'node:os'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import type { ConnectionInput } from '../shared/types'
import { openSystemTerminal } from './system-terminal'
import { SessionManager } from './ssh-manager'
import { SftpManager } from './sftp-manager'
import { TEXT_EDIT_LIMIT, isLikelyText } from '../shared/remote-fs'
import { Store, encryptionStatus } from './store'
import { SnippetStore } from './snippets'
import { validateSnippet } from '../shared/snippets'
import { ID_RE, isExecutableName, isSafeExternalUrl } from './security'
import { STATS_COMMAND } from '../shared/stats'
import { ForwardManager } from './forward-manager'
import { authorizedKeysCommand } from '../shared/keys'
import { parseSshConfig } from '../shared/ssh-config'
import { buildSearchCommand, parseSearchOutput, validateSearch } from '../shared/remote-search'
import { spawn } from 'node:child_process'
import { checkBackupPassword, decryptBackup, encryptBackup } from './backup-crypto'
import { readdir, stat } from 'node:fs/promises'
import type { Client } from 'ssh2'
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
export function handle(channel: string, fn: Handler): void {
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

/** Run one fixed command on an exec channel, with a timeout and output cap. */
export function runExec(client: Client, command: string, timeoutMs = 10_000, cap = 65_536, signal?: AbortSignal): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve, reject) => {
    let out = ''
    let settled = false
    const done = (fn: () => void): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      fn()
    }
    const timer = setTimeout(() => done(() => reject(new Error('The server took too long to answer.'))), timeoutMs)
    client.exec(command, (error, stream) => {
      if (error) return done(() => reject(error))
      const onChunk = (chunk: Buffer): void => {
        out += chunk.toString('utf8')
        if (out.length > cap) {
          stream.close()
          done(() => resolve({ code: null, out: out.slice(0, cap) }))
        }
      }
      stream.on('data', onChunk)
      stream.stderr.on('data', onChunk)
      stream.on('close', (code: number | null) => done(() => resolve({ code, out })))
      signal?.addEventListener('abort', () => {
        try {
          stream.signal('KILL')
        } catch {
          /* not supported by every server */
        }
        stream.close()
        done(() => reject(new Error('Search canceled.')))
      })
    })
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
  sftp: SftpManager,
  send: (channel: string, payload: unknown) => void
): void {
  const sid = (value: unknown): string => asId(value, 'session')
  const forwards = new ForwardManager((state) => send('fwd:state', state))
  const keys = sessions.keys
  handle('keys:list', () => keys.list())
  handle('keys:generate', (_e, name: unknown) => keys.generate(name))
  handle('keys:import', async (_e, name: unknown, passphrase: unknown) => {
    const win = getWindow()
    if (!win) return null
    const result = await dialog.showOpenDialog(win, {
      title: 'Import a private key',
      defaultPath: join(homedir(), '.ssh'),
      properties: ['openFile', 'dontAddToRecent']
    })
    if (result.canceled || !result.filePaths[0]) return null
    return keys.importFile(result.filePaths[0], name, passphrase)
  })
  handle('keys:remove', (_e, id: unknown) => {
    const keyId = asId(id, 'key')
    if (store.list().some((c) => c.keyId === keyId)) throw new Error('A connection still uses this key. Switch it to another key first.')
    return keys.remove(keyId)
  })
  handle('keys:public', (_e, id: unknown) => keys.publicKey(asId(id, 'key')))
  handle('keys:install', async (_e, s: unknown, id: unknown) => {
    const client = sessions.client(sid(s))
    if (!client) throw new Error('Connect to the server first.')
    const command = authorizedKeysCommand(await keys.publicKey(asId(id, 'key')))
    const { code, out } = await runExec(client, command)
    if (out.includes('EASYSSH_KEY_PRESENT')) return 'present'
    if (code === 0 && out.includes('EASYSSH_KEY_ADDED')) return 'added'
    throw new Error(`Could not add the key: ${out.trim().slice(0, 200) || `exit ${code}`}`)
  })
  handle('connections:setForwards', (_e, id: unknown, rules: unknown) => store.setForwards(asId(id), rules))
  handle('fwd:list', (_e, s: unknown) => forwards.list(sid(s)))
  handle('fwd:start', async (_e, s: unknown, ruleId: unknown) => {
    const sessionId = sid(s)
    const rid = asId(ruleId, 'rule')
    const connectionId = sessions.connectionOf(sessionId)
    const client = sessions.client(sessionId)
    if (!connectionId || !client) throw new Error('Connect first, then start the forward.')
    // The rule comes from the saved host, never from the renderer.
    const rule = store.get(connectionId)?.forwards?.find((item) => item.id === rid)
    if (!rule) throw new Error('That forwarding rule no longer exists.')
    await forwards.start(sessionId, client, rule)
  })
  handle('fwd:stop', (_e, s: unknown, ruleId: unknown) => forwards.stop(sid(s), asId(ruleId, 'rule')))
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
  const searches = new Map<string, AbortController>()
  handle('sftp:search', async (_e, s: unknown, searchId: unknown, dir: unknown, mode: unknown, pattern: unknown) => {
    const sessionId = sid(s)
    const id = asId(searchId, 'search')
    const q = validateSearch(dir, mode, pattern)
    const client = sessions.client(sessionId)
    if (!client) throw new Error('Connect first, then search.')
    searches.get(id)?.abort()
    const controller = new AbortController()
    searches.set(id, controller)
    try {
      const { out } = await runExec(client, buildSearchCommand(q.dir, q.mode, q.pattern), 60_000, 256 * 1024, controller.signal)
      return parseSearchOutput(q.mode, out)
    } finally {
      if (searches.get(id) === controller) searches.delete(id)
    }
  })
  handle('sftp:searchCancel', (_e, searchId: unknown) => {
    searches.get(asId(searchId, 'search'))?.abort()
  })
  handle('sftp:retry', (_e, transferId: unknown) => sftp.retry(asId(transferId, 'transfer')))
  handle('sftp:cancel', (_e, transferId: unknown) => sftp.cancel(asId(transferId, 'transfer')))
  handle('sftp:editLocal', async (_e, s: unknown, p: unknown) => {
    const remote = asRemotePath(p)
    if (isExecutableName(remote.split('/').pop() ?? '')) {
      throw new Error('For your safety, easy-ssh will not open programs or scripts from a server. Download it instead.')
    }
    let editor = 'default app'
    await sftp.editLocal(
      sid(s),
      remote,
      async (local) => {
        const code = findVsCode()
        if (code) {
          spawn(code, [local], { detached: true, stdio: 'ignore', windowsHide: false }).unref()
          editor = 'VS Code'
          return
        }
        const error = await shell.openPath(local)
        if (error) throw new Error(`No app could open it: ${error}`)
      },
      (path, error) => send('sftp:autoUploaded', { sessionId: sid(s), path, error })
    )
    return editor
  })
  handle('local:home', () => homedir())
  handle('local:list', async (_e, dir: unknown) => {
    if (typeof dir !== 'string' || !isAbsolute(dir) || dir.includes('\0') || dir.length > 4096) throw new Error('Invalid local folder.')
    const items = await readdir(dir, { withFileTypes: true })
    const entries = await Promise.all(
      items.slice(0, 5000).map(async (item) => {
        const full = join(dir, item.name)
        const st = await stat(full).catch(() => null)
        return { name: item.name, path: full, kind: item.isDirectory() || st?.isDirectory() ? 'dir' : 'file', size: st?.size ?? 0, mtime: st?.mtimeMs ?? 0 }
      })
    )
    return { path: resolve(dir), parent: dirname(resolve(dir)), entries }
  })
  handle('sftp:downloadTo', (_e, s: unknown, p: unknown, localDir: unknown) => {
    if (typeof localDir !== 'string' || !isAbsolute(localDir) || localDir.includes('\0') || !existsSync(localDir) || !statSync(localDir).isDirectory()) {
      throw new Error('Choose a local folder first.')
    }
    return sftp.download(sid(s), asRemotePaths(p), localDir)
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

  // Encrypted backup: hosts + snippets (+ saved keys when asked). Nothing leaves main unencrypted.
  handle('backup:create', async (_e, password: unknown, includeKeys: unknown) => {
    const pass = checkBackupPassword(password)
    const win = getWindow()
    if (!win) return { canceled: true }
    const result = await dialog.showSaveDialog(win, {
      title: 'Save encrypted backup',
      defaultPath: `easy-ssh-backup-${new Date().toISOString().slice(0, 10)}.essh`,
      filters: [{ name: 'easy-ssh backup', extensions: ['essh'] }]
    })
    if (result.canceled || !result.filePath) return { canceled: true }
    const payload = {
      connections: store.exportBundle(),
      snippets: await snippets.list(),
      keys: includeKeys === true ? await sessions.keys.exportAll() : []
    }
    writeFileSync(result.filePath, await encryptBackup(payload, pass), { encoding: 'utf8', mode: 0o600 })
    return { canceled: false, path: result.filePath, hosts: payload.connections.connections.length, snippets: payload.snippets.length, keys: payload.keys.length }
  })

  handle('backup:restore', async (_e, password: unknown) => {
    if (typeof password !== 'string' || !password || password.length > 1024) throw new Error('Enter the backup password.')
    const win = getWindow()
    if (!win) return { canceled: true }
    const result = await dialog.showOpenDialog(win, {
      title: 'Restore encrypted backup',
      filters: [{ name: 'easy-ssh backup', extensions: ['essh'] }],
      properties: ['openFile']
    })
    const file = result.filePaths[0]
    if (result.canceled || !file) return { canceled: true }
    if (statSync(file).size > 8 * 1024 * 1024) throw new Error('That backup file is too large.')
    const data = (await decryptBackup(readFileSync(file, 'utf8'), password)) as Record<string, unknown> | null
    if (!data || typeof data !== 'object') throw new Error('That backup is empty.')
    const keyMap = new Map<string, string>()
    let keys = 0
    for (const k of Array.isArray(data.keys) ? data.keys.slice(0, 100) : []) {
      if (!k || typeof k !== 'object' || typeof k.id !== 'string') continue
      try {
        keyMap.set(k.id, await sessions.keys.restore(k.name, k.privateKey, k.passphrase))
        keys += 1
      } catch {
        // Skip a key that does not parse.
      }
    }
    const outcome = await store.importMapped(data.connections, keyMap)
    let snippetCount = 0
    const existing = await snippets.list()
    for (const raw of Array.isArray(data.snippets) ? data.snippets.slice(0, 500) : []) {
      try {
        const input = validateSnippet({ ...(raw as object), id: undefined })
        const mapped = input.connectionId ? outcome.idMap.get(input.connectionId) : undefined
        if (existing.some((s) => s.name === input.name && s.command === input.command)) continue
        await snippets.save({ ...input, connectionId: mapped ?? null })
        snippetCount += 1
      } catch {
        // Skip invalid snippets.
      }
    }
    return { canceled: false, imported: outcome.imported, skipped: outcome.skipped, snippets: snippetCount, keys }
  })

  handle('connections:setMeta', (_e, id: unknown, meta: unknown) => store.setMeta(asId(id), meta))

  handle('connections:importSshConfig', async () => {
    const home = homedir()
    let path = join(home, '.ssh', 'config')
    if (!existsSync(path)) {
      const win = getWindow()
      if (!win) return { canceled: true, imported: 0, skipped: 0 }
      const pick = await dialog.showOpenDialog(win, { title: 'Choose an ssh config file', defaultPath: join(home, '.ssh'), properties: ['openFile', 'dontAddToRecent'] })
      if (pick.canceled || !pick.filePaths[0]) return { canceled: true, imported: 0, skipped: 0 }
      path = pick.filePaths[0]
    }
    if (statSync(path).size > 512 * 1024) throw new Error('That ssh config is too large to import.')
    const fallbackUser = userInfo().username
    const entries = parseSshConfig(readFileSync(path, 'utf8'), home).map((e) => ({ ...e, username: e.username || fallbackUser }))
    const outcome = await store.importBundle({ kind: 'easy-ssh-connections', version: 1, connections: entries })
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

  handle('ssh:connect', (_event, connectionId: unknown, plain: unknown) => sessions.connect(asId(connectionId, 'connection'), plain === true))

  // Server stats: runs a fixed read-only probe on a separate exec channel of the same connection.
  const statsBusy = new Set<string>()
  handle('ssh:stats', (_event, rawId: unknown) => {
    const sessionId = asId(rawId, 'session')
    const client = sessions.client(sessionId)
    if (!client || statsBusy.has(sessionId)) return null
    statsBusy.add(sessionId)
    return new Promise<string | null>((resolve) => {
      let out = ''
      let done = false
      const finish = (value: string | null): void => {
        if (done) return
        done = true
        clearTimeout(timer)
        statsBusy.delete(sessionId)
        resolve(value)
      }
      const timer = setTimeout(() => finish(null), 4000)
      try {
        client.exec(STATS_COMMAND, (error, stream) => {
          if (error) return finish(null)
          stream.on('data', (chunk: Buffer) => {
            out += chunk.toString('utf8')
            if (out.length > 16_384) {
              stream.close()
              finish(null)
            }
          })
          stream.stderr.resume()
          stream.on('close', () => finish(out))
          stream.on('error', () => finish(null))
        })
      } catch {
        finish(null)
      }
    })
  })

  handle('ssh:disconnect', (_event, sessionId: unknown) => {
    sftp.release(asId(sessionId, 'session'))
    forwards.stopSession(asId(sessionId, 'session'))
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

function findVsCode(): string | null {
  const env = process.env
  const candidates =
    process.platform === 'win32'
      ? [
          env.LOCALAPPDATA && join(env.LOCALAPPDATA, 'Programs', 'Microsoft VS Code', 'Code.exe'),
          env.ProgramFiles && join(env.ProgramFiles, 'Microsoft VS Code', 'Code.exe'),
          env['ProgramFiles(x86)'] && join(env['ProgramFiles(x86)'], 'Microsoft VS Code', 'Code.exe')
        ]
      : process.platform === 'darwin'
        ? ['/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code']
        : ['/usr/bin/code', '/usr/local/bin/code', '/snap/bin/code']
  return candidates.find((c): c is string => Boolean(c) && existsSync(c as string)) ?? null
}
