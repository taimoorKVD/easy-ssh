import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isExposed, parseSocksConnect, validateForward, validateForwards } from '../src/shared/forwards.ts'

test('defaults bind to loopback and validates', () => {
  const r = validateForward({ id: 'a', type: 'local', bindPort: 8080, destHost: 'db', destPort: 5432 })
  assert.equal(r.bindHost, '127.0.0.1')
  assert.equal(isExposed(r), false)
  assert.equal(isExposed({ bindHost: '0.0.0.0' }), true)
})
test('rejects bad rules', () => {
  assert.throws(() => validateForward({ id: 'a', type: 'local', bindHost: '10.0.0.5', bindPort: 1, destHost: 'x', destPort: 1 }))
  assert.throws(() => validateForward({ id: 'a', type: 'local', bindPort: 70000, destHost: 'x', destPort: 1 }))
  assert.throws(() => validateForward({ id: 'a', type: 'remote', bindPort: 80, destHost: 'a b', destPort: 1 }))
  assert.throws(() => validateForward({ id: 'a', type: 'x', bindPort: 80 }))
  assert.throws(() => validateForwards([{ id: 'a', type: 'dynamic', bindPort: 1080 }, { id: 'a', type: 'dynamic', bindPort: 1081 }]))
})
test('socks parse', () => {
  assert.equal(parseSocksConnect(new Uint8Array([5, 1, 0])), null)
  const dom = new Uint8Array([5, 1, 0, 3, 3, 97, 98, 99, 0, 80])
  assert.deepEqual(parseSocksConnect(dom), { host: 'abc', port: 80, length: 10 })
  assert.deepEqual(parseSocksConnect(new Uint8Array([5, 1, 0, 1, 10, 0, 0, 1, 1, 187])), { host: '10.0.0.1', port: 443, length: 10 })
  assert.throws(() => parseSocksConnect(new Uint8Array([5, 2, 0, 1, 0, 0, 0, 0, 0, 0])))
})
