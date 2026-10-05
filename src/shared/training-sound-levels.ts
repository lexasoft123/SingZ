/** Training gain calibration for the bundled FluidR3 samples, MIDI 36–84.
 * Measured over the audible 2.2 s note with the 8 ms onset/150 ms release,
 * native playback-speed mapping, and 0.6 voice gain. EBU R128 integrated
 * loudness target: -17 LUFS at reference volume 1; max volume 2 retains
 * true-peak headroom. Organ values also account for its waveshaper.
 * Apply gain only, preserving the instrument envelope. Recalibrate whenever
 * samples, voice timing or the organ registration/processing changes.
 */
export type SampleInstrument = 'piano' | 'electric' | 'guitar'
export type AuditionInstrument = SampleInstrument | 'organ'
const LEVELS: Record<AuditionInstrument, readonly number[]> = {
  piano: [
    0.987416, 0.990832, 0.997700, 1.004616, 1.013911, 1.023293, 0.939723,
    0.939723, 0.941890, 0.946237, 0.951700, 0.962720, 0.968278, 0.982879,
    0.995405, 1.012745, 1.029201, 1.047129, 0.871967, 0.884097, 0.898463,
    0.913061, 0.927897, 0.948418, 0.966051, 0.985145, 1.008092, 1.032761,
    1.032761, 1.035142, 0.826038, 0.841395, 0.857038, 0.874984, 0.892278,
    0.906776, 0.920450, 0.935406, 0.954993, 0.974990, 0.970510, 1.018591,
    0.885116, 0.898463, 0.912011, 0.927897, 0.939723, 0.954993, 0.945148,
  ],
  electric: [
    1.162787, 1.145513, 1.128496, 1.113012, 1.096478, 1.082680, 0.990832,
    0.987416, 0.980618, 0.978363, 0.973868, 0.972747, 0.969393, 0.966051,
    0.963829, 0.959401, 0.959401, 0.956093, 0.916220, 0.914113, 0.913061,
    0.913061, 0.916220, 0.916220, 0.921510, 0.928966, 0.935406, 0.945148,
    0.958297, 0.972747, 0.856052, 0.875992, 0.896396, 0.918333, 0.941890,
    0.967164, 0.969393, 0.996552, 1.000000, 1.028016, 1.028016, 1.025652,
    0.891251, 0.910961, 0.907821, 0.901571, 0.893305, 0.912011, 0.898463,
  ],
  guitar: [
    1.003460, 1.000000, 0.995405, 0.993116, 0.993116, 0.994260, 1.156112,
    1.178963, 1.202264, 1.228853, 1.254585, 1.283808, 1.318257, 1.355189,
    1.393157, 1.428894, 1.470618, 1.477406, 1.116863, 1.110453, 1.105350,
    1.135011, 1.128496, 1.114295, 1.145513, 1.132400, 1.162787, 1.141563,
    1.176251, 1.209205, 1.210598, 1.231686, 1.254585, 1.274970, 1.294196,
    1.313711, 1.333521, 1.352073, 1.367729, 1.385160, 1.399587, 1.412538,
    1.289734, 1.312200, 1.289734, 1.315225, 1.288250, 1.316740, 1.286767,
  ],
  organ: [
    0.478630, 0.465586, 0.453942, 0.443609, 0.435011, 0.427563, 0.419276,
    0.413048, 0.406912, 0.399945, 0.397192, 0.393550, 0.390391, 0.385478,
    0.382384, 0.381505, 0.377572, 0.377138, 0.373250, 0.372392, 0.372392,
    0.368978, 0.368553, 0.368978, 0.367282, 0.364754, 0.364334, 0.364334,
    0.364754, 0.364334, 0.361410, 0.360994, 0.360164, 0.360164, 0.360164,
    0.360164, 0.356862, 0.356451, 0.356041, 0.356451, 0.352777, 0.351965,
    0.352371, 0.348337, 0.348337, 0.344747, 0.344350, 0.340017, 0.339234,
  ],
}

export function sampleAuditionGain(instrument: AuditionInstrument, midi: number): number {
  const index = Math.max(0, Math.min(48, Math.round(midi) - 36))
  return LEVELS[instrument][index]
}

/** Shared organ transfer curve; sampled instruments bypass this processing. */
export function trainingOrganCurve(): Float32Array<ArrayBuffer> {
  const curve = new Float32Array(2049)
  for (let index = 0; index < curve.length; index++) {
    const input = index * 2 / (curve.length - 1) - 1
    curve[index] = Math.tanh(input * 1.55) / Math.tanh(1.55)
  }
  return curve
}
