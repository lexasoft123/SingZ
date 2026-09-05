/**
 * The seek bar's level envelope for the LEGACY engine: one RMS level per
 * sliver per lane, the same statistic the native core publishes for its
 * prepared lanes (`summarizeLanePeaks`, native/playback), so the two
 * backends draw one bar. Pure over a reader the AudioBuffer satisfies, so a
 * unit test can feed it a synthesized signal and a screen can feed it the
 * decoded stems.
 *
 * Every frame of every channel is visited through small windowed reads
 * (`copyFromChannel` into one scratch buffer), never a whole-lane copy — a
 * lane is ~46 MB a minute and `getChannelData` would copy it (the jetsam
 * rule). One sliver used to be a single 2048-frame window at its start on
 * channel 0, every fourth sample: 2% of the audio, and a different statistic
 * from the native one, which is why the two bars disagreed.
 */
export interface LaneLevelReader {
  readonly length: number;
  readonly numberOfChannels: number;
  copyFromChannel(destination: Float32Array, channel: number, startInChannel: number): void;
}

export const LANE_LEVEL_SLIVERS = 96;
const WINDOW = 4096;

/** RMS level of each of `slivers` equal spans of `[0, frames)` for one
 *  lane, over all its channels. A lane shorter than `frames` (a custom
 *  track) is silent past its own end, not a repeat of its tail. */
export function laneSliverLevels(
  lane: LaneLevelReader,
  frames: number,
  slivers: number = LANE_LEVEL_SLIVERS,
  scratch: Float32Array = new Float32Array(WINDOW),
): Float32Array {
  const levels = new Float32Array(slivers);
  if (frames <= 0 || lane.length <= 0 || lane.numberOfChannels <= 0) return levels;
  for (let i = 0; i < slivers; i++) {
    const start = Math.floor((i * frames) / slivers);
    let end = Math.floor(((i + 1) * frames) / slivers);
    if (end <= start) end = start + 1;
    if (start >= lane.length) continue;
    const stop = Math.min(end, lane.length);
    let sum = 0;
    let count = 0;
    for (let channel = 0; channel < lane.numberOfChannels; channel++) {
      for (let at = start; at < stop; at += scratch.length) {
        const span = Math.min(scratch.length, stop - at);
        // Never ask for frames past the lane's end: the phone's AudioBuffer
        // throws ("Not enough data to copy from source") on a destination
        // longer than what is left, where the Web Audio spec would copy the
        // remainder — and it sizes the destination by its UNDERLYING array
        // buffer, so a subarray view does not help. The tail of a sliver
        // gets an array of exactly its span.
        const target = span === scratch.length ? scratch : new Float32Array(span);
        lane.copyFromChannel(target, channel, at);
        for (let k = 0; k < span; k++) {
          const v = target[k];
          if (Number.isFinite(v)) {
            sum += v * v;
            count++;
          }
        }
      }
    }
    levels[i] = count === 0 ? 0 : Math.min(1, Math.sqrt(sum / count));
  }
  return levels;
}
