import { test } from 'node:test'
import assert from 'node:assert/strict'
import { OutputBatcher, runLimited } from '../src/shared/batcher.ts'

test('coalesces chunks per key and keeps order', async () => {
  const out: Array<[string, string]> = []
  const b = new OutputBatcher((k, d) => out.push([k, d]), 5)
  b.push('a', 'he'); b.push('b', 'x'); b.push('a', 'llo')
  assert.equal(out.length, 0)
  await new Promise((r) => setTimeout(r, 20))
  assert.deepEqual(out.sort(), [['a', 'hello'], ['b', 'x']])
})

test('flushes immediately at the size cap', () => {
  const out: string[] = []
  const b = new OutputBatcher((_k, d) => out.push(d), 1000, 4)
  b.push('a', 'ab'); b.push('a', 'cd')
  assert.deepEqual(out, ['abcd'])
  b.flushAll()
})

test('drop discards pending data', async () => {
  const out: string[] = []
  const b = new OutputBatcher((_k, d) => out.push(d), 5)
  b.push('a', 'zz'); b.drop('a')
  await new Promise((r) => setTimeout(r, 15))
  assert.deepEqual(out, [])
})

test('runLimited caps concurrency and runs all', async () => {
  let running = 0, peak = 0
  const done: number[] = []
  await runLimited([1, 2, 3, 4, 5, 6], 3, async (n) => {
    running++; peak = Math.max(peak, running)
    await new Promise((r) => setTimeout(r, 5))
    done.push(n); running--
  })
  assert.equal(peak, 3)
  assert.equal(done.length, 6)
})
