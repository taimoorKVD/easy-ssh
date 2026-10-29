/** Fixed, read-only probe. No user input is ever interpolated into it. */
export const STATS_COMMAND =
  "LC_ALL=C; head -n1 /proc/stat; echo '--mem'; grep -E '^(MemTotal|MemAvailable):' /proc/meminfo; echo '--up'; cat /proc/uptime; echo '--load'; cat /proc/loadavg; echo '--df'; df -kP / 2>/dev/null | tail -n1"

export interface CpuSample {
  idle: number
  total: number
}

export interface ServerStats {
  cpu?: CpuSample
  memTotalKb?: number
  memAvailableKb?: number
  uptimeSec?: number
  load1?: number
  diskUsedKb?: number
  diskTotalKb?: number
}

export function parseStats(output: string): ServerStats {
  const stats: ServerStats = {}
  let section = 'cpu'
  for (const rawLine of output.split('\n')) {
    const line = rawLine.trim()
    if (!line) continue
    if (line.startsWith('--')) {
      section = line.slice(2)
      continue
    }
    if (section === 'cpu' && line.startsWith('cpu ')) {
      const nums = line.split(/\s+/).slice(1).map(Number).filter(Number.isFinite)
      if (nums.length >= 4) {
        const idle = nums[3] + (nums[4] ?? 0)
        stats.cpu = { idle, total: nums.slice(0, 8).reduce((a, b) => a + b, 0) }
      }
    } else if (section === 'mem') {
      const m = /^(MemTotal|MemAvailable):\s+(\d+)/.exec(line)
      if (m) stats[m[1] === 'MemTotal' ? 'memTotalKb' : 'memAvailableKb'] = Number(m[2])
    } else if (section === 'up') {
      const v = Number(line.split(/\s+/)[0])
      if (Number.isFinite(v)) stats.uptimeSec = v
    } else if (section === 'load') {
      const v = Number(line.split(/\s+/)[0])
      if (Number.isFinite(v)) stats.load1 = v
    } else if (section === 'df') {
      const parts = line.split(/\s+/)
      const total = Number(parts[1])
      const used = Number(parts[2])
      if (Number.isFinite(total) && Number.isFinite(used) && total > 0) {
        stats.diskTotalKb = total
        stats.diskUsedKb = used
      }
    }
  }
  return stats
}

export function cpuPercent(prev: CpuSample | undefined, next: CpuSample | undefined): number | undefined {
  if (!prev || !next) return undefined
  const total = next.total - prev.total
  const idle = next.idle - prev.idle
  if (total <= 0) return undefined
  return Math.max(0, Math.min(100, Math.round((1 - idle / total) * 100)))
}

export function formatUptime(sec: number): string {
  const d = Math.floor(sec / 86400)
  const h = Math.floor((sec % 86400) / 3600)
  const m = Math.floor((sec % 3600) / 60)
  if (d > 0) return `${d}d ${h}h`
  if (h > 0) return `${h}h ${m}m`
  return `${m}m`
}

export function percent(used: number | undefined, total: number | undefined): number | undefined {
  if (used === undefined || !total) return undefined
  return Math.round((used / total) * 100)
}
