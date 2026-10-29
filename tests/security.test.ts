import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { assertInside, isExecutableName, isInside, isSafeExternalUrl, safeLocalName } from '../src/main/security.ts'

test('safeLocalName blocks traversal and reserved names', () => {
  assert.equal(safeLocalName('..'), 'file')
  assert.equal(safeLocalName('.'), 'file')
  assert.equal(safeLocalName('../../etc/passwd'), '.._.._etc_passwd')
  assert.equal(safeLocalName('a\\b'), 'a_b')
  assert.equal(safeLocalName('CON'), '_CON')
  assert.equal(safeLocalName('nul.txt'), '_nul.txt')
  assert.equal(safeLocalName('ok.txt'), 'ok.txt')
})

test('isInside guards the download root', () => {
  const root = join('/tmp', 'dl')
  assert.ok(isInside(root, join(root, 'a', 'b')))
  assert.ok(!isInside(root, join(root, '..', 'evil')))
  assert.ok(!isInside(root, '/etc/passwd'))
  assert.throws(() => assertInside(root, join(root, '..', 'x')))
})

test('executables are flagged', () => {
  assert.ok(isExecutableName('setup.EXE'))
  assert.ok(isExecutableName('run.ps1'))
  assert.ok(!isExecutableName('notes.txt'))
  assert.ok(!isExecutableName('Makefile'))
})

test('only plain http(s) urls are external-safe', () => {
  assert.ok(isSafeExternalUrl('https://example.com/x'))
  assert.ok(!isSafeExternalUrl('file:///C:/Windows/system32/calc.exe'))
  assert.ok(!isSafeExternalUrl('javascript:alert(1)'))
  assert.ok(!isSafeExternalUrl('https://user:pw@evil.com'))
  assert.ok(!isSafeExternalUrl(42))
})
