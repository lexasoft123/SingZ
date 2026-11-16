import { detectedDesktopPlatform, type DesktopNativePlaybackPolicy } from '../audio/native-playback-preference'

export function boxNativePlaybackPolicy(
  platform: ReturnType<typeof detectedDesktopPlatform> = detectedDesktopPlatform()
): DesktopNativePlaybackPolicy | undefined {
  return platform === 'linux' ? { streamLanes: true } : undefined
}
