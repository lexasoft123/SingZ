import type { BoxMetronomeOverride } from '../../../shared/box-contract'

/** Only a missing legacy field defaults to Song; malformed preferences fail closed. */
export function boxMetronomePreference(value: unknown): BoxMetronomeOverride | null {
  return value === undefined ? 'song' : value === 'song' || value === 'off' ? value : null
}

export class MetronomePolicyError extends Error {
  constructor(readonly safeMode: 'off' | null, cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause))
  }
}

/** Never restore audible song cues before the requested preference is durable. */
export async function applyBoxMetronomePolicy(
  mode: BoxMetronomeOverride,
  apply: (mode: BoxMetronomeOverride) => Promise<void>,
  persist?: (mode: BoxMetronomeOverride) => Promise<void>
): Promise<BoxMetronomeOverride> {
  let safeMode: 'off' | null = null
  try {
    await apply('off')
    safeMode = 'off'
    await persist?.(mode)
    if (mode === 'song') {
      safeMode = null
      await apply('song')
    }
    return mode
  } catch (error) {
    // An uncertain Song receipt may already have enabled cues. Reconfirm Off.
    if (safeMode === null) {
      try { await apply('off'); safeMode = 'off' } catch { /* unknown remains locked */ }
    }
    throw new MetronomePolicyError(safeMode, error)
  }
}
