import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  baseNameRemote,
  breadcrumbs,
  filterHidden,
  formatMode,
  formatSize,
  friendlySftpError,
  isLikelyText,
  joinRemote,
  kindFromMode,
  nextSelection,
  normalizeRemote,
  octalMode,
  parentRemote,
  parseOctalMode,
  sortEntries,
  validFileName,
  type RemoteEntry
} from '../src/shared/remote-fs.ts'

const e = (name: string, kind: RemoteEntry['kind'], size = 0, mtime = 0, mode = 0o100644): RemoteEntry => ({
  name, path: `/x/${name}`, kind, size, mtime, mode: kind === 'dir' ? 0o040755 : mode
})

describe('remote paths', () => {
  it('normalizes', () => {
    assert.equal(normalizeRemote('/a//b/./c/../d/'), '/a/b/d')
    assert.equal(normalizeRemote('/../..'), '/')
    assert.equal(normalizeRemote('a/../..'), '..')
  })
  it('joins', () => {
    assert.equal(joinRemote('/home/me', 'site'), '/home/me/site')
    assert.equal(joinRemote('/', 'etc'), '/etc')
    assert.equal(joinRemote('/home/me/', '../you'), '/home/you')
    assert.equal(joinRemote('/home/me', '/var/www'), '/var/www')
    assert.equal(joinRemote('/a', 'b', 'c d'), '/a/b/c d')
  })
  it('parent and basename', () => {
    assert.equal(parentRemote('/home/me'), '/home')
    assert.equal(parentRemote('/home'), '/')
    assert.equal(parentRemote('/'), '/')
    assert.equal(baseNameRemote('/var/log/syslog'), 'syslog')
  })
  it('breadcrumbs', () => {
    assert.deepEqual(breadcrumbs('/var/www'), [
      { name: '/', path: '/' },
      { name: 'var', path: '/var' },
      { name: 'www', path: '/var/www' }
    ])
  })
  it('validates names', () => {
    assert.equal(validFileName('ok.txt'), null)
    assert.ok(validFileName(''))
    assert.ok(validFileName('..'))
    assert.ok(validFileName('a/b'))
  })
})

describe('formatting', () => {
  it('formats sizes', () => {
    assert.equal(formatSize(0), '0 B')
    assert.equal(formatSize(1023), '1023 B')
    assert.equal(formatSize(1536), '1.5 KB')
    assert.equal(formatSize(5 * 1024 * 1024), '5.0 MB')
    assert.equal(formatSize(300 * 1024 ** 3), '300 GB')
    assert.equal(formatSize(-1), '—')
  })
  it('formats permissions', () => {
    assert.equal(formatMode(0o040755), 'drwxr-xr-x')
    assert.equal(formatMode(0o100644), '-rw-r--r--')
    assert.equal(formatMode(0o120777), 'lrwxrwxrwx')
    assert.equal(formatMode(0o104755), '-rwsr-xr-x')
    assert.equal(formatMode(0o041777), 'drwxrwxrwt')
    assert.equal(octalMode(0o100644), '644')
    assert.equal(parseOctalMode('755'), 0o755)
    assert.equal(parseOctalMode('0644'), 0o644)
    assert.equal(parseOctalMode('9'), null)
    assert.equal(kindFromMode(0o040755), 'dir')
    assert.equal(kindFromMode(0o120777), 'link')
  })
  it('detects text files', () => {
    assert.ok(isLikelyText('nginx.conf'))
    assert.ok(isLikelyText('.env'))
    assert.ok(isLikelyText('Dockerfile'))
    assert.ok(!isLikelyText('photo.jpg'))
  })
  it('makes friendly errors', () => {
    assert.match(friendlySftpError(Object.assign(new Error('x'), { code: 3 }), '/root'), /Permission denied \(\/root\)/)
    assert.match(friendlySftpError(Object.assign(new Error('x'), { code: 2 })), /No such file/)
  })
})

describe('sorting and selection', () => {
  const list = [e('b.txt', 'file', 10, 3), e('Zdir', 'dir', 0, 1), e('a10.txt', 'file', 30, 2), e('a2.txt', 'file', 20, 4), e('.hid', 'file')]
  it('sorts folders first then natural name', () => {
    assert.deepEqual(sortEntries(list, 'name', 'asc').map((x) => x.name), ['Zdir', '.hid', 'a2.txt', 'a10.txt', 'b.txt'])
  })
  it('sorts by size and date descending', () => {
    assert.deepEqual(sortEntries(list, 'size', 'desc').map((x) => x.name), ['Zdir', 'a10.txt', 'a2.txt', 'b.txt', '.hid'])
    assert.deepEqual(sortEntries(list, 'mtime', 'asc').map((x) => x.name), ['Zdir', '.hid', 'a10.txt', 'b.txt', 'a2.txt'])
  })
  it('hides dotfiles', () => {
    assert.equal(filterHidden(list, false).length, 4)
    assert.equal(filterHidden(list, true).length, 5)
  })
  it('handles ctrl/shift selection', () => {
    const order = ['a', 'b', 'c', 'd']
    let r = nextSelection(order, new Set(), null, 'b', { ctrl: false, shift: false })
    assert.deepEqual([...r.selected], ['b'])
    r = nextSelection(order, r.selected, r.anchor, 'd', { ctrl: false, shift: true })
    assert.deepEqual([...r.selected], ['b', 'c', 'd'])
    r = nextSelection(order, r.selected, r.anchor, 'c', { ctrl: true, shift: false })
    assert.deepEqual([...r.selected].sort(), ['b', 'd'])
  })
})
