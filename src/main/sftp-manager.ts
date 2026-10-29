import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { Transform } from 'node:stream'
import type { Client, FileEntryWithStats, SFTPWrapper, Stats } from 'ssh2'
import {
  TEXT_EDIT_LIMIT,
  baseNameRemote,
  friendlySftpError,
  joinRemote,
  kindFromMode,
  normalizeRemote,
  type RemoteEntry,
  type TransferProgress
} from '../shared/remote-fs'
import type { SessionManager } from './ssh-manager'
import { runLimited } from '../shared/batcher'
import { assertInside, safeLocalName } from './security'

const MAX_TREE_FILES = 50_000
const MAX_TREE_DEPTH = 64

const FILE_CONCURRENCY = 4
const FAST_OPTS = { concurrency: 32, chunkSize: 32 * 1024 }

type ProgressSink = (progress: TransferProgress) => void

function wrap<T>(path: string | undefined, run: (done: (error: Error | null | undefined, value?: T) => void) => void): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    try {
      run((error, value) => {
        if (error) reject(new Error(friendlySftpError(error, path)))
        else resolve(value as T)
      })
    } catch (error) {
      reject(new Error(friendlySftpError(error, path)))
    }
  })
}


interface Plan {
  dirs: string[]
  files: Array<{ from: string; to: string; size: number }>
}

export class SftpManager {
  private channels = new Map<string, { client: Client; sftp: Promise<SFTPWrapper> }>()

  constructor(
    private readonly sessions: SessionManager,
    private readonly progress: ProgressSink
  ) {}

  private async sftp(sessionId: string): Promise<SFTPWrapper> {
    const client = this.sessions.client(sessionId)
    if (!client) {
      this.channels.delete(sessionId)
      throw new Error('This session is not connected. Reconnect it to browse files.')
    }
    const cached = this.channels.get(sessionId)
    if (cached && cached.client === client) return cached.sftp
    const sftp = new Promise<SFTPWrapper>((resolve, reject) => {
      client.sftp((error, wrapper) => {
        if (error || !wrapper) {
          this.channels.delete(sessionId)
          reject(new Error(friendlySftpError(error ?? new Error('subsystem unavailable'))))
          return
        }
        wrapper.on('close', () => {
          if (this.channels.get(sessionId)?.client === client) this.channels.delete(sessionId)
        })
        resolve(wrapper)
      })
    })
    this.channels.set(sessionId, { client, sftp })
    return sftp
  }

  release(sessionId: string): void {
    const cached = this.channels.get(sessionId)
    this.channels.delete(sessionId)
    void cached?.sftp.then((wrapper) => wrapper.end()).catch(() => undefined)
  }

  async home(sessionId: string): Promise<string> {
    const sftp = await this.sftp(sessionId)
    return wrap<string>('.', (done) => sftp.realpath('.', done))
  }

  async realpath(sessionId: string, path: string): Promise<string> {
    const sftp = await this.sftp(sessionId)
    return wrap<string>(path, (done) => sftp.realpath(path, done))
  }

  async list(sessionId: string, dir: string): Promise<{ path: string; entries: RemoteEntry[] }> {
    const sftp = await this.sftp(sessionId)
    const path = await wrap<string>(dir, (done) => sftp.realpath(dir, done))
    const raw = await wrap<FileEntryWithStats[]>(path, (done) => sftp.readdir(path, done))
    const entries = await Promise.all(
      raw
        .filter((item) => item.filename !== '.' && item.filename !== '..')
        .map(async (item): Promise<RemoteEntry> => {
          const full = joinRemote(path, item.filename)
          const mode = item.attrs.mode ?? 0
          const kind = kindFromMode(mode)
          let linkToDir: boolean | undefined
          if (kind === 'link') {
            try {
              const target = await wrap<Stats>(full, (done) => sftp.stat(full, done))
              linkToDir = target.isDirectory()
            } catch {
              linkToDir = false
            }
          }
          return {
            name: item.filename,
            path: full,
            kind,
            linkToDir,
            size: item.attrs.size ?? 0,
            mtime: (item.attrs.mtime ?? 0) * 1000,
            mode
          }
        })
    )
    return { path, entries }
  }

  async mkdir(sessionId: string, path: string): Promise<void> {
    const sftp = await this.sftp(sessionId)
    await wrap<void>(path, (done) => sftp.mkdir(path, done))
  }

  async createFile(sessionId: string, path: string): Promise<void> {
    const sftp = await this.sftp(sessionId)
    const exists = await wrap<Stats>(path, (done) => sftp.lstat(path, done)).then(
      () => true,
      () => false
    )
    if (exists) throw new Error(`Something with that name already exists (${path}).`)
    const handle = await wrap<Buffer>(path, (done) => sftp.open(path, 'wx', done))
    await wrap<void>(path, (done) => sftp.close(handle, done))
  }

  async rename(sessionId: string, from: string, to: string): Promise<void> {
    const sftp = await this.sftp(sessionId)
    await wrap<void>(from, (done) => sftp.rename(from, to, done))
  }

  async chmod(sessionId: string, path: string, mode: number): Promise<void> {
    const sftp = await this.sftp(sessionId)
    await wrap<void>(path, (done) => sftp.chmod(path, mode, done))
  }

  async remove(sessionId: string, paths: string[]): Promise<void> {
    const sftp = await this.sftp(sessionId)
    for (const path of paths) await this.removeOne(sftp, path)
  }

  private async removeOne(sftp: SFTPWrapper, path: string): Promise<void> {
    if (normalizeRemote(path) === '/') throw new Error('Refusing to delete the root folder.')
    const stats = await wrap<Stats>(path, (done) => sftp.lstat(path, done))
    if (stats.isDirectory()) {
      const items = await wrap<FileEntryWithStats[]>(path, (done) => sftp.readdir(path, done))
      for (const item of items) {
        if (item.filename === '.' || item.filename === '..') continue
        await this.removeOne(sftp, joinRemote(path, item.filename))
      }
      await wrap<void>(path, (done) => sftp.rmdir(path, done))
    } else {
      await wrap<void>(path, (done) => sftp.unlink(path, done))
    }
  }

  async readText(sessionId: string, path: string): Promise<{ content: string; size: number }> {
    const sftp = await this.sftp(sessionId)
    const stats = await wrap<Stats>(path, (done) => sftp.stat(path, done))
    if (stats.size > TEXT_EDIT_LIMIT) throw new Error('That file is larger than 2 MB. Download it instead.')
    const buffer = await wrap<Buffer>(path, (done) => sftp.readFile(path, done))
    if (buffer.subarray(0, 8000).includes(0)) throw new Error('That looks like a binary file. Open it with an app instead.')
    return { content: buffer.toString('utf8'), size: stats.size }
  }

  async writeText(sessionId: string, path: string, content: string): Promise<void> {
    const sftp = await this.sftp(sessionId)
    await wrap<void>(path, (done) => sftp.writeFile(path, Buffer.from(content, 'utf8'), done))
  }

  /** Download one file to a private temp folder and return the local path. */
  async downloadToTemp(sessionId: string, path: string): Promise<string> {
    const dir = await fs.mkdtemp(join(tmpdir(), 'easy-ssh-'))
    const local = join(dir, safeLocalName(baseNameRemote(path)))
    await this.download(sessionId, [path], dir, `Opening ${baseNameRemote(path)}`)
    return local
  }

  private async planRemote(sftp: SFTPWrapper, remotePaths: string[], localDir: string, targetName?: string): Promise<Plan> {
    const plan: Plan = { dirs: [], files: [] }
    const walk = async (remote: string, local: string, depth = 0, top = true): Promise<void> => {
      assertInside(localDir, local)
      if (depth > MAX_TREE_DEPTH) throw new Error('That folder is nested too deeply to download.')
      if (plan.files.length + plan.dirs.length > MAX_TREE_FILES) throw new Error('That selection has too many files to download at once.')
      // Follow a symlink only for the item the user picked; inside folders, links are skipped to avoid loops.
      const stats = await wrap<Stats>(remote, (done) => (top ? sftp.stat(remote, done) : sftp.lstat(remote, done)))
      if (stats.isSymbolicLink()) return
      if (stats.isDirectory()) {
        plan.dirs.push(local)
        const items = await wrap<FileEntryWithStats[]>(remote, (done) => sftp.readdir(remote, done))
        await runLimited(
          items.filter((item) => item.filename !== '.' && item.filename !== '..'),
          8,
          (item) => walk(joinRemote(remote, item.filename), join(local, safeLocalName(item.filename)), depth + 1, false)
        )
      } else if (stats.isFile()) {
        plan.files.push({ from: remote, to: local, size: stats.size })
      }
    }
    for (const remote of remotePaths) {
      await walk(remote, join(localDir, safeLocalName(targetName && remotePaths.length === 1 ? targetName : baseNameRemote(remote))))
    }
    return plan
  }

  private async planLocal(localPaths: string[], remoteDir: string): Promise<Plan> {
    const plan: Plan = { dirs: [], files: [] }
    const walk = async (local: string, remote: string): Promise<void> => {
      const stats = await fs.stat(local)
      if (stats.isDirectory()) {
        plan.dirs.push(remote)
        for (const name of await fs.readdir(local)) await walk(join(local, name), joinRemote(remote, name))
      } else if (stats.isFile()) {
        plan.files.push({ from: local, to: remote, size: stats.size })
      }
    }
    for (const local of localPaths) await walk(local, joinRemote(remoteDir, basename(local)))
    return plan
  }

  async download(sessionId: string, remotePaths: string[], localDir: string, label?: string, targetName?: string): Promise<void> {
    const sftp = await this.sftp(sessionId)
    await this.transfer(sessionId, 'download', label ?? this.label('Downloading', remotePaths.map(baseNameRemote)), async (report) => {
      const plan = await this.planRemote(sftp, remotePaths, localDir, targetName)
      report.start(plan)
      for (const dir of plan.dirs) await fs.mkdir(dir, { recursive: true })
      await runLimited(plan.files, FILE_CONCURRENCY, async (file) => {
        await wrap<void>(file.from, (done) =>
          sftp.fastGet(file.from, file.to, { ...FAST_OPTS, step: (_t, chunk) => report.add(chunk) }, (err) => done(err))
        )
        report.fileDone()
      })
    })
  }

  async upload(sessionId: string, localPaths: string[], remoteDir: string): Promise<void> {
    const sftp = await this.sftp(sessionId)
    await this.transfer(sessionId, 'upload', this.label('Uploading', localPaths.map((path) => basename(path))), async (report) => {
      const plan = await this.planLocal(localPaths, remoteDir)
      report.start(plan)
      for (const dir of plan.dirs) {
        await wrap<void>(dir, (done) => sftp.mkdir(dir, done)).catch(async (error: Error) => {
          const exists = await wrap<Stats>(dir, (cb) => sftp.stat(dir, cb)).then((s) => s.isDirectory(), () => false)
          if (!exists) throw error
        })
      }
      await runLimited(plan.files, FILE_CONCURRENCY, async (file) => {
        await wrap<void>(file.to, (done) =>
          sftp.fastPut(file.from, file.to, { ...FAST_OPTS, step: (_t, chunk) => report.add(chunk) }, (err) => done(err))
        )
        report.fileDone()
      })
    })
  }

  private label(verb: string, names: string[]): string {
    if (names.length === 1) return `${verb} ${names[0]}`
    return `${verb} ${names.length} items`
  }

  private async transfer(
    sessionId: string,
    kind: 'upload' | 'download',
    label: string,
    run: (report: { start(plan: Plan): void; meter(): Transform; add(bytes: number): void; fileDone(): void }) => Promise<void>
  ): Promise<void> {
    const state: TransferProgress = {
      sessionId,
      transferId: randomUUID(),
      kind,
      label,
      bytesDone: 0,
      bytesTotal: 0,
      filesDone: 0,
      filesTotal: 0,
      state: 'running'
    }
    let last = 0
    const emit = (force = false): void => {
      const now = Date.now()
      if (!force && now - last < 120) return
      last = now
      this.progress({ ...state })
    }
    emit(true)
    try {
      await run({
        start: (plan) => {
          state.filesTotal = plan.files.length
          state.bytesTotal = plan.files.reduce((sum, file) => sum + file.size, 0)
          emit(true)
        },
        meter: () =>
          new Transform({
            transform(chunk: Buffer, _enc, callback) {
              state.bytesDone += chunk.length
              emit()
              callback(null, chunk)
            }
          }),
        add: (bytes) => {
          state.bytesDone += bytes
          emit()
        },
        fileDone: () => {
          state.filesDone += 1
          emit()
        }
      })
      state.state = 'done'
      emit(true)
    } catch (error) {
      state.state = 'error'
      state.error = friendlySftpError(error)
      emit(true)
      throw new Error(state.error)
    }
  }
}
