import {
  laneSliverLevels,
  LANE_LEVEL_SLIVER_BUDGET,
  LANE_LEVEL_WINDOW,
} from '../src/playback/lane-levels';

/** A lane whose samples are a function of the frame index, read in windows
 *  the way an AudioBuffer is. */
function lane(length: number, channels: number, sample: (frame: number, channel: number) => number) {
  return {
    length,
    numberOfChannels: channels,
    /** Frames handed out so far, over every channel — the work done. */
    framesRead: 0,
    copyFromChannel(destination: Float32Array, channel: number, start: number) {
      // The phone's AudioBuffer refuses a read past its end (the screen's old
      // scan clamped its window for that reason); the fake refuses the same
      // way, so a read that would throw on a device throws here.
      // …and it sizes the destination by its underlying ArrayBuffer, so a
      // subarray view is refused like the full array would be.
      const asked = destination.buffer.byteLength / Float32Array.BYTES_PER_ELEMENT;
      if (start + asked > length)
        throw new RangeError(`copyFromChannel past the end: ${start}+${asked} > ${length}`);
      for (let k = 0; k < destination.length; k++) destination[k] = sample(start + k, channel);
      this.framesRead += destination.length;
    },
  };
}

describe('legacy lane levels', () => {
  it('is the RMS of every sample in the sliver over all channels — the native core’s statistic', () => {
    // A full-scale-ish sine: RMS = A/√2 in every sliver, not the peak A.
    const A = 0.5;
    const sr = 48_000;
    const frames = sr * 4;
    const levels = laneSliverLevels(
      lane(frames, 2, f => A * Math.sin((2 * Math.PI * 440 * f) / sr)),
      frames,
      8,
      undefined,
      Number.POSITIVE_INFINITY,
    );
    for (const level of levels) expect(level).toBeCloseTo(A / Math.SQRT2, 3);
  });

  it('weighs the whole sliver, not its first window', () => {
    // Silence for the first 90% of every sliver and a 0.8 burst at its end:
    // one 2048-frame window at the sliver start read this as silence.
    const frames = 96_000;
    const sliverFrames = frames / 4;
    const levels = laneSliverLevels(
      lane(frames, 1, f => (f % sliverFrames >= sliverFrames * 0.9 ? 0.8 : 0)),
      frames,
      4,
      undefined,
      Number.POSITIVE_INFINITY,
    );
    for (const level of levels) expect(level).toBeCloseTo(0.8 * Math.sqrt(0.1), 2);
  });

  it('computes a sliver range into a shared array, so a screen can spread the scan over ticks', () => {
    const frames = 48_000 * 10;
    const src = lane(frames, 1, f => (f < frames / 2 ? 0.1 : 0.4));
    const into = new Float32Array(4);
    laneSliverLevels(src, frames, 4, undefined, undefined, into, 0, 2);
    expect(Array.from(into).map(v => +v.toFixed(3))).toEqual([0.1, 0.1, 0, 0]);
    laneSliverLevels(src, frames, 4, undefined, undefined, into, 2, 4);
    expect(Array.from(into).map(v => +v.toFixed(3))).toEqual([0.1, 0.1, 0.4, 0.4]);
  });

  it('reads a bursty lane to within a few percent under the budget', () => {
    // Drum-like: 3000-frame hits every 24 000 frames. Eight 1024-frame windows
    // per sliver missed whole hits (a sliver read 0.018 where the full scan
    // read 0.071 — the play-from-anywhere driver caught it at 74% out); the
    // shipped window/budget read this within 2.2% worst in the study.
    const frames = 48_000 * 60;
    const hit = (f: number) => {
      const k = f % 24_000;
      return k < 3000 ? 0.6 * Math.exp(-k / 800) * Math.sin(k * 0.3) : 0;
    };
    const full = laneSliverLevels(lane(frames, 1, hit), frames, 24, undefined, Number.POSITIVE_INFINITY);
    const bounded = laneSliverLevels(lane(frames, 1, hit), frames, 24);
    let worst = 0;
    for (let i = 0; i < 24; i++) worst = Math.max(worst, Math.abs(bounded[i] - full[i]) / full[i]);
    // 2.5 s slivers here (the study's were 1.27 s): 6.3% worst, against the
    // bar's 10% parity check and the 100% the old windows produced.
    expect(worst).toBeLessThan(0.1);
  });

  it('reads at most the budget per channel per sliver, however long the song', () => {
    // Build 51 read every sample: a four-minute six-stem song was ~140 M
    // Hermes iterations on the JS thread, and reached a phone as a player
    // with no histogram and a Play that answered seconds late.
    const frames = 48_000 * 240;
    const stereo = lane(frames, 2, () => 0.25);
    const levels = laneSliverLevels(stereo, frames, 96);
    expect(stereo.framesRead).toBeLessThanOrEqual(96 * 2 * LANE_LEVEL_SLIVER_BUDGET);
    expect(stereo.framesRead).toBeGreaterThan(0);
    for (const level of levels) expect(level).toBeCloseTo(0.25, 6);
  });

  it('samples the whole sliver when bounded, so a late burst still shows and a sine reads its RMS', () => {
    const frames = 48_000 * 60;
    const sliverFrames = frames / 24;
    expect(sliverFrames).toBeGreaterThan(LANE_LEVEL_SLIVER_BUDGET);
    const sr = 48_000;
    const sine = laneSliverLevels(lane(frames, 1, f => 0.5 * Math.sin((2 * Math.PI * 440 * f) / sr)), frames, 24);
    for (const level of sine) expect(level).toBeCloseTo(0.5 / Math.SQRT2, 2);
    // The last 10% of every sliver is a 0.8 burst: the first window alone
    // reads silence, a spread of windows reads the burst at about its weight.
    const burst = laneSliverLevels(
      lane(frames, 1, f => (f % sliverFrames >= sliverFrames * 0.9 ? 0.8 : 0)),
      frames,
      24,
    );
    const full = 0.8 * Math.sqrt(0.1);
    for (const level of burst) {
      expect(level).toBeGreaterThan(full * 0.6);
      expect(level).toBeLessThan(full * 1.6);
    }
  });

  it('reads whole windows and one exact tail, never past a lane’s end', () => {
    // Slivers within the budget are read end to end, and a lane ending
    // mid-window gets a last read sized to what is left (the fake throws on
    // an over-read like the phone). 6000-frame slivers, the lane 300 short.
    const frames = 12_000;
    expect(frames / 2).toBeLessThanOrEqual(LANE_LEVEL_SLIVER_BUDGET);
    const short = lane(frames - 300, 1, () => 0.1);
    let partial = 0;
    const base = short.copyFromChannel.bind(short);
    short.copyFromChannel = (d, c, s) => {
      if (d.length < LANE_LEVEL_WINDOW) partial++;
      base(d, c, s);
    };
    const levels = laneSliverLevels(short, frames, 2);
    expect(Array.from(levels).map(v => +v.toFixed(3))).toEqual([0.1, 0.1]);
    expect(short.framesRead).toBe(frames - 300);
    // The first sliver's tail (6000 is not a multiple of 1024) and the
    // second's end at the lane's edge: two partial reads.
    expect(partial).toBe(2);
  });

  it('treats a lane shorter than the song as silent past its end, never as a repeat', () => {
    const levels = laneSliverLevels(lane(48_000, 1, () => 0.3), 96_000, 4);
    expect(Array.from(levels).map(v => +v.toFixed(3))).toEqual([0.3, 0.3, 0, 0]);
  });

  it('never exceeds 1 and ignores non-finite samples', () => {
    const levels = laneSliverLevels(lane(1000, 1, f => (f % 2 ? 3 : Number.NaN)), 1000, 2);
    expect(Array.from(levels)).toEqual([1, 1]);
  });
});
