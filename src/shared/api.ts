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
import type { RemoteEntry, TransferProgress } from './remote-fs'

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
  sftpHome(sessionId: string): Promise<string>
  sftpList(sessionId: string, path: string): Promise<{ path: string; entries: RemoteEntry[] }>
  sftpMkdir(sessionId: string, path: string): Promise<void>
  sftpCreateFile(sessionId: string, path: string): Promise<void>
  sftpRename(sessionId: string, from: string, to: string): Promise<void>
  sftpRemove(sessionId: string, paths: string[]): Promise<void>
  sftpChmod(sessionId: string, path: string, mode: number): Promise<void>
  sftpReadText(sessionId: string, path: string): Promise<{ content: string; size: number }>
  sftpWriteText(sessionId: string, path: string, content: string): Promise<void>
  sftpOpen(sessionId: string, path: string): Promise<string>
  sftpUpload(sessionId: string, localPaths: string[], remoteDir: string): Promise<void>
  sftpUploadPick(sessionId: string, remoteDir: string, folders: boolean): Promise<boolean>
  sftpDownload(sessionId: string, paths: string[], singleFile: boolean): Promise<boolean>
  pathForFile(file: File): string
  onSftpProgress(callback: (progress: TransferProgress) => void): () => void
  onMenu(callback: (action: 'new' | 'import' | 'export') => void): () => void
}
