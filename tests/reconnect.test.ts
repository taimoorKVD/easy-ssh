import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MAX_RECONNECT_ATTEMPTS, backoffDelay, parseRestoreState, serializeRestoreState, shouldAutoReconnect } from '../src/shared/reconnect.ts'

test('backoff grows and caps', () => {
  const mid = () => 0.5
  assert.equal(backoffDelay(0, mid), 1000)
  assert.equal(backoffDelay(3, mid), 8000)
  assert.equal(backoffDelay(10, mid), 30000)
})

test('only network drops after a live session reconnect', () => {
  assert.ok(shouldAutoReconnect({ phase: 'error', code: 'network' }, true, 0))
  assert.ok(shouldAutoReconnect({ phase: 'error', code: 'timeout' }, true, 2))
  assert.ok(!shouldAutoReconnect({ phase: 'error', code: 'network' }, false, 0))
  assert.ok(!shouldAutoReconnect({ phase: 'error', code: 'auth' }, true, 0))
  assert.ok(!shouldAutoReconnect({ phase: 'error', code: 'hostkey' }, true, 0))
  assert.ok(!shouldAutoReconnect({ phase: 'disconnected' }, true, 0))
  assert.ok(!shouldAutoReconnect({ phase: 'error', code: 'network' }, true, MAX_RECONNECT_ATTEMPTS))
})

test('restore state keeps only known ids and modes', () => {
  const raw = serializeRestoreState([{ connectionId: 'aaaaaaaa-1', mode: 'files' }])
  assert.equal(raw, '[{"connectionId":"aaaaaaaa-1","mode":"files"}]')
  const parsed = parseRestoreState('[{"connectionId":"aaaaaaaa-1","mode":"files","password":"x"},{"connectionId":"gone"},{"connectionId":"aaaaaaaa-1"}]', new Set(['aaaaaaaa-1']))
  assert.deepEqual(parsed, [{ connectionId: 'aaaaaaaa-1', mode: 'files' }])
  assert.deepEqual(parseRestoreState('not json', new Set()), [])
})
