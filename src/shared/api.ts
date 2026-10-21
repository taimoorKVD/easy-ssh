import type {
  AppMeta,
  ConnectionInput,
  ConnectionPublic,
  ExportResult,
  HostKeyPrompt,
  ImportResult,
  SessionStatus,
  TerminalLaunchResult
} from './types'

export interface EasySshApi {
  getMeta(): Promise<AppMeta>
  listConnections(): Promise<ConnectionPublic[]>
  saveConnection(input: ConnectionInput): Promise<ConnectionPublic>
  deleteConnection(id: string): Promise<void>
  setSecret(id: string, secret: { password?: string; passphrase?: string }): Promise<void>
  exportConnections(): Promise<ExportResult>
  importConnections(): Promise<ImportResult>
  selectPrivateKey(): Promise<string | null>
  connect(connectionId: string): Promise<string>
  disconnect(sessionId: string): Promise<void>
  write(sessionId: string, data: string): void
  resize(sessionId: string, cols: number, rows: number): void
  respondHostKey(sessionId: string, accept: boolean, save: boolean): void
  openSystemTerminal(connectionId: string): Promise<TerminalLaunchResult>
  openExternal(url: string): Promise<void>
  clipboardRead(): Promise<string>
  clipboardWrite(text: string): Promise<void>
  windowMinimize(): Promise<void>
  windowMaximize(): Promise<void>
  windowClose(): Promise<void>
  onSshData(callback: (payload: { sessionId: string; data: string }) => void): () => void
  onSshStatus(callback: (status: SessionStatus) => void): () => void
  onHostKey(callback: (prompt: HostKeyPrompt) => void): () => void
  onMenu(callback: (action: 'new' | 'import' | 'export') => void): () => void
}
