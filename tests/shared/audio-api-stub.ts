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
  /** Test-only: which file this "decode" was fed. */
  path?: string
}

export const decoded: string[] = []

export async function decodeAudioData(path: string, sampleRate: number): Promise<AudioBuffer> {
  decoded.push(path)
  return { length: 1, numberOfChannels: 2, sampleRate, path }
}

export default { decodeAudioData }
