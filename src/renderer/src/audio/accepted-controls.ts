import type { DesktopNativeLaneControl, DesktopNativePlaybackClient } from './desktop-native-playback'

interface Lane {
  id: string
  volume: number
  muted: boolean
  solo: boolean
}

export interface AcceptedControlHost {
  schedule(): void
  epoch(): number
  native(): DesktopNativePlaybackClient | null
  lane(id: string): Lane | undefined
  applyLane(lane: Lane, accepted: DesktopNativeLaneControl): void
  applyMaster(volume: number): void
}

export async function setLaneAccepted(
  host: AcceptedControlHost,
  id: string,
  patch: { gain?: number; muted?: boolean; solo?: boolean }
): Promise<void> {
  host.schedule()
  const lane = host.lane(id)
  if (!lane) return
  const epoch = host.epoch()
  const native = host.native()
  if (native?.active) {
    const accepted = await native.updateLane(id, patch)
    if (epoch !== host.epoch()) throw new Error('The song changed before the lane control was accepted.')
    host.applyLane(lane, accepted)
    return
  }
  host.applyLane(lane, {
    gain: patch.gain ?? lane.volume,
    muted: patch.muted ?? lane.muted,
    solo: patch.solo ?? lane.solo
  })
}

export async function setMasterVolumeAccepted(host: AcceptedControlHost, volume: number): Promise<void> {
  host.schedule()
  const epoch = host.epoch()
  const native = host.native()
  if (native?.active) {
    await native.setMasterGain(volume)
    if (epoch !== host.epoch()) throw new Error('The song changed before master gain was accepted.')
  }
  host.applyMaster(volume)
}
