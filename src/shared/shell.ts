/** Quote a string for a POSIX shell single-quoted context. */
export function shSingleQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

export const TMUX_NAME_RE = /^[A-Za-z0-9_.-]{1,40}$/

/** Attach to (or create) a named tmux session, falling back to the plain shell when tmux is missing. */
export function tmuxCommand(name: string | undefined): string | null {
  if (!name || !TMUX_NAME_RE.test(name)) return null
  return `command -v tmux >/dev/null 2>&1 && tmux new-session -A -s ${shSingleQuote(name)} || echo "easy-ssh: tmux is not installed on this server"`
}

/**
 * Commands written to an already-open interactive shell.
 * The directory is quoted. Startup lines are sent as the user wrote them.
 */
export function buildStartupScript(directory: string | undefined, commands: readonly string[], tmux?: string): string {
  const lines: string[] = []
  const dir = directory?.trim()
  if (dir) lines.push(`cd ${shSingleQuote(dir)}`)
  for (const command of commands) {
    const line = command.trim()
    if (line) lines.push(line)
  }
  const attach = tmuxCommand(tmux)
  if (attach) lines.push(attach)
  if (lines.length === 0) return ''
  // PTY input treats CR as Enter, the same byte xterm sends for the Return key.
  return `${lines.join('\r')}\r`
}

/**
 * Remote command for `ssh -t`, ending in an interactive login shell.
 * Returns null when there is nothing to run beyond a normal login.
 */
export function buildRemoteShellCommand(
  directory: string | undefined,
  commands: readonly string[],
  tmux?: string
): string | null {
  const lines: string[] = []
  const dir = directory?.trim()
  if (dir) lines.push(`cd ${shSingleQuote(dir)}`)
  for (const command of commands) {
    const line = command.trim()
    if (line) lines.push(line)
  }
  const attach = tmuxCommand(tmux)
  if (attach) lines.push(attach)
  if (lines.length === 0) return null
  lines.push('exec "$SHELL" -l || exec /bin/bash -l || exec /bin/sh')
  return lines.join('\n')
}

export function sshArgv(input: {
  port: number
  username: string
  host: string
  defaultDirectory?: string
  startupCommands: readonly string[]
  tmuxSession?: string
}): string[] {
  const args = ['ssh', '-p', String(input.port), '-t', `${input.username}@${input.host}`]
  const remote = buildRemoteShellCommand(input.defaultDirectory, input.startupCommands, input.tmuxSession)
  if (remote) args.push(remote)
  return args
}

export function formatLocalCommand(args: readonly string[]): string {
  return args.map((arg) => shSingleQuote(arg)).join(' ')
}

export function splitStartupCommands(value: string | readonly string[] | undefined): string[] {
  if (!value) return []
  const source = typeof value === 'string' ? value.split(/\r?\n/) : [...value]
  return source.map((line) => line.trim()).filter((line) => line.length > 0).slice(0, 30)
}
