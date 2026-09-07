/**
 * The seek bar's level envelope for the LEGACY engine: one RMS level per
 * sliver per lane, the same statistic the native core publishes for its
 * prepared lanes (`summarizeLanePeaks`, native/playback), so the two
 * backends draw one bar. Pure over a reader the AudioBuffer satisfies, so a
 * unit test can feed it a synthesized signal and a screen can feed it the
 * decoded stems.
 *
 * Every read is a small window (`copyFromChannel` into one scratch buffer),
 * never a whole-lane copy — a lane is ~46 MB a minute and `getChannelData`
 * would copy it (the jetsam rule). One sliver used to be a single 2048-frame
 * window at its start on channel 0, every fourth sample: 2% of the audio,
 * and a different statistic from the native one, which is why the two bars
 * disagreed.
 *
 * The work is BOUNDED per sliver, and the bound is the point: this runs on
 * the JS thread, under Hermes, which has no JIT. Build 51 visited every
 * sample of every channel — a four-minute six-stem song is ~140 million
 * loop iterations, which reached an iPhone 13 as a player whose histogram
 * never came and whose Play button answered seconds late (the tap queued
 * behind the scan). A sliver longer than `budgetFrames` is read as
 * `budgetFrames / WINDOW` windows spread evenly across it — a stratified
 * sample of every channel, which converges on the full RMS and can never
 * cost more than the budget however long the song; a sliver within the
 * budget is read whole, so a short song's bar is exact. The screen also
 * yields between chunks of slivers, so no single tick holds the thread for
 * a whole lane.
 *
 * The window and budget were chosen by measurement, not taste: on a
 * drum-like lane (3000-frame hits every 24 000 frames) eight 1024-frame
 * windows per sliver missed whole hits and misread a sliver by up to 100%
 * (mean 60%); 256 windows of 128 frames read it within 2.2% (mean 0.8%)
 * at about a quarter of the full scan's cost, ~1.5 s of interpreted JS for
 * a four-minute six-stem song in place of 5.5. Sixty-four windows of 128
 * were still 29% out, and the bar's own parity check against the core
 * (play-from-anywhere, step 6) reads the levels to 10%.
 */
export interface LaneLevelReader {
  readonly length: number;
  readonly numberOfChannels: number;
  copyFromChannel(destination: Float32Array, channel: number, startInChannel: number): void;
}

export const LANE_LEVEL_SLIVERS = 96;
/** One read. Small, so the windows of a sampled sliver spread widely enough
 *  to catch every drum hit (see the header's measurement). */
export const LANE_LEVEL_WINDOW = 128;
/** Frames visited per channel per sliver at most: 256 windows. At 48 kHz a
 *  96-sliver bar of a four-minute song has 2.5 s slivers and reads 27% of
 *  them; a song under 65 s is read whole. */
export const LANE_LEVEL_SLIVER_BUDGET = 256 * LANE_LEVEL_WINDOW;
/** How many slivers the screen computes per tick of the JS thread. */
export const LANE_LEVEL_CHUNK = 32;

/** RMS level of each of `slivers` equal spans of `[0, frames)` for one
 *  lane, over all its channels, from at most `budgetFrames` frames per
 *  channel per sliver. A lane shorter than `frames` (a custom track) is
 *  silent past its own end, not a repeat of its tail. `from`/`to` bound the
 *  slivers computed in this call (the rest stay 0, or whatever `into`
 *  already holds), so a caller can spread the scan over several ticks. */
export function laneSliverLevels(
  lane: LaneLevelReader,
  frames: number,
  slivers: number = LANE_LEVEL_SLIVERS,
  scratch: Float32Array = new Float32Array(LANE_LEVEL_WINDOW),
  budgetFrames: number = LANE_LEVEL_SLIVER_BUDGET,
  into: Float32Array = new Float32Array(slivers),
  from = 0,
  to = slivers,
): Float32Array {
  const levels = into;
  if (frames <= 0 || lane.length <= 0 || lane.numberOfChannels <= 0) return levels;
  const window = Math.max(1, scratch.length);
  const budget = Math.max(window, Math.floor(budgetFrames));
  for (let i = Math.max(0, from); i < Math.min(slivers, to); i++) {
    const start = Math.floor((i * frames) / slivers);
    let end = Math.floor(((i + 1) * frames) / slivers);
    if (end <= start) end = start + 1;
    if (start >= lane.length) continue;
    const stop = Math.min(end, lane.length);
    const span = stop - start;
    // Where each read begins. A sliver within the budget is read end to
    // end; a longer one as evenly spaced windows, the first at its start and
    // the last ending at its end, so the sample straddles the whole sliver.
    const starts: number[] = [];
    if (span <= budget) {
      for (let at = start; at < stop; at += window) starts.push(at);
    } else {
      const windows = Math.max(1, Math.floor(budget / window));
      const last = stop - window;
      for (let w = 0; w < windows; w++)
        starts.push(windows === 1 ? start : start + Math.floor((w * (last - start)) / (windows - 1)));
    }
    let sum = 0;
    let count = 0;
    for (let channel = 0; channel < lane.numberOfChannels; channel++) {
      for (const at of starts) {
        const length = Math.min(window, stop - at);
        // Never ask for frames past the lane's end: the phone's AudioBuffer
        // throws ("Not enough data to copy from source") on a destination
        // longer than what is left, where the Web Audio spec would copy the
        // remainder — and it sizes the destination by its UNDERLYING array
        // buffer, so a subarray view does not help. The tail of a sliver
        // gets an array of exactly its span.
        const target = length === scratch.length ? scratch : new Float32Array(length);
        lane.copyFromChannel(target, channel, at);
        for (let k = 0; k < length; k++) {
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
