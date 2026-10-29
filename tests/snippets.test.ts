import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fillPlaceholders, fuzzyScore, parsePlaceholders, toTerminalInput, validateSnippet } from '../src/shared/snippets.ts'

test('parses unique placeholders', () => {
  assert.deepEqual(parsePlaceholders('systemctl restart {{service}} && journalctl -u {{ service }} -n {{lines:raw}}'), [
    { name: 'service', raw: false },
    { name: 'lines', raw: true }
  ])
})

test('quotes values so they cannot inject commands', () => {
  const out = fillPlaceholders('systemctl restart {{service}}', { service: "nginx; rm -rf / #'" })
  assert.equal(out, `systemctl restart 'nginx; rm -rf / #'\\'''`)
  assert.equal(fillPlaceholders('tail -n {{n:raw}} x', { n: '50' }), 'tail -n 50 x')
  assert.equal(fillPlaceholders('echo {{a}}', { a: 'x\ny' }), "echo 'x y'")
})

test('terminal input uses CR per line', () => {
  assert.equal(toTerminalInput('ls\n\npwd\n'), 'ls\rpwd\r')
})

test('validates snippet input', () => {
  assert.throws(() => validateSnippet({ name: '', command: 'ls' }))
  assert.throws(() => validateSnippet(null))
  const v = validateSnippet({ name: ' a ', command: 'ls', connectionId: 'not-an-id!' })
  assert.equal(v.connectionId, null)
  assert.equal(v.name, 'a')
})

test('fuzzy scoring', () => {
  assert.ok(fuzzyScore('rst', 'restart nginx') > 0)
  assert.equal(fuzzyScore('zzz', 'restart'), -1)
  assert.ok(fuzzyScore('nginx', 'restart nginx') > fuzzyScore('rn', 'restart nginx'))
})
