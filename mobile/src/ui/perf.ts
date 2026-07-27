/**
 * Dev-only UI performance probe: rAF frame-gap sampling on the JS thread plus
 * a React commit counter (PlayerScreen bumps it every commit). Driven over CDP
 * by the sim harness — TEST.perfStart() / TEST.perfStop().
 */
interface PerfReport {
  frames: number
  avgMs: number
  p95Ms: number
  worstMs: number
  dropped: number
  commits: number
}

let samples: number[] = []
let running = false
let lastT = 0
let raf = 0
let commits = 0

export const perf = {
  commit(): void {
    if (running) commits++
  },
  start(): void {
    samples = []
    commits = 0
    running = true
    lastT = 0
    const loop = (t: number): void => {
      if (!running) return
      if (lastT > 0) samples.push(t - lastT)
      lastT = t
      raf = requestAnimationFrame(loop)
    }
    raf = requestAnimationFrame(loop)
  },
  stop(): PerfReport {
    running = false
    cancelAnimationFrame(raf)
    const s = [...samples].sort((a, b) => a - b)
    const n = s.length
    const avg = n ? s.reduce((a, x) => a + x, 0) / n : 0
    return {
      frames: n,
      avgMs: Math.round(avg * 100) / 100,
      p95Ms: Math.round((s[Math.floor(n * 0.95)] ?? 0) * 100) / 100,
      worstMs: Math.round((s[n - 1] ?? 0) * 100) / 100,
      dropped: s.filter((x) => x > 33).length,
      commits
    }
  }
}
