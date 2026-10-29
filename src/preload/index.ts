import { contextBridge, ipcRenderer, webUtils, type IpcRendererEvent } from 'electron'
import type { TransferProgress } from '../shared/remote-fs'
import type { EasySshApi } from '../shared/api'
import type { SnippetInput } from '../shared/snippets'
import type { ConnectionInput, HostKeyPrompt, SessionStatus } from '../shared/types'

const api = {
  listKeys: () => ipcRenderer.invoke('keys:list'),
  generateKey: (name: string) => ipcRenderer.invoke('keys:generate', name),
  importKey: (name: string, passphrase: string) => ipcRenderer.invoke('keys:import', name, passphrase),
  removeKey: (id: string) => ipcRenderer.invoke('keys:remove', id),
  publicKey: (id: string) => ipcRenderer.invoke('keys:public', id),
  installKey: (s: string, id: string) => ipcRenderer.invoke('keys:install', s, id),
  setForwards: (id: string, rules: unknown) => ipcRenderer.invoke('connections:setForwards', id, rules),
  setMeta: (id: string, meta: unknown) => ipcRenderer.invoke('connections:setMeta', id, meta),
  importSshConfig: () => ipcRenderer.invoke('connections:importSshConfig'),
  backupCreate: (password: string, includeKeys: boolean) => ipcRenderer.invoke('backup:create', password, includeKeys),
  backupRestore: (password: string) => ipcRenderer.invoke('backup:restore', password),
  listForwards: (s: string) => ipcRenderer.invoke('fwd:list', s),
  startForward: (s: string, r: string) => ipcRenderer.invoke('fwd:start', s, r),
  stopForward: (s: string, r: string) => ipcRenderer.invoke('fwd:stop', s, r),
  onForwardState: (callback) => {
    const listener = (_event: IpcRendererEvent, state: { sessionId: string; ruleId: string; active: boolean }) => callback(state)
    ipcRenderer.on('fwd:state', listener)
    return () => ipcRenderer.removeListener('fwd:state', listener)
  },
  getMeta: () => ipcRenderer.invoke('app:meta'),
  serverStats: (sessionId: string) => ipcRenderer.invoke('ssh:stats', sessionId),
  listSnippets: () => ipcRenderer.invoke('snippets:list'),
  saveSnippet: (input: SnippetInput) => ipcRenderer.invoke('snippets:save', input),
  deleteSnippet: (id: string) => ipcRenderer.invoke('snippets:delete', id),
  listConnections: () => ipcRenderer.invoke('connections:list'),
  saveConnection: (input: ConnectionInput) => ipcRenderer.invoke('connections:save', input),
  deleteConnection: (id: string) => ipcRenderer.invoke('connections:delete', id),
  setSecret: (id: string, secret: { password?: string; passphrase?: string }) =>
    ipcRenderer.invoke('connections:setSecret', id, secret),
  exportConnections: () => ipcRenderer.invoke('connections:export'),
  importConnections: () => ipcRenderer.invoke('connections:import'),
  selectPrivateKey: () => ipcRenderer.invoke('dialog:privateKey'),
  connect: (connectionId: string, plain?: boolean) => ipcRenderer.invoke('ssh:connect', connectionId, plain === true),
  disconnect: (sessionId: string) => ipcRenderer.invoke('ssh:disconnect', sessionId),
  write: (sessionId: string, data: string) => ipcRenderer.send('ssh:write', sessionId, data),
  resize: (sessionId: string, cols: number, rows: number) => ipcRenderer.send('ssh:resize', sessionId, cols, rows),
  respondHostKey: (sessionId: string, accept: boolean, save: boolean) =>
    ipcRenderer.send('ssh:hostkey', sessionId, accept, save),
  openSystemTerminal: (connectionId: string) => ipcRenderer.invoke('ssh:systemTerminal', connectionId),
  openExternal: (url: string) => ipcRenderer.invoke('shell:openExternal', url),
  clipboardRead: () => ipcRenderer.invoke('clipboard:read'),
  clipboardWrite: (text: string) => ipcRenderer.invoke('clipboard:write', text),
  windowMinimize: () => ipcRenderer.invoke('window:minimize'),
  windowMaximize: () => ipcRenderer.invoke('window:maximize'),
  windowClose: () => ipcRenderer.invoke('window:close'),
  onSshData: (callback) => {
    const listener = (_event: IpcRendererEvent, payload: { sessionId: string; data: string }) => callback(payload)
    ipcRenderer.on('ssh:data', listener)
    return () => ipcRenderer.removeListener('ssh:data', listener)
  },
  onSshStatus: (callback) => {
    const listener = (_event: IpcRendererEvent, status: SessionStatus) => callback(status)
    ipcRenderer.on('ssh:status', listener)
    return () => ipcRenderer.removeListener('ssh:status', listener)
  },
  onHostKey: (callback) => {
    const listener = (_event: IpcRendererEvent, prompt: HostKeyPrompt) => callback(prompt)
    ipcRenderer.on('ssh:hostkey', listener)
    return () => ipcRenderer.removeListener('ssh:hostkey', listener)
  },
  sftpHome: (s: string) => ipcRenderer.invoke('sftp:home', s),
  sftpList: (s: string, p: string) => ipcRenderer.invoke('sftp:list', s, p),
  sftpMkdir: (s: string, p: string) => ipcRenderer.invoke('sftp:mkdir', s, p),
  sftpCreateFile: (s: string, p: string) => ipcRenderer.invoke('sftp:createFile', s, p),
  sftpRename: (s: string, a: string, b: string) => ipcRenderer.invoke('sftp:rename', s, a, b),
  sftpRemove: (s: string, p: string[]) => ipcRenderer.invoke('sftp:remove', s, p),
  sftpChmod: (s: string, p: string, mode: number) => ipcRenderer.invoke('sftp:chmod', s, p, mode),
  sftpReadText: (s: string, p: string) => ipcRenderer.invoke('sftp:readText', s, p),
  sftpWriteText: (s: string, p: string, c: string) => ipcRenderer.invoke('sftp:writeText', s, p, c),
  sftpOpen: (s: string, p: string) => ipcRenderer.invoke('sftp:open', s, p),
  sftpUpload: (s: string, local: string[], dir: string) => ipcRenderer.invoke('sftp:upload', s, local, dir),
  sftpUploadPick: (s: string, dir: string, folders: boolean) => ipcRenderer.invoke('sftp:uploadPick', s, dir, folders),
  sftpDownload: (s: string, p: string[], single: boolean) => ipcRenderer.invoke('sftp:download', s, p, single),
  sftpSearch: (s: string, id: string, dir: string, mode: string, pattern: string) => ipcRenderer.invoke('sftp:search', s, id, dir, mode, pattern),
  sftpSearchCancel: (id: string) => ipcRenderer.invoke('sftp:searchCancel', id),
  sftpRetry: (id: string) => ipcRenderer.invoke('sftp:retry', id),
  sftpCancel: (id: string) => ipcRenderer.invoke('sftp:cancel', id),
  sftpEditLocal: (s: string, p: string) => ipcRenderer.invoke('sftp:editLocal', s, p),
  sftpDownloadTo: (s: string, p: string[], dir: string) => ipcRenderer.invoke('sftp:downloadTo', s, p, dir),
  localHome: () => ipcRenderer.invoke('local:home'),
  localList: (dir: string) => ipcRenderer.invoke('local:list', dir),
  onAutoUploaded: (callback) => {
    const listener = (_event: IpcRendererEvent, info: { sessionId: string; path: string; error?: string }): void => callback(info)
    ipcRenderer.on('sftp:autoUploaded', listener)
    return () => ipcRenderer.removeListener('sftp:autoUploaded', listener)
  },
  pathForFile: (file: File) => webUtils.getPathForFile(file),
  onSftpProgress: (callback) => {
    const listener = (_event: IpcRendererEvent, progress: TransferProgress) => callback(progress)
    ipcRenderer.on('sftp:progress', listener)
    return () => ipcRenderer.removeListener('sftp:progress', listener)
  },
  onMenu: (callback) => {
    const listener = (_event: IpcRendererEvent, action: 'new' | 'import' | 'export') => callback(action)
    ipcRenderer.on('menu:action', listener)
    return () => ipcRenderer.removeListener('menu:action', listener)
  }
} satisfies EasySshApi

contextBridge.exposeInMainWorld('easySsh', api)
