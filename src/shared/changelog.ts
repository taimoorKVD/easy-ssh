/** Body of the `## [version]` section, without the heading. Empty when that version is absent. */
export function extractChangelogSection(markdown: string, version: string): string {
  const wanted = version.trim()
  if (!wanted || wanted.toLowerCase() === 'unreleased') return ''
  const lines = markdown.split(/\r?\n/)
  let capture = false
  const body: string[] = []
  for (const line of lines) {
    const heading = /^##\s+(?:\[([^\]]+)\]|(\d+\.\d+\.\d+))(?:\s|$)/.exec(line)
    if (heading) {
      if (capture) break
      const label = (heading[1] ?? heading[2] ?? '').trim()
      if (label === wanted) capture = true
      continue
    }
    if (capture) body.push(line)
  }
  return body.join('\n').trim()
}
