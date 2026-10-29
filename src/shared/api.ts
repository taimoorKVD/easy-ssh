import type { KeyPublic } from './keys'
import type { ForwardRule } from './forwards'
import type { Snippet, SnippetInput } from './snippets'
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
import type { SearchHit, SearchMode } from './remote-search'

export interface LocalEntry {
  name: string
  path: string
  kind: 'dir' | 'file'
  size: number
  mtime: number
}

export interface ForwardStateEvent {
  sessionId: string
  ruleId: string
  active: boolean
}

export interface EasySshApi {
  listKeys(): Promise<KeyPublic[]>
  generateKey(name: string): Promise<KeyPublic>
  importKey(name: string, passphrase: string): Promise<KeyPublic | null>
  removeKey(id: string): Promise<void>
  publicKey(id: string): Promise<string>
  installKey(sessionId: string, keyId: string): Promise<'added' | 'present'>
  setForwards(connectionId: string, rules: ForwardRule[]): Promise<ConnectionPublic>
  setMeta(connectionId: string, meta: { favorite?: boolean; tags?: string[] }): Promise<ConnectionPublic>
  importSshConfig(): Promise<ImportResult>
  listForwards(sessionId: string): Promise<string[]>
  startForward(sessionId: string, ruleId: string): Promise<void>
  stopForward(sessionId: string, ruleId: string): Promise<void>
  onForwardState(callback: (state: ForwardStateEvent) => void): () => void
  listSnippets(): Promise<Snippet[]>
  saveSnippet(input: SnippetInput): Promise<Snippet>
  deleteSnippet(id: string): Promise<void>
  serverStats(sessionId: string): Promise<string | null>
  getMeta(): Promise<AppMeta>
  listConnections(): Promise<ConnectionPublic[]>
  saveConnection(input: ConnectionInput): Promise<ConnectionPublic>
  deleteConnection(id: string): Promise<void>
  setSecret(id: string, secret: { password?: string; passphrase?: string }): Promise<void>
  exportConnections(): Promise<ExportResult>
  importConnections(): Promise<ImportResult>
  selectPrivateKey(): Promise<string | null>
  /** plain skips the tmux attach (used for split panes). */
  connect(connectionId: string, plain?: boolean): Promise<string>
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
  sftpSearch(sessionId: string, searchId: string, dir: string, mode: SearchMode, pattern: string): Promise<SearchHit[]>
  sftpSearchCancel(searchId: string): Promise<void>
  sftpRetry(transferId: string): Promise<void>
  sftpCancel(transferId: string): Promise<void>
  sftpEditLocal(sessionId: string, path: string): Promise<string>
  sftpDownloadTo(sessionId: string, paths: string[], localDir: string): Promise<void>
  localHome(): Promise<string>
  localList(dir: string): Promise<{ path: string; parent: string; entries: LocalEntry[] }>
  onAutoUploaded(callback: (info: { sessionId: string; path: string; error?: string }) => void): () => void
  pathForFile(file: File): string
  onSftpProgress(callback: (progress: TransferProgress) => void): () => void
  onMenu(callback: (action: 'new' | 'import' | 'export') => void): () => void
}
