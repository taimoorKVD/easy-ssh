import { test } from 'node:test'
import assert from 'node:assert/strict'
import { THEMES, parseThemeChoice, resolveTheme, terminalTheme, themeVars } from '../src/shared/theme.ts'

test('choices are validated', () => {
  assert.deepEqual(parseThemeChoice('{"id":"violet","accent":"#ABCDEF"}'), { id: 'violet', accent: '#ABCDEF' })
  assert.deepEqual(parseThemeChoice('{"id":"nope","accent":"red;}body{x"}'), { id: 'emerald' })
  assert.deepEqual(parseThemeChoice('junk'), { id: 'emerald' })
})

test('vars and terminal theme follow the accent', () => {
  const t = resolveTheme({ id: 'ocean', accent: '#ff0000' })
  const v = themeVars(t)
  assert.equal(v['--accent-rgb'], '255, 0, 0')
  assert.equal(v['--accent-ink'], '#ffffff')
  assert.equal(themeVars(resolveTheme({ id: 'emerald' }))['--accent-ink'], '#0b0f14')
  assert.equal(terminalTheme(t).cursor, '#ff0000')
  assert.equal(themeVars(resolveTheme({ id: 'paper' }))['color-scheme'], 'light')
  assert.equal(THEMES.length, 6)
})
