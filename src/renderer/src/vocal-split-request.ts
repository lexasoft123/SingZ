import type { ModelId, VocalSplitResult } from '../../shared/types'

/** A cancellation owns the whole renderer request, including IPC reads and
 * opaque decode promises that continue after the main process has finished. */
export class VocalSplitRequests {
  private revision = 0
  begin(): () => boolean {
    const revision = ++this.revision
    return () => revision === this.revision
  }
  cancel(): void { ++this.revision }
}

export function canResplitVocals(
  pendingLead: string | null,
  splitting: boolean,
  leadVocalSeparated: boolean
): boolean {
  return pendingLead === null && !splitting && !leadVocalSeparated
}

class DiscardedVocalSplit extends Error {}
export type CheckedAwait = <T>(operation: Promise<T>) => Promise<T>

/** Stages new audio without publishing any lane until every async boundary
 * has accepted the same request. Preparation can cancel other analyses;
 * recover restores those analyses if the request is discarded during it. */
export async function runVocalSplitRequest<T>(
  current: () => boolean,
  operations: {
    separate: () => Promise<VocalSplitResult>
    modelsRequired?: (ids: ModelId[]) => Promise<void>
    read: (path: string) => Promise<ArrayBuffer>
    decode: (bytes: ArrayBuffer) => Promise<T>
    prepare: (checked: CheckedAwait) => Promise<void>
    commit: (paths: { lead: string; backing: string }, lead: T, backing: T) => void
    recover: () => void
  }
): Promise<'committed' | 'discarded'> {
  const checked: CheckedAwait = async operation => {
    const value = await operation
    if (!current()) throw new DiscardedVocalSplit()
    return value
  }
  let prepared = false
  try {
    const paths = await checked(operations.separate())
    if (!paths.ok) {
      if (paths.cancelled) return 'discarded'
      if (paths.needsModels?.length && operations.modelsRequired) {
        await checked(operations.modelsRequired(paths.needsModels))
        return 'discarded'
      }
      throw new Error(paths.error)
    }
    const leadBytes = await checked(operations.read(paths.lead))
    const lead = await checked(operations.decode(leadBytes))
    const backingBytes = await checked(operations.read(paths.backing))
    const backing = await checked(operations.decode(backingBytes))
    prepared = true
    await checked(operations.prepare(checked))
    operations.commit(paths, lead, backing)
    return 'committed'
  } catch (error) {
    if (prepared) operations.recover()
    // Cancellation also disowns a failed read/decode that rejects late.
    if (!current() || error instanceof DiscardedVocalSplit) return 'discarded'
    throw error
  }
}

/** loadSeq also guards lyrics: cancelling its old work requires making the
 * pending state retryable before starting the lookup under the new seq. */
export function restartPendingLyrics(
  pending: boolean,
  reset: () => void,
  start: () => void
): void {
  if (!pending) return
  reset()
  start()
}


/** Cancelling the IPC only requests termination. The original lookup settles
 * after the transcriber's finally releases its single-flight busy flag. */
export async function settleCancelledLyrics(
  cancel: () => Promise<unknown>,
  pending: Promise<unknown> | null
): Promise<void> {
  try {
    await cancel()
  } finally {
    // A cancelled lookup may reject; settlement, rather than its result, is
    // the prerequisite for restarting. The owning caller disowns its output.
    await pending?.catch(() => undefined)
  }
}
