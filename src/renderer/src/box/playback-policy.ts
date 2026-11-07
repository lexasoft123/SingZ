import { detectedDesktopPlatform, type DesktopNativePlaybackPolicy } from '../audio/native-playback-preference'

export function boxNativePlaybackPolicy(
  platform: ReturnType<typeof detectedDesktopPlatform> = detectedDesktopPlatform()
): DesktopNativePlaybackPolicy | undefined {
  return platform === 'linux' ? { playback: true, streamLanes: true, requireNative: true } : undefined
}
