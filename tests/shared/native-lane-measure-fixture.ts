import { DESKTOP_PLAYBACK_CAPABILITY, DESKTOP_PLAYBACK_CODEC_NATIVE_MASK, DESKTOP_PLAYBACK_CODEC_NATIVE_TAG, DESKTOP_PLAYBACK_CODEC_NATIVE_EXTENSIONS, type SingzApi } from '../../src/shared/types'

/** Device-free native measurement for transport ownership/race tests. */
export function nativeLaneMeasureFixture(read?: (path: string) => Promise<unknown>, durationSeconds = 12): Pick<SingzApi, 'desktopPlaybackCapability' | 'measureDesktopPlaybackLanes'> {
  return {
    desktopPlaybackCapability: async () => ({ available: true, playbackCapability: DESKTOP_PLAYBACK_CAPABILITY,
      mediaCodec: { abiVersion: 1, formatMask: DESKTOP_PLAYBACK_CODEC_NATIVE_MASK, capabilityTag: DESKTOP_PLAYBACK_CODEC_NATIVE_TAG,
        dynamicallyLinkedFfmpeg: false, runtimeVersion: '', target: '', profile: '', extensions: [...DESKTOP_PLAYBACK_CODEC_NATIVE_EXTENSIONS] } }),
    measureDesktopPlaybackLanes: async request => ({ ok: true, error: '', lanes: await Promise.all(request.lanes.map(async lane => {
      await read?.(lane.path)
      return { id: lane.id, ok: true, error: '', sampleRate: 48000, channels: 1, frameCount: durationSeconds * 48000,
        durationSeconds, rms: .1, peaks: new Float32Array([.1, .2]), envelope: new Float32Array(96).fill(.1) }
    })) })
  }
}
