import { log } from '../log';
import { mobileMetronomePersistence } from './metronome-persistence';

export type MetronomeFlushReason = 'background' | 'player back' | 'unmount';

export interface MetronomeFlushStore {
  flush(): Promise<void>;
}

/**
 * Delivers an asynchronous background-flush failure only while foregrounded.
 * A flush can reject after React Native has already emitted `active`; queuing
 * a foreground tick here closes that race without touching component state.
 */
export class MetronomeBackgroundFailureDelivery {
  private pending: string | null = null;
  private active: boolean;
  private mounted = true;
  private scheduled = false;

  constructor(
    private readonly show: (message: string) => void,
    private readonly schedule: (deliver: () => void) => void = deliver => {
      setTimeout(deliver, 0);
    },
    initiallyActive = false,
  ) {
    this.active = initiallyActive;
  }

  appStateChanged(next: string): void {
    this.active = next === 'active';
    this.requestDelivery();
  }

  report(message: string): void {
    this.pending = message;
    this.requestDelivery();
  }

  unmount(): void {
    this.mounted = false;
    this.pending = null;
  }

  private requestDelivery(): void {
    if (
      !this.mounted ||
      !this.active ||
      this.pending === null ||
      this.scheduled
    )
      return;
    this.scheduled = true;
    this.schedule(() => {
      this.scheduled = false;
      if (!this.mounted || !this.active || this.pending === null) return;
      const message = this.pending;
      this.pending = null;
      this.show(message);
    });
  }
}

/**
 * One lifecycle-safe flush boundary shared by navigation and AppState.
 * Returning false lets the caller keep a route mounted or surface the failure
 * after the app becomes active again; errors never become unhandled promises.
 */
export async function flushMetronomeForLifecycle(
  reason: MetronomeFlushReason,
  options: {
    readonly store?: MetronomeFlushStore;
    readonly onFailure?: (message: string) => void;
  } = {},
): Promise<boolean> {
  try {
    await (options.store ?? mobileMetronomePersistence).flush();
    return true;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    const failure = `Metronome settings could not be saved on ${reason}: ${detail}`;
    log('metronome', failure, 'error');
    options.onFailure?.(failure);
    return false;
  }
}
