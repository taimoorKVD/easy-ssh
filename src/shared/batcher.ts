/**
 * Coalesces many small output chunks per key into fewer, larger flushes.
 * Fast typing still feels instant (first chunk flushes on the next tick),
 * while floods like `cat bigfile` become a handful of IPC messages per frame.
 */
export class OutputBatcher {
  private buffers = new Map<string, string[]>()
  private sizes = new Map<string, number>()
  private timer: ReturnType<typeof setTimeout> | null = null

  private readonly flushFn: (key: string, data: string) => void
  private readonly delayMs: number
  private readonly maxBytes: number

  constructor(flushFn: (key: string, data: string) => void, delayMs = 6, maxBytes = 256 * 1024) {
    this.flushFn = flushFn
    this.delayMs = delayMs
    this.maxBytes = maxBytes
  }

  push(key: string, data: string): void {
    if (!data) return
    let list = this.buffers.get(key)
    if (!list) {
      list = []
      this.buffers.set(key, list)
    }
    list.push(data)
    const size = (this.sizes.get(key) ?? 0) + data.length
    this.sizes.set(key, size)
    if (size >= this.maxBytes) {
      this.flushKey(key)
      return
    }
    if (!this.timer) this.timer = setTimeout(() => this.flushAll(), this.delayMs)
  }

  flushKey(key: string): void {
    const list = this.buffers.get(key)
    this.buffers.delete(key)
    this.sizes.delete(key)
    if (list && list.length) this.flushFn(key, list.join(''))
  }

  flushAll(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    for (const key of [...this.buffers.keys()]) this.flushKey(key)
  }

  drop(key: string): void {
    this.buffers.delete(key)
    this.sizes.delete(key)
  }
}

/** Run async jobs with at most `limit` running at once, preserving errors. */
export async function runLimited<T>(items: T[], limit: number, job: (item: T) => Promise<void>): Promise<void> {
  let next = 0
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (next < items.length) {
      const item = items[next++]
      await job(item)
    }
  })
  await Promise.all(workers)
}
