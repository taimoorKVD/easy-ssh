import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildSearchCommand, parseSearchOutput, shQuote, validateSearch } from '../src/shared/remote-search.ts'

test('quotes hostile input', () => {
  assert.equal(shQuote("a'b"), `'a'\\''b'`)
  const cmd = buildSearchCommand("/srv/it's", 'content', "$(rm -rf /)'; echo")
  assert.ok(cmd.includes(`-e '$(rm -rf /)'\\''; echo'`))
  assert.ok(cmd.includes(`-- '/srv/it'\\''s'`))
  assert.ok(buildSearchCommand('/x', 'name', '*.log').includes(`-iname '*\\*.log*'`))
})

test('validation', () => {
  assert.throws(() => validateSearch('rel', 'name', 'x'))
  assert.throws(() => validateSearch('/a', 'exec', 'x'))
  assert.throws(() => validateSearch('/a', 'name', 'x\ny'))
  assert.deepEqual(validateSearch('/a', 'name', 'x'), { dir: '/a', mode: 'name', pattern: 'x' })
})

test('parses grep output', () => {
  const hits = parseSearchOutput('content', '/a/b.txt:12:hello: world\nnoise\n')
  assert.deepEqual(hits, [{ path: '/a/b.txt', line: 12, text: 'hello: world' }])
})
