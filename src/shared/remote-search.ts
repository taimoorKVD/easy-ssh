// Remote find/grep command builders. Every user value is single-quoted; nothing is interpolated raw.

export type SearchMode = 'name' | 'content'
export interface SearchHit {
  path: string
  line?: number
  text?: string
}

export const SEARCH_LIMIT = 500

export function shQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

export function validateSearch(dir: unknown, mode: unknown, pattern: unknown): { dir: string; mode: SearchMode; pattern: string } {
  if (typeof dir !== 'string' || !dir.startsWith('/') || dir.length > 4096 || /[\0\n\r]/.test(dir)) throw new Error('Search needs an absolute folder.')
  if (mode !== 'name' && mode !== 'content') throw new Error('Invalid search mode.')
  if (typeof pattern !== 'string' || !pattern.trim() || pattern.length > 200 || /[\0\n\r]/.test(pattern)) {
    throw new Error('Type 1–200 characters to search for.')
  }
  return { dir, mode, pattern }
}

export function buildSearchCommand(dir: string, mode: SearchMode, pattern: string): string {
  const root = shQuote(dir)
  if (mode === 'name') {
    // Glob metacharacters in the user's text are escaped so it is a literal substring match.
    const literal = pattern.replace(/[\\*?[\]]/g, (c) => `\\${c}`)
    return `find ${root} -xdev \\( -name .git -o -name node_modules \\) -prune -o -iname ${shQuote(`*${literal}*`)} -print 2>/dev/null | head -n ${SEARCH_LIMIT}`
  }
  return `grep -rInIs -F -i -m 5 --exclude-dir=.git --exclude-dir=node_modules -e ${shQuote(pattern)} -- ${root} 2>/dev/null | head -n ${SEARCH_LIMIT} | cut -c1-400`
}

export function parseSearchOutput(mode: SearchMode, output: string): SearchHit[] {
  const hits: SearchHit[] = []
  for (const line of output.split('\n')) {
    if (!line) continue
    if (mode === 'name') {
      if (line.startsWith('/')) hits.push({ path: line })
      continue
    }
    const m = /^(\/.*?):(\d+):(.*)$/.exec(line)
    if (m) hits.push({ path: m[1], line: Number(m[2]), text: m[3].slice(0, 300) })
    if (hits.length >= SEARCH_LIMIT) break
  }
  return hits
}
