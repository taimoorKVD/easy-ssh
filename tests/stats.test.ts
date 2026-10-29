import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cpuPercent, formatUptime, parseStats, percent } from '../src/shared/stats.ts'

const sample = `cpu  100 0 50 800 50 0 0 0 0 0
--mem
MemTotal:        8000000 kB
MemAvailable:    2000000 kB
--up
93784.12 300000.00
--load
0.42 0.30 0.20 1/200 1234
--df
/dev/sda1 100000 25000 75000 25% /
`

test('parses a full probe', () => {
  const s = parseStats(sample)
  assert.deepEqual(s.cpu, { idle: 850, total: 1000 })
  assert.equal(s.memTotalKb, 8000000)
  assert.equal(percent(s.memTotalKb! - s.memAvailableKb!, s.memTotalKb), 75)
  assert.equal(s.load1, 0.42)
  assert.equal(percent(s.diskUsedKb, s.diskTotalKb), 25)
  assert.equal(formatUptime(s.uptimeSec!), '1d 2h')
})

test('cpu delta and junk tolerance', () => {
  assert.equal(cpuPercent({ idle: 850, total: 1000 }, { idle: 900, total: 1200 }), 75)
  assert.equal(cpuPercent(undefined, { idle: 1, total: 2 }), undefined)
  assert.deepEqual(parseStats('garbage\n--df\nnope'), {})
})
