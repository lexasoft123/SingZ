/** Shared Windows AudioHost inventories use raw MMDevice endpoint IDs.
 * Older native capture selections stored the same ID with a wasapi: prefix. */
export function normalizeAudioInputUid(uid: string): string {
  return uid.startsWith('wasapi:') ? uid.slice('wasapi:'.length) : uid
}
