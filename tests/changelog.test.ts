import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { extractChangelogSection } from '../src/shared/changelog.ts'

test('extracts only the matching version section', () => {
  const markdown = `# Changelog

## [Unreleased]

MFA fix

## [1.1.3] - 2026-10-29

Docs release

## 1.1.2 - 2026-10-29

Installer release
`
  assert.equal(extractChangelogSection(markdown, '1.1.3'), 'Docs release')
  assert.equal(extractChangelogSection(markdown, '1.1.2'), 'Installer release')
  assert.equal(extractChangelogSection(markdown, '9.9.9'), '')
  assert.equal(extractChangelogSection(markdown, 'Unreleased'), '')
  assert.equal(extractChangelogSection(markdown, ''), '')
})

test('the changelog has Unreleased and a section for each published tag', () => {
  const text = readFileSync(new URL('../CHANGELOG.md', import.meta.url), 'utf8')
  assert.match(text, /^## \[Unreleased\]/m)
  for (const version of ['1.1.0', '1.1.2', '1.1.3']) {
    const section = extractChangelogSection(text, version)
    assert.ok(section.length > 40, `${version} section is missing`)
    assert.equal(section.includes('\n## '), false)
  }
  assert.equal(extractChangelogSection(text, '1.1.1'), '')
})
