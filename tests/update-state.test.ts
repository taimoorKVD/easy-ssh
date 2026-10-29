import assert from 'node:assert/strict'
import { it } from 'node:test'
import { compareVersions, initialUpdateState, reduceUpdate, summarizeNotes, type UpdateEvent, type UpdateState } from '../src/shared/update-state.ts'

const run = (events: UpdateEvent[], snoozed?: string, start: UpdateState = initialUpdateState('1.1.0')): UpdateState =>
  events.reduce((s, e) => reduceUpdate(s, e, snoozed), start)

it('compares versions', () => {
  assert.ok(compareVersions('1.10.0', '1.9.9') > 0)
  assert.equal(compareVersions('1.1.0', '1.1.0'), 0)
})

it('full happy path: check → available → progress → ready', () => {
  const s = run([{ type: 'check', manual: false }, { type: 'available', version: '1.2.0', notes: '<p>Faster <b>SFTP</b></p>' }, { type: 'progress', percent: 42.4 }, { type: 'downloaded', version: '1.2.0' }])
  assert.equal(s.phase, 'ready')
  assert.equal(s.visible, true)
  assert.equal(s.percent, 100)
  assert.equal(run([{ type: 'check', manual: false }, { type: 'available', version: '1.2.0', notes: '<p>Faster <b>SFTP</b></p>' }]).notes, 'Faster SFTP')
})

it('never offers a downgrade or same version', () => {
  assert.equal(run([{ type: 'check', manual: false }, { type: 'available', version: '1.0.9' }]).phase, 'uptodate')
  assert.equal(run([{ type: 'check', manual: false }, { type: 'available', version: '1.1.0' }]).visible, false)
  assert.equal(run([{ type: 'check', manual: false }, { type: 'available', version: 'x' }]).phase, 'uptodate')
})

it('snoozed version is quiet on auto checks but shown on manual', () => {
  assert.equal(run([{ type: 'check', manual: false }, { type: 'available', version: '1.2.0' }], '1.2.0').visible, false)
  assert.equal(run([{ type: 'check', manual: true }, { type: 'available', version: '1.2.0' }], '1.2.0').visible, true)
  assert.equal(run([{ type: 'check', manual: false }, { type: 'available', version: '1.3.0' }], '1.2.0').visible, true)
})

it('up-to-date and errors only pop up for manual checks', () => {
  assert.equal(run([{ type: 'check', manual: false }, { type: 'none' }]).visible, false)
  assert.equal(run([{ type: 'check', manual: true }, { type: 'none' }]).visible, true)
  assert.equal(run([{ type: 'check', manual: false }, { type: 'error', message: 'net::ERR_INTERNET_DISCONNECTED' }]).visible, false)
  const e = run([{ type: 'check', manual: true }, { type: 'error', message: 'getaddrinfo ENOTFOUND github.com' }])
  assert.equal(e.visible, true)
  assert.match(e.error!, /internet/)
})

it('a check during download does not reset progress; dismiss hides', () => {
  const s = run([{ type: 'check', manual: false }, { type: 'available', version: '2.0.0' }, { type: 'progress', percent: 10 }, { type: 'check', manual: false }])
  assert.equal(s.phase, 'downloading')
  assert.equal(reduceUpdate(s, { type: 'dismiss' }).visible, false)
  assert.equal(summarizeNotes('  '), undefined)
})
