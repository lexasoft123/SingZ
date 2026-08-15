/**
 * react-native-audio-api, stubbed: the round-trip cares which bytes reach the
 * phone and how many requests it took, never what they sound like. Decoding
 * records the path it was handed so a test can prove the lanes came from the
 * cache rather than anywhere else.
 */

export interface AudioBuffer {
  length: number
  numberOfChannels: number
  sampleRate: number
  /** loadProject reads the guitar and piano lanes to hide silent ones
   *  (audibleStems, ported from the desktop) — so a decoded buffer has to
   *  offer samples, not just a shape. */
  getChannelData(channel: number): Float32Array
  /** Test-only: which file this "decode" was fed. */
  path?: string
}

export const decoded: string[] = []

/** Loud enough to sit above the silence threshold (RMS < 0.004): the
 *  round-trip is about which bytes reached the phone, so no lane should
 *  disappear on it. A test that wants a silent lane can build its own. */
const AUDIBLE = new Float32Array([0.5])

export async function decodeAudioData(path: string, sampleRate: number): Promise<AudioBuffer> {
  decoded.push(path)
  return {
    length: AUDIBLE.length,
    numberOfChannels: 2,
    sampleRate,
    path,
    getChannelData: () => AUDIBLE
  }
}

export default { decodeAudioData }
