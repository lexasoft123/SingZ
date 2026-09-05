import { laneSliverLevels } from '../src/playback/lane-levels';

/** A lane whose samples are a function of the frame index, read in windows
 *  the way an AudioBuffer is. */
function lane(length: number, channels: number, sample: (frame: number, channel: number) => number) {
  return {
    length,
    numberOfChannels: channels,
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
    );
    for (const level of levels) expect(level).toBeCloseTo(0.8 * Math.sqrt(0.1), 2);
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
