import { useEffect, useRef, useState } from 'react'
import { cpuPercent, formatUptime, parseStats, percent, type CpuSample, type ServerStats } from '@shared/stats'

const INTERVAL = 5000

function level(value: number | undefined): string {
  if (value === undefined) return ''
  return value >= 90 ? 'hot' : value >= 70 ? 'warm' : ''
}

export default function StatsBar({ sessionId }: { sessionId: string }): React.JSX.Element | null {
  const [stats, setStats] = useState<ServerStats | null>(null)
  const [cpu, setCpu] = useState<number | undefined>()
  const [unsupported, setUnsupported] = useState(false)
  const prevCpu = useRef<CpuSample | undefined>(undefined)

  useEffect(() => {
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    let misses = 0
    prevCpu.current = undefined
    setStats(null)
    setCpu(undefined)
    setUnsupported(false)
    const tick = async (): Promise<void> => {
      if (document.visibilityState === 'visible') {
        const raw = await window.easySsh.serverStats(sessionId).catch(() => null)
        if (cancelled) return
        const parsed = raw ? parseStats(raw) : null
        if (parsed && (parsed.cpu || parsed.memTotalKb)) {
          misses = 0
          setCpu(cpuPercent(prevCpu.current, parsed.cpu))
          prevCpu.current = parsed.cpu
          setStats(parsed)
        } else if (++misses >= 3) {
          setUnsupported(true)
          return
        }
      }
      timer = setTimeout(() => void tick(), INTERVAL)
    }
    void tick()
    const onVisible = (): void => {
      if (document.visibilityState === 'visible' && timer) {
        clearTimeout(timer)
        void tick()
      }
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [sessionId])

  if (unsupported) return <span className="stats-bar muted" title="Stats need a Linux host with /proc">stats n/a</span>
  if (!stats) return <span className="stats-bar muted">stats…</span>
  const mem = percent(stats.memTotalKb !== undefined && stats.memAvailableKb !== undefined ? stats.memTotalKb - stats.memAvailableKb : undefined, stats.memTotalKb)
  const disk = percent(stats.diskUsedKb, stats.diskTotalKb)
  return (
    <span className="stats-bar" title={stats.load1 !== undefined ? `Load (1 min): ${stats.load1}` : undefined}>
      <span className={level(cpu)}>CPU {cpu ?? '–'}%</span>
      <span className={level(mem)}>RAM {mem ?? '–'}%</span>
      <span className={level(disk)}>Disk {disk ?? '–'}%</span>
      {stats.uptimeSec !== undefined && <span>Up {formatUptime(stats.uptimeSec)}</span>}
    </span>
  )
}
