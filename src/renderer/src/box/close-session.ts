import { boxCloseWork } from './collection/queue'

/** Shared by the actual main-requested close handler and its lifecycle tests.
 * The transport decides whether playback belongs to this app or a service. */
export async function closeBoxSession(
  transport: { teardown(): Promise<void> }, flush: () => Promise<void>, finish: () => void,
  timeoutMs = 8000
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const bounded = new Promise<void>(resolve => { timer = setTimeout(resolve, timeoutMs) })
    await Promise.race([boxCloseWork(() => transport.teardown(), flush), bounded])
  } catch {
    // A failed preference flush must not trap the user in a closing window.
    // Audio ownership uncertainty remains with the independent service.
  } finally { clearTimeout(timer); finish() }
}
