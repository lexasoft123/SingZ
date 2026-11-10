import type { BoxAPI, BoxPlatformCommand, BoxPlatformSnapshot, BoxResult } from '../../../../shared/box-contract'
import { tJourney } from './i18n'
import { systemCommandIssue, type SystemCommand } from './model'

export async function requestPlatformCommand(
  api: Pick<BoxAPI, 'platformSnapshot' | 'platformCommand'>,
  command: BoxPlatformCommand['type'],
  playbackActive: () => boolean,
  onSnapshot: (snapshot: BoxPlatformSnapshot) => void
): Promise<BoxResult<BoxPlatformSnapshot>> {
  const fresh = await api.platformSnapshot()
  if (!fresh.ok) return fresh
  onSnapshot(fresh.value)
  // A previously focused Wi-Fi action can race an update starting elsewhere.
  if (fresh.value.update.state === 'installing' || fresh.value.update.state === 'rollback') {
    return { ok: false, code: 'committed', error: tJourney('journey.system.committed') }
  }
  if (command.startsWith('wifi-')) {
    if (!fresh.value.available || !fresh.value.capabilities.wifi) {
      return { ok: false, code: 'unsupported', error: tJourney('journey.network.wifiUnsupported') }
    }
  } else {
    const issue = systemCommandIssue(command as SystemCommand, fresh.value, playbackActive())
    if (issue) {
      const key = issue === 'playback-active' ? 'journey.playbackActive'
        : issue === 'platform-unavailable' ? 'journey.noService' : 'journey.system.unsupported'
      return { ok: false, code: issue, error: tJourney(key) }
    }
  }
  return api.platformCommand({ type: command })
}
