import { STEMS, STEMS_6, type StemName6 } from '../shared/types'
import type { StemHash } from './projects'

/**
 * What a project folder actually holds, judged once.
 *
 * The library list and the open path used to work this out separately —
 * existence checks in two places, the same rule written twice — and neither
 * looked at the checksums the desktop itself had written into project.json.
 * A stem truncated by a half-finished copy or an interrupted iCloud
 * materialization passed both, and surfaced three layers down as
 * "Could not decode that audio file", which names neither the file nor the
 * problem. The doc states what every file should be; this compares against it.
 */

export interface ProjectFacts {
  /** Which of the six lanes exist, and in which format. */
  stems: Partial<Record<StemName6, 'flac' | 'wav'>>
  /** The core four are there — the bar for a project being playable at all. */
  playable: boolean
  /** Named by project.json, absent from stems/. */
  missing: string[]
  /** There, but not the size the doc states — a half-written or clobbered file. */
  damaged: string[]
}

export function describeProject(
  meta: { stemHashes?: Record<string, StemHash> } | null,
  /** Every file in stems/, by name → size on disk. */
  present: Record<string, number>
): ProjectFacts {
  const stems: Partial<Record<StemName6, 'flac' | 'wav'>> = {}
  for (const s of STEMS_6) {
    if (present[`${s}.flac`] !== undefined) stems[s] = 'flac'
    else if (present[`${s}.wav`] !== undefined) stems[s] = 'wav'
  }

  const missing: string[] = []
  const damaged: string[] = []
  for (const [name, h] of Object.entries(meta?.stemHashes ?? {})) {
    const size = present[name]
    if (size === undefined) missing.push(name)
    else if (h?.size > 0 && size !== h.size) damaged.push(name)
  }

  return { stems, playable: STEMS.every((s) => stems[s] !== undefined), missing, damaged }
}
