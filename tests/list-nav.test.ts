import { test } from 'node:test'
import assert from 'node:assert/strict'
import { nextListIndex } from '../src/shared/list-nav.ts'

test('arrows wrap, pages clamp, home/end jump', () => {
  assert.equal(nextListIndex('ArrowUp', 0, 5), 4)
  assert.equal(nextListIndex('ArrowDown', 4, 5), 0)
  assert.equal(nextListIndex('ArrowDown', 1, 5), 2)
  assert.equal(nextListIndex('PageDown', 1, 5, 8), 4)
  assert.equal(nextListIndex('PageUp', 3, 5, 8), 0)
  assert.equal(nextListIndex('Home', 3, 5), 0)
  assert.equal(nextListIndex('End', 0, 5), 4)
  assert.equal(nextListIndex('ArrowDown', 0, 0), null)
  assert.equal(nextListIndex('x', 0, 5), null)
})
