import { test } from 'node:test'
import assert from 'node:assert/strict'
import { authorizedKeysCommand, isValidPublicKeyLine, sanitizeKeyName } from '../src/shared/keys.ts'

const key = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIBkz1x9 taimoor@pc'
test('public key validation', () => {
  assert.ok(isValidPublicKeyLine(key))
  assert.ok(!isValidPublicKeyLine(`${key}; rm -rf ~`))
  assert.ok(!isValidPublicKeyLine("ssh-ed25519 AAAA' x"))
  assert.ok(!isValidPublicKeyLine(`${key}\nssh-rsa AAAA`))
})
test('append-only command', () => {
  const cmd = authorizedKeysCommand(key)
  assert.match(cmd, />> ~\/.ssh\/authorized_keys/)
  assert.doesNotMatch(cmd, /[^>]> ~\/.ssh\/authorized_keys/)
  assert.match(cmd, /grep -qxF 'ssh-ed25519/)
  assert.throws(() => authorizedKeysCommand('bad'))
})
test('names', () => {
  assert.equal(sanitizeKeyName('my key; $(x)'), 'my-key-x')
  assert.equal(sanitizeKeyName(''), 'easy-ssh-key')
})
