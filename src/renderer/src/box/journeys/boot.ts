export function retryBoot(refresh: {
  preferences: () => void
  platform: () => void
  audio: () => void
  drive: () => void
}): void {
  refresh.preferences()
  refresh.platform()
  refresh.audio()
  refresh.drive()
}
