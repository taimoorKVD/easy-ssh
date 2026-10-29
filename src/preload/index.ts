import { contextBridge, ipcRenderer, webUtils, type IpcRendererEvent } from 'electron'
import type { TransferProgress } from '../shared/remote-fs'
import type { EasySshApi } from '../shared/api'
import type { SnippetInput } from '../shared/snippets'
import type { ConnectionInput, HostKeyPrompt, SessionStatus } from '../shared/types'

const api = {
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
  connect: (connectionId: string) => ipcRenderer.invoke('ssh:connect', connectionId),
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
