import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import type { EasySshApi } from '../shared/api'
import type { ConnectionInput, HostKeyPrompt, SessionStatus } from '../shared/types'

const api = {
  getMeta: () => ipcRenderer.invoke('app:meta'),
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
  onMenu: (callback) => {
    const listener = (_event: IpcRendererEvent, action: 'new' | 'import' | 'export') => callback(action)
    ipcRenderer.on('menu:action', listener)
    return () => ipcRenderer.removeListener('menu:action', listener)
  }
} satisfies EasySshApi

contextBridge.exposeInMainWorld('easySsh', api)
