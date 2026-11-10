import type { BoxAPI } from '../../../../shared/box-contract'
import type { DriveDeviceChallenge, DriveDeviceFailure } from '../../../../shared/drive-device'
import type { ProjectListItem, SingzApi } from '../../../../shared/types'
import type { BoxProjectInspection, BoxProjectMetadata } from '../project'

export type BoxCollectionApi = Pick<SingzApi,
  'listProjects' | 'registerSource' | 'getCachedLyrics' |
  'gdriveStatus' | 'gdriveProjects' | 'gdriveDownload' | 'gdriveCancelDownload' | 'onGdriveProgress' |
  'gdriveDeviceStart' | 'gdriveDeviceStatus' | 'gdriveDeviceCancel' | 'gdriveSignOut'
> & { storageSnapshot?: BoxAPI['storageSnapshot'] }

export interface CollectionEntry {
  id: string
  remoteId: string | null
  name: string
  local: ProjectListItem | null
  unavailable?: boolean
}

export interface CollectionInspectionRow {
  inspection?: BoxProjectInspection
  metadata?: BoxProjectMetadata
}

export type CollectionAuthPhase =
  | 'loading' | 'signed-out' | 'starting' | 'pending' | 'cancelling'
  | 'complete' | 'cancelled' | 'error'

export interface CollectionAuthState {
  phase: CollectionAuthPhase
  signedIn: boolean
  configured: boolean
  challenge: DriveDeviceChallenge | null
  error: DriveDeviceFailure | string | null
}

export interface CollectionDownloadState {
  entryId: string
  phase: 'downloading' | 'cancelling'
  msg: string
  frac: number
}

export interface CollectionSnapshot {
  entries: CollectionEntry[]
  localStatus: 'loading' | 'ready' | 'error'
  localError: string | null
  cacheError: string | null
  remoteStatus: 'idle' | 'loading' | 'ready' | 'error'
  remoteError: string | null
  rows: Record<string, CollectionInspectionRow>
  auth: CollectionAuthState
  download: CollectionDownloadState | null
}

export interface CollectionPrepareResult {
  ok: boolean
  cancelled?: boolean
  inspection?: BoxProjectInspection
  error?: string
}

export function localEntryId(dir: string): string {
  return `local:${dir}`
}

export function driveEntryId(id: string): string {
  return `drive:${id}`
}

export function collectionEntryById(entries: CollectionEntry[], id: string | null): CollectionEntry | null {
  return id === null ? null : entries.find(entry => entry.id === id) ?? null
}

export function resolveCollectionSelection(
  entries: CollectionEntry[],
  selectedId: string | null,
  previous: CollectionEntry | null,
  details: boolean
): CollectionEntry | null {
  const exact = selectedId === null ? null : entries.find(entry =>
    entry.id === selectedId || (entry.remoteId !== null && driveEntryId(entry.remoteId) === selectedId)
  ) ?? null
  if (exact) return exact
  if (selectedId !== null && previous &&
    (previous.id === selectedId || (previous.remoteId !== null && driveEntryId(previous.remoteId) === selectedId))) {
    return { ...previous, local: null, unavailable: true }
  }
  return selectedId === null && !details ? entries[0] ?? null : null
}

export function collectionEntryByLocalDir(entries: CollectionEntry[], dir: string | null): CollectionEntry | null {
  return dir === null ? null : entries.find(entry => entry.local?.dir === dir) ?? null
}

export function collectionEntryByViewDir(entries: CollectionEntry[], dir: string): CollectionEntry | null {
  return entries.find(entry => (entry.local?.dir ?? entry.id) === dir) ?? null
}

export function queueViewItem(entry: CollectionEntry): ProjectListItem {
  if (entry.local) return entry.local
  return {
    dir: entry.id,
    name: entry.name,
    songPath: '',
    savedAt: '',
    hasStems: false,
    stemCount: 0,
    hasLyrics: false,
    bytes: 0
  }
}
