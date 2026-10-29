/** Keyboard navigation for a list: arrows wrap around, PageUp/PageDown move by a page and clamp, Home/End jump. */
export function nextListIndex(key: string, index: number, count: number, page = 8): number | null {
  if (count <= 0) return null
  const last = count - 1
  const i = Math.min(Math.max(index, 0), last)
  switch (key) {
    case 'ArrowDown': return i >= last ? 0 : i + 1
    case 'ArrowUp': return i <= 0 ? last : i - 1
    case 'PageDown': return Math.min(last, i + page)
    case 'PageUp': return Math.max(0, i - page)
    case 'Home': return 0
    case 'End': return last
    default: return null
  }
}
