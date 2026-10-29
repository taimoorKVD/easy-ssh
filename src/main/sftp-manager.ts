import { randomUUID } from 'node:crypto'
import { createReadStream, createWriteStream, promises as fs, watch, type FSWatcher } from 'node:fs'
import { pipeline } from 'node:stream/promises'
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
const MAX_ACTIVE_TRANSFERS = 2
const MAX_WATCHES = 32
const FAST_OPTS = { concurrency: 32, chunkSize: 32 * 1024 }
// Parallel transfers can leave holes inside the last in-flight window, so resume re-sends that window.
const RESUME_BACKOFF = FAST_OPTS.concurrency * FAST_OPTS.chunkSize

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
  private active = 0
  private waiting: Array<() => void> = []
  /** Failed transfers that can be retried (resuming partial files). */
  private failed = new Map<string, { sessionId: string; retry: () => Promise<void> }>()
  private cancels = new Map<string, () => void>()
  private watches = new Map<string, { sessionId: string; watcher: FSWatcher; timer?: NodeJS.Timeout }>()

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
    for (const [key, w] of this.watches) {
      if (w.sessionId !== sessionId) continue
      clearTimeout(w.timer)
      w.watcher.close()
      this.watches.delete(key)
    }
    for (const [id, f] of this.failed) if (f.sessionId === sessionId) this.failed.delete(id)
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

  async download(sessionId: string, remotePaths: string[], localDir: string, label?: string, targetName?: string, resume = false): Promise<void> {
    const sftp = await this.sftp(sessionId)
    await this.transfer(sessionId, 'download', label ?? this.label('Downloading', remotePaths.map(baseNameRemote)), async (report) => {
      const plan = await this.planRemote(sftp, remotePaths, localDir, targetName)
      report.start(plan)
      for (const dir of plan.dirs) await fs.mkdir(dir, { recursive: true })
      await runLimited(plan.files, FILE_CONCURRENCY, async (file) => {
        report.check()
        const size = resume ? await fs.stat(file.to).then((st) => (st.isFile() ? st.size : -1), () => -1) : -1
        const have = size > 0 && size < file.size ? Math.max(0, size - RESUME_BACKOFF) : size
        if (have === file.size) {
          report.add(file.size)
        } else if (have > 0 && have < file.size) {
          report.add(have)
          await fs.truncate(file.to, have)
          await pipeline(sftp.createReadStream(file.from, { start: have }), report.meter(), createWriteStream(file.to, { flags: 'a' }))
        } else {
          await wrap<void>(file.from, (done) =>
            sftp.fastGet(file.from, file.to, { ...FAST_OPTS, step: (_t, chunk) => report.add(chunk) }, (err) => done(err))
          )
        }
        report.fileDone()
      })
    }, () => this.download(sessionId, remotePaths, localDir, label, targetName, true), sftp)
  }

  async upload(sessionId: string, localPaths: string[], remoteDir: string, resume = false): Promise<void> {
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
        report.check()
        const size = resume
          ? await wrap<Stats>(file.to, (cb) => sftp.stat(file.to, cb)).then((st) => (st.isFile() ? st.size : -1), () => -1)
          : -1
        const have = size > 0 && size < file.size ? Math.max(0, size - RESUME_BACKOFF) : size
        if (have === file.size) {
          report.add(file.size)
        } else if (have > 0 && have < file.size) {
          report.add(have)
          await pipeline(createReadStream(file.from, { start: have }), report.meter(), sftp.createWriteStream(file.to, { flags: 'r+', start: have }))
        } else {
          await wrap<void>(file.to, (done) =>
            sftp.fastPut(file.from, file.to, { ...FAST_OPTS, step: (_t, chunk) => report.add(chunk) }, (err) => done(err))
          )
        }
        report.fileDone()
      })
    }, () => this.upload(sessionId, localPaths, remoteDir, true), sftp)
  }

  retry(transferId: string): Promise<void> {
    const item = this.failed.get(transferId)
    if (!item) throw new Error('That transfer can no longer be retried.')
    this.failed.delete(transferId)
    return item.retry()
  }

  cancel(transferId: string): void {
    this.cancels.get(transferId)?.()
  }

  /**
   * Download a file to a private temp folder, open it in an editor, and upload it back whenever it is saved.
   * Watches end when the session closes.
   */
  async editLocal(sessionId: string, remote: string, open: (local: string) => Promise<void>, onSaved: (remote: string, error?: string) => void): Promise<void> {
    const key = `${sessionId}\0${remote}`
    const existing = this.watches.get(key)
    if (existing) {
      clearTimeout(existing.timer)
      existing.watcher.close()
      this.watches.delete(key)
    }
    if (this.watches.size >= MAX_WATCHES) throw new Error('Too many files are open for editing. Close some sessions first.')
    const local = await this.downloadToTemp(sessionId, remote)
    let last = (await fs.stat(local)).mtimeMs
    const entry: { sessionId: string; watcher: FSWatcher; timer?: NodeJS.Timeout } = {
      sessionId,
      watcher: watch(local, () => {
        clearTimeout(entry.timer)
        entry.timer = setTimeout(() => {
          void (async () => {
            const st = await fs.stat(local).catch(() => null)
            if (!st || st.mtimeMs === last) return
            last = st.mtimeMs
            try {
              const sftp = await this.sftp(sessionId)
              await wrap<void>(remote, (done) => sftp.fastPut(local, remote, FAST_OPTS, (err) => done(err)))
              onSaved(remote)
            } catch (error) {
              onSaved(remote, friendlySftpError(error, remote))
            }
          })()
        }, 400)
      })
    }
    this.watches.set(key, entry)
    await open(local)
  }

  private label(verb: string, names: string[]): string {
    if (names.length === 1) return `${verb} ${names[0]}`
    return `${verb} ${names.length} items`
  }

  private async transfer(
    sessionId: string,
    kind: 'upload' | 'download',
    label: string,
    run: (report: { start(plan: Plan): void; meter(): Transform; add(bytes: number): void; fileDone(): void; check(): void }) => Promise<void>,
    retry?: () => Promise<void>,
    channel?: SFTPWrapper
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
      state: this.active >= MAX_ACTIVE_TRANSFERS ? 'queued' : 'running'
    }
    let canceled = false
    this.cancels.set(state.transferId, () => {
      canceled = true
    })
    let last = 0
    const emit = (force = false): void => {
      const now = Date.now()
      if (!force && now - last < 120) return
      last = now
      this.progress({ ...state })
    }
    emit(true)
    if (this.active >= MAX_ACTIVE_TRANSFERS) await new Promise<void>((resolve) => this.waiting.push(resolve))
    this.active += 1
    state.state = 'running'
    try {
      if (canceled) throw new Error('Canceled.')
      // ssh2 does not always fail in-flight fastGet/fastPut when the connection drops, so race the channel close.
      let onClose: (() => void) | undefined
      const lost = new Promise<never>((_, reject) => {
        onClose = () => reject(new Error('The connection was lost. Reconnect, then retry to resume.'))
        channel?.once('close', onClose)
      })
      lost.catch(() => undefined)
      await Promise.race([lost, run({
        check: () => {
          if (canceled) throw new Error('Canceled.')
        },
        start: (plan) => {
          state.filesTotal = plan.files.length
          state.bytesTotal = plan.files.reduce((sum, file) => sum + file.size, 0)
          emit(true)
        },
        meter: () =>
          new Transform({
            transform(chunk: Buffer, _enc, callback) {
              if (canceled) return callback(new Error('Canceled.'))
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
      })]).finally(() => {
        if (onClose) channel?.removeListener('close', onClose)
      })
      state.state = 'done'
      emit(true)
    } catch (error) {
      state.state = canceled ? 'canceled' : 'error'
      state.error = canceled ? 'Canceled. Retry resumes where it stopped.' : friendlySftpError(error)
      if (retry) {
        state.retryable = true
        this.failed.set(state.transferId, { sessionId, retry })
        if (this.failed.size > 50) this.failed.delete(this.failed.keys().next().value as string)
      }
      emit(true)
      throw new Error(state.error)
    } finally {
      this.active -= 1
      this.cancels.delete(state.transferId)
      this.waiting.shift()?.()
    }
  }
}
