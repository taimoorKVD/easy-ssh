import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { extractChangelogSection } from '../src/shared/changelog.ts'

const version = process.argv[2] ?? ''
const root = join(dirname(fileURLToPath(import.meta.url)), '..')
let markdown = ''
try {
  markdown = readFileSync(join(root, 'CHANGELOG.md'), 'utf8')
} catch {
  process.exit(1)
}
const section = extractChangelogSection(markdown, version)
if (!section) process.exit(1)
process.stdout.write(`${section}\n`)
