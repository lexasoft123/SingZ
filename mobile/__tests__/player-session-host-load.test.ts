/*
 * The player-session suite's "is the host quiet?" rule, tested without
 * waiting ninety seconds for three real load samples.
 *
 * The rule exists because an afternoon of CPU columns was thrown away: the
 * Mac at a 1-minute load of 8-11 from the user's own apps, and the table
 * judging simulator and emulator numbers that described the desktop. The
 * driver runs in node against a device, so its helper is plain CommonJS
 * required here as-is.
 */
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { isQuiet, waitQuiet, hostLoad } = require('../tests/player-session/host-load.cjs')

describe('the host-quiet rule', () => {
  it('reads a real 1-minute load and the core count', () => {
    const h = hostLoad()
    expect(typeof h.load1).toBe('number')
    expect(h.load1).toBeGreaterThanOrEqual(0)
    expect(h.cpus).toBeGreaterThan(0)
  })

  it('is quiet at the threshold and busy one tenth above it', () => {
    expect(isQuiet(4, 4)).toBe(true)
    expect(isQuiet(4.1, 4)).toBe(false)
    expect(isQuiet(0, 4)).toBe(true)
    // A missing sample is never "quiet" — that is how a refusal that could
    // not read the load would otherwise pass.
    expect(isQuiet(null, 4)).toBe(false)
    expect(isQuiet(undefined, 4)).toBe(false)
  })

  /** A scripted sampler and a clock that advances only when the wait sleeps. */
  function scripted(loads: number[], everyMs = 30_000) {
    let i = 0
    let t = 1_000_000
    const sleeps: number[] = []
    return {
      sample: () => ({ load1: loads[Math.min(i++, loads.length - 1)], cpus: 12 }),
      sleep: async (ms: number) => {
        sleeps.push(ms)
        t += ms
      },
      now: () => t,
      everyMs,
      sleeps
    }
  }

  it('needs three CONSECUTIVE quiet samples, and a busy one restarts the streak', async () => {
    // quiet, quiet, BUSY, quiet, quiet, quiet → done on the sixth sample
    const s = scripted([1, 2, 9, 1, 1, 1])
    const out = await waitQuiet({ threshold: 4, needed: 3, ...s, maxMs: 60 * 60_000 })
    expect(out.quiet).toBe(true)
    expect(out.samples).toEqual([1, 2, 9, 1, 1, 1])
    // five waits between six samples, each the configured interval
    expect(s.sleeps).toEqual([30_000, 30_000, 30_000, 30_000, 30_000])
  })

  it('returns at once when the host is already quiet three times over', async () => {
    const s = scripted([3, 3, 3, 9])
    const out = await waitQuiet({ threshold: 4, needed: 3, ...s, maxMs: 60 * 60_000 })
    expect(out.quiet).toBe(true)
    expect(out.samples).toEqual([3, 3, 3])
  })

  it('gives up, saying so, when the bound runs out before the streak completes', async () => {
    // never quiet; a 2-minute bound at 30 s samples = samples at 0, 30, 60, 90
    // and 120 s (a sample exactly at the bound is still taken), then no sleep
    // that would end past it
    const s = scripted([8, 9, 10, 11, 12, 13, 14])
    const out = await waitQuiet({ threshold: 4, needed: 3, ...s, maxMs: 2 * 60_000 })
    expect(out.quiet).toBe(false)
    expect(out.samples).toEqual([8, 9, 10, 11, 12])
    expect(s.sleeps.length).toBe(4)
  })

  it('does not count a quiet sample that follows a busy one as the third', async () => {
    // Two quiet, busy, two quiet — the bound expires before a third
    const s = scripted([1, 1, 9, 1, 1, 9, 9])
    const out = await waitQuiet({ threshold: 4, needed: 3, ...s, maxMs: 2.5 * 60_000 })
    expect(out.quiet).toBe(false)
  })
})
