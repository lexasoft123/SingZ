import type { CustomTrack } from '../../shared/types'

/** Unreadable lanes stay in the project so installing a codec can restore them.
 * The load generation prevents an old open from retaining lanes in a new song. */
export class UnavailableCustomTracks {
  private seq = 0
  private tracks = new Map<string, CustomTrack>()

  reset(seq: number): void {
    this.seq = seq
    this.tracks.clear()
  }

  retain(seq: number, definitions: CustomTrack[], rejected: Iterable<string>): void {
    if (seq !== this.seq) return
    const ids = new Set(rejected)
    for (const track of definitions) {
      if (ids.has(track.id)) this.tracks.set(track.id, { ...track })
    }
  }

  /** A split replaces lanes, but still belongs to the same project. */
  advance(from: number, to: number): void {
    if (from === this.seq) this.seq = to
  }

  forSave(seq: number, playable: CustomTrack[]): CustomTrack[] {
    const merged = new Map(seq === this.seq ? this.tracks : [])
    // Current edits take precedence if a retained lane becomes readable again.
    for (const track of playable) merged.set(track.id, track)
    return [...merged.values()]
  }

  reanchor(seq: number, saved: CustomTrack[]): void {
    if (seq !== this.seq) return
    for (const track of saved) {
      if (this.tracks.has(track.id)) this.tracks.set(track.id, { ...track })
    }
  }
}
