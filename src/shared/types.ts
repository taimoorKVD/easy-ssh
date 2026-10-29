import type { ForwardRule } from './forwards'
export type AuthType = 'password' | 'privateKey'

export interface ConnectionInput {
  id?: string
  name: string
  host: string
  port: number
  username: string
  authType: AuthType
  privateKeyPath?: string
  password?: string
  passphrase?: string
  clearPassword?: boolean
  clearPassphrase?: boolean
  defaultDirectory?: string
  startupCommands?: string | string[]
  group?: string
  forwards?: unknown
}

export interface ConnectionPublic {
  id: string
  name: string
  host: string
  port: number
  username: string
  authType: AuthType
  privateKeyPath: string
  hasPassword: boolean
  hasPassphrase: boolean
  defaultDirectory: string
  startupCommands: string[]
  group: string
  forwards: ForwardRule[]
  createdAt: string
  updatedAt: string
}

export interface ExportBundle {
  kind: 'easy-ssh-connections'
  version: 1
  exportedAt: string
  connections: Array<{
    id: string
    name: string
    host: string
    port: number
    username: string
    authType: AuthType
    privateKeyPath?: string
    defaultDirectory?: string
    startupCommands?: string[]
    group?: string
  }>
}

export type SessionPhase = 'connecting' | 'connected' | 'disconnected' | 'error'

export type SessionErrorCode = 'auth' | 'hostkey' | 'network' | 'timeout' | 'key' | 'unknown'

export interface SessionStatus {
  sessionId: string
  phase: SessionPhase
  message?: string
  code?: SessionErrorCode
}

export interface HostKeyPrompt {
  sessionId: string
  host: string
  port: number
  fingerprint: string
  changed: boolean
  previousFingerprint?: string
}

export interface AppMeta {
  version: string
  encryptionAvailable: boolean
  encryptionBackend: string
  encryptionReason?: string
  dataDir: string
  platform: string
}

export interface ImportResult {
  canceled: boolean
  imported: number
  skipped: number
}

export interface ExportResult {
  canceled: boolean
  path?: string
  count: number
}

export interface TerminalLaunchResult {
  ok: boolean
  command?: string
  error?: string
}
