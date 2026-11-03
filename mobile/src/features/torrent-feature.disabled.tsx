// Metro selects this module before collecting dependencies for store builds.
// Keep it independent of the enabled implementation and its native/provider code.
import type { TorrentEntryProps, TorrentScreenProps } from './torrent-feature.types'
export const torrentsEnabled = false
export function TorrentEntry(_props: TorrentEntryProps): null { return null }
export function TorrentScreen(_props: TorrentScreenProps): null { return null }
