import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseSshConfig } from '../src/shared/ssh-config.ts'

const sample = `
# comment
Host *
  User everyone
Host web prod-web
  HostName 10.0.0.5
  User deploy
  Port 2222
  IdentityFile ~/.ssh/id_ed25519
  IdentityFile ~/.ssh/other
Host db
  HostName=db.internal
  ProxyJump web
Host *.corp !bad
  User x
Match host foo
  User nope
Host evil
  HostName "$(rm -rf /)"
`

test('parses hosts, skips wildcards and match blocks', () => {
  const e = parseSshConfig(sample, '/home/me')
  assert.deepEqual(e.map((x) => x.name), ['web', 'prod-web', 'db'])
  assert.equal(e[0].host, '10.0.0.5')
  assert.equal(e[0].port, 2222)
  assert.equal(e[0].username, 'deploy')
  assert.equal(e[0].authType, 'privateKey')
  assert.equal(e[0].privateKeyPath, '/home/me/.ssh/id_ed25519')
  assert.equal(e[2].host, 'db.internal')
  assert.equal(e[2].proxyJump, 'web')
  assert.equal(e[2].authType, 'password')
  assert.equal(e[2].username, '')
})
