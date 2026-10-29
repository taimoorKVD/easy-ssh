import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  buildRemoteShellCommand,
  buildStartupScript,
  formatLocalCommand,
  shSingleQuote,
  splitStartupCommands,
  sshArgv,
  tmuxCommand
} from '../src/shared/shell.ts'

describe('shell helpers', () => {
  it('single-quotes POSIX values', () => {
    assert.equal(shSingleQuote(`/home/app`), `'/home/app'`)
    assert.equal(shSingleQuote(`it's`), `'it'\\''s'`)
  })

  it('builds an interactive startup script', () => {
    assert.equal(buildStartupScript('  ', ['  ']), '')
    assert.equal(
      buildStartupScript(`/home/me/it's`, ['echo hi', '  ', 'pwd']),
      `cd '/home/me/it'\\''s'\recho hi\rpwd\r`
    )
  })

  it('builds a remote command that stays in a login shell', () => {
    const remote = buildRemoteShellCommand('/var/www', ['php artisan up'])
    assert.ok(remote)
    assert.match(remote!, /^cd '\/var\/www'\nphp artisan up\nexec "\$SHELL"/)
    assert.equal(buildRemoteShellCommand('', []), null)
  })

  it('puts the remote script in the ssh argument vector', () => {
    const args = sshArgv({
      port: 65002,
      username: 'user',
      host: '203.0.113.10',
      defaultDirectory: 'domains/app',
      startupCommands: ['echo ready']
    })
    assert.deepEqual(args.slice(0, 5), ['ssh', '-p', '65002', '-t', 'user@203.0.113.10'])
    assert.match(args[5], /cd 'domains\/app'/)
    assert.match(args[5], /echo ready/)
    const plain = sshArgv({
      port: 22,
      username: 'root',
      host: 'localhost',
      startupCommands: []
    })
    assert.equal(plain.length, 5)
    assert.match(formatLocalCommand(plain), /^'ssh' '-p' '22'/)
  })

  it('splits startup command lines', () => {
    assert.deepEqual(splitStartupCommands(' echo a \n\n pwd '), ['echo a', 'pwd'])
  })
})

it('tmux attach line is validated and quoted', () => {
  assert.equal(tmuxCommand("x'; rm -rf /"), null)
  assert.equal(tmuxCommand(''), null)
  assert.ok(tmuxCommand('main.1')!.includes("tmux new-session -A -s 'main.1'"))
  assert.ok(buildStartupScript('', [], 'dev').endsWith("tmux is not installed on this server\"\r"))
})
