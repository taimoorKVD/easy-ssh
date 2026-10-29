import { spawn, spawnSync } from 'node:child_process'
import { formatLocalCommand, sshArgv } from '../shared/shell'
import type { TerminalLaunchResult } from '../shared/types'

interface LaunchTarget {
  port: number
  username: string
  host: string
  defaultDirectory: string
  startupCommands: string[]
  tmuxSession?: string
}

function commandExists(name: string): boolean {
  const checker = process.platform === 'win32' ? 'where.exe' : 'which'
  const result = spawnSync(checker, [name], { stdio: 'ignore' })
  return result.status === 0
}

function quoteCmd(arg: string): string {
  if (arg.length === 0) return '""'
  if (!/[\s"&|<>^%]/.test(arg)) return arg
  return `"${arg.replace(/"/g, '""')}"`
}

function appleString(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

/**
 * Opens the OS terminal with ssh. The saved password is not injected:
 * the system ssh client prompts, or uses the user's agent and keys.
 */
export function openSystemTerminal(target: LaunchTarget): TerminalLaunchResult {
  const args = sshArgv({
    port: target.port,
    username: target.username,
    host: target.host,
    defaultDirectory: target.defaultDirectory,
    startupCommands: target.startupCommands,
    tmuxSession: target.tmuxSession
  })
  const cmdline = formatLocalCommand(args)

  try {
    if (process.platform === 'win32') return openWindows(args)
    if (process.platform === 'darwin') return openMac(cmdline)
    return openLinux(cmdline)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Could not open a system terminal.'
    return { ok: false, error: message }
  }
}

function openWindows(args: string[]): TerminalLaunchResult {
  if (commandExists('wt.exe') || commandExists('wt')) {
    const child = spawn('wt.exe', args, { detached: true, stdio: 'ignore' })
    child.unref()
    return { ok: true, command: ['wt', ...args].join(' ') }
  }
  const line = args.map(quoteCmd).join(' ')
  const child = spawn('cmd.exe', ['/c', 'start', 'easy-ssh', 'cmd.exe', '/k', line], {
    detached: true,
    stdio: 'ignore'
  })
  child.on('error', () => undefined)
  child.unref()
  return { ok: true, command: line }
}

function openMac(cmdline: string): TerminalLaunchResult {
  const script = ['tell application "Terminal"', 'activate', `do script ${appleString(cmdline)}`, 'end tell'].join('\n')
  const child = spawn('osascript', ['-e', script], { detached: true, stdio: 'ignore' })
  child.unref()
  return { ok: true, command: cmdline }
}

function openLinux(cmdline: string): TerminalLaunchResult {
  const candidates: Array<{ bin: string; args: string[] }> = [
    { bin: 'x-terminal-emulator', args: ['-e', 'bash', '-lc', cmdline] },
    { bin: 'gnome-terminal', args: ['--', 'bash', '-lc', cmdline] },
    { bin: 'konsole', args: ['-e', 'bash', '-lc', cmdline] },
    { bin: 'xfce4-terminal', args: ['--command', `bash -lc ${quoteCmd(cmdline)}`] },
    { bin: 'mate-terminal', args: ['--', 'bash', '-lc', cmdline] },
    { bin: 'alacritty', args: ['-e', 'bash', '-lc', cmdline] },
    { bin: 'kitty', args: ['bash', '-lc', cmdline] },
    { bin: 'xterm', args: ['-e', 'bash', '-lc', cmdline] }
  ]
  const found = candidates.find((candidate) => commandExists(candidate.bin))
  if (!found) {
    return {
      ok: false,
      error: 'No system terminal found. Install gnome-terminal, xterm, or another terminal emulator.'
    }
  }
  const child = spawn(found.bin, found.args, { detached: true, stdio: 'ignore' })
  child.on('error', () => undefined)
  child.unref()
  return { ok: true, command: cmdline }
}
