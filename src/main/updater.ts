import { app } from 'electron'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { handle } from './ipc'
import { initialUpdateState, reduceUpdate, VERSION_RE, type UpdateEvent, type UpdateState } from '../shared/update-state'

const FIRST_CHECK_MS = 10_000
const INTERVAL_MS = 6 * 60 * 60 * 1000

type AutoUpdater = import('electron-updater').AppUpdater

/**
 * In-app updates from GitHub Releases (HTTPS only). electron-updater verifies the sha512 in latest.yml.
 * Loaded lazily after the window is shown so startup stays fast.
 */
export function startUpdater(send: (channel: string, payload: unknown) => void): { check: (manual: boolean) => void } {
  const snoozeFile = join(app.getPath('userData'), 'update.json')
  let snoozed: string | undefined
  try {
    if (existsSync(snoozeFile)) {
      const v = (JSON.parse(readFileSync(snoozeFile, 'utf8')) as { snoozed?: unknown }).snoozed
      if (typeof v === 'string' && VERSION_RE.test(v)) snoozed = v
    }
  } catch {
    // Ignore a damaged file.
  }

  let state: UpdateState = initialUpdateState(app.getVersion())
  const apply = (event: UpdateEvent): void => {
    state = reduceUpdate(state, event, snoozed)
    send('update:state', state)
  }

  let updater: AutoUpdater | null = null
  let loading: Promise<AutoUpdater | null> | null = null
  const load = (): Promise<AutoUpdater | null> => {
    if (updater) return Promise.resolve(updater)
    if (loading) return loading
    loading = import('electron-updater')
      .then((mod) => {
        // electron-updater is CommonJS: take it from the default export.
        const u = ((mod as unknown as { default?: { autoUpdater: AutoUpdater } }).default ?? (mod as unknown as { autoUpdater: AutoUpdater })).autoUpdater
        u.autoDownload = true
        u.autoInstallOnAppQuit = true
        u.allowDowngrade = false
        u.allowPrerelease = false
        u.fullChangelog = false
        u.logger = null
        u.on('update-available', (info) => apply({ type: 'available', version: info.version, notes: info.releaseNotes as unknown as string }))
        u.on('update-not-available', () => apply({ type: 'none' }))
        u.on('download-progress', (p) => apply({ type: 'progress', percent: p.percent }))
        u.on('update-downloaded', (info) => apply({ type: 'downloaded', version: info.version }))
        u.on('error', (err) => apply({ type: 'error', message: String(err?.message ?? err) }))
        updater = u
        return u
      })
      .catch(() => null)
    return loading
  }

  let busy = false
  const check = (manual: boolean): void => {
    // Updates only work in the installed (packaged) app.
    if (!app.isPackaged) {
      if (manual) apply({ type: 'check', manual }), apply({ type: 'error', message: 'Updates are only available in the installed app.' })
      return
    }
    if (busy && !manual) return
    apply({ type: 'check', manual })
    if (state.phase === 'downloading' || state.phase === 'ready') return
    busy = true
    void load().then(async (u) => {
      try {
        if (!u) throw new Error('Updater failed to load.')
        await u.checkForUpdates()
      } catch (err) {
        apply({ type: 'error', message: String((err as Error)?.message ?? err) })
      } finally {
        busy = false
      }
    })
  }

  handle('update:check', () => check(true))
  handle('update:state', () => state)
  handle('update:install', () => {
    if (state.phase !== 'ready' || !updater) throw new Error('No update is ready to install.')
    setImmediate(() => updater?.quitAndInstall(false, true))
  })
  handle('update:later', (_e, version: unknown) => {
    if (typeof version === 'string' && VERSION_RE.test(version)) {
      snoozed = version
      try {
        writeFileSync(snoozeFile, JSON.stringify({ snoozed: version }), 'utf8')
      } catch {
        // Not fatal.
      }
    }
    // A downloaded update still installs when the app quits.
    apply({ type: 'dismiss' })
  })

  if (app.isPackaged && process.env.EASY_SSH_NO_UPDATE !== '1') {
    setTimeout(() => check(false), FIRST_CHECK_MS).unref?.()
    setInterval(() => check(false), INTERVAL_MS).unref?.()
  }
  return { check }
}
