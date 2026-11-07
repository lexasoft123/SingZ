import type { BoxState } from '../../../../shared/box-contract'
import type { BoxCollectionController } from './BoxCollectionController'
import type { BoxQueueStore } from './queue'

/** Local identity and persisted queue state gate startup; Drive never does. */
export async function hydrateBoxLocally(
  queue: Pick<BoxQueueStore, 'hydrate'>,
  collection: Pick<BoxCollectionController, 'refreshLocal' | 'refreshAccount'>,
  refreshAccount: boolean
): Promise<{ state: BoxState | null; localReady: boolean }> {
  if (refreshAccount) {
    void Promise.resolve().then(() => collection.refreshAccount()).catch(() => undefined)
  }
  const [state, localReady] = await Promise.all([
    queue.hydrate(),
    collection.refreshLocal().then(() => true, () => false)
  ])
  return { state, localReady }
}
