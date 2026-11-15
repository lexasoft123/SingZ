// Settings physical-route edit serialization. These helpers outlived the
// retired exclusive headphone-monitor preview (ADR 0010): the microphone
// preview still has to be stopped before a route edit and reopened after it.

export type RouteStopOutcome =
  | { ok: true; safeToRestartPreview: true }
  | { ok: false; safeToRestartPreview: false; error: string }

interface SettingsRouteApplication {
  apply: () => void | Promise<void>
  inputRouteIntentId: number | null
  inputRouteSignature: string | null
  resolve: (applied: boolean) => void
  reject: (error: unknown) => void
}

export type SettingsPreviewRestartPolicy = 'after-drain' | 'after-props-commit'

export interface SettingsInputRouteDraft {
  nativeInputUid: string | undefined
  inputId: string | undefined
  inputChannel: number
}

export function settingsInputDeviceRoute(
  nativeInputUid: string | undefined,
  inputId: string | undefined,
): SettingsInputRouteDraft {
  return { nativeInputUid, inputId, inputChannel: 0 }
}

export function settingsInputChannelRoute(
  current: SettingsInputRouteDraft,
  inputChannel: number
): SettingsInputRouteDraft {
  return { ...current, inputChannel }
}

export function settingsInputRouteSignature(route: SettingsInputRouteDraft): string {
  return `${route.nativeInputUid ?? ''}\u0000${route.inputId ?? ''}\u0000${route.inputChannel}`
}

export type SettingsInputPropCommitDecision = 'unrelated' | 'wait-for-drain' | 'release'

/** Pure decision helpers remain exported for route-state regression tests;
 * production ownership lives in SettingsRouteApplicationQueue. */
export function settingsPreviewRestartDecision(
  restartAfterDrain: boolean,
  deferredInputRoute: string | null,
  renderedInputRoute: string
): 'restart' | 'wait-for-props' {
  return restartAfterDrain || (
    deferredInputRoute !== null && deferredInputRoute === renderedInputRoute
  ) ? 'restart' : 'wait-for-props'
}

export function settingsInputPropCommitDecision(
  deferredInputRoute: string | null,
  renderedInputRoute: string,
  routeApplicationBusy: boolean
): SettingsInputPropCommitDecision {
  if (deferredInputRoute === null || deferredInputRoute !== renderedInputRoute) {
    return 'unrelated'
  }
  return routeApplicationBusy ? 'wait-for-drain' : 'release'
}

interface DeferredSettingsInputRoute {
  id: number
  signature: string
  acknowledged: boolean
}

/** Settings route edits run in invocation order. One cleanup boundary (the
 * mounted preview capture stopping) precedes the whole drain, and preview restart is emitted only after the last
 * queued edit. Later edits therefore cannot race or be overwritten by an
 * earlier asynchronous completion. */
export class SettingsRouteApplicationQueue {
  private readonly pending: SettingsRouteApplication[] = []
  private readonly previewRestartListeners = new Set<() => void>()
  private readonly busyListeners = new Set<() => void>()
  private lastPublishedBusy = false
  private draining = false
  private afterDrain: ((restartPreview: boolean) => void) | null = null
  private restartAfterDrain = true
  private desiredInputRoute: SettingsInputRouteDraft | null = null
  private renderedInputRoute: SettingsInputRouteDraft | null = null
  private deferredInputRoute: DeferredSettingsInputRoute | null = null
  private nextInputRouteIntentId = 1
  get busy(): boolean {
    return this.draining || this.pending.length > 0
  }

  /** Stable external-store hooks let a remounted Settings route observe an
   * app-lifetime operation settling even when no controlled preference or
   * safety verdict changes. Notifications are limited to actual idle/busy
   * edges, so route internals cannot turn into renderer polling churn. */
  readonly busySnapshot = (): boolean => this.busy

  readonly subscribeBusy = (listener: () => void): (() => void) => {
    this.busyListeners.add(listener)
    return () => this.busyListeners.delete(listener)
  }

  get hasDeferredInputIntent(): boolean {
    return this.deferredInputRoute !== null
  }

  /** Return the invocation-order desired route. Rendered controlled props may
   * refresh it only when no input intent is waiting for acknowledgement. */
  inputRouteDraft(rendered: SettingsInputRouteDraft): SettingsInputRouteDraft {
    if (this.deferredInputRoute === null) this.desiredInputRoute = rendered
    return this.desiredInputRoute ?? rendered
  }

  /** Record a desired input edit before it enters the async route queue. This
   * app-lifetime state deliberately survives Settings unmount/remount. */
  deferInputRoute(route: SettingsInputRouteDraft): string {
    const signature = settingsInputRouteSignature(route)
    this.desiredInputRoute = route
    this.deferredInputRoute = {
      id: this.nextInputRouteIntentId++,
      signature,
      // Selecting the already-rendered signature (for example A -> B -> A)
      // needs no future React state change to prove the final route.
      acknowledged: this.renderedInputRoute !== null &&
        settingsInputRouteSignature(this.renderedInputRoute) === signature
    }
    return signature
  }

  /** A layout-effect calls this only for committed props. Stale controlled
   * renders remain useful as failure rollback state, but cannot overwrite the
   * desired draft or release a different deferred intent. */
  acknowledgeRenderedInputRoute(
    rendered: SettingsInputRouteDraft
  ): SettingsInputPropCommitDecision {
    this.renderedInputRoute = rendered
    const deferred = this.deferredInputRoute
    const signature = settingsInputRouteSignature(rendered)
    if (deferred === null) {
      this.desiredInputRoute = rendered
      return 'unrelated'
    }
    if (deferred.signature !== signature) return 'unrelated'
    deferred.acknowledged = true
    this.desiredInputRoute = rendered
    if (this.busy) return 'wait-for-drain'
    this.deferredInputRoute = null
    this.emitPreviewRestart()
    return 'release'
  }

  subscribePreviewRestart(listener: () => void): () => void {
    this.previewRestartListeners.add(listener)
    return () => this.previewRestartListeners.delete(listener)
  }

  schedule(
    stop: () => Promise<RouteStopOutcome>,
    apply: () => void | Promise<void>,
    afterDrain: (restartPreview: boolean) => void,
    restartPolicy: SettingsPreviewRestartPolicy = 'after-drain',
    inputRouteSignature: string | null = null
  ): Promise<boolean> {
    // One input edit makes the entire overlapping batch prop-boundary-owned.
    // An output edit queued after it must not resurrect the old input preview.
    this.restartAfterDrain &&= restartPolicy === 'after-drain'
    this.afterDrain = afterDrain
    const inputRouteIntentId = inputRouteSignature !== null &&
      this.deferredInputRoute?.signature === inputRouteSignature
      ? this.deferredInputRoute.id
      : null
    const result = new Promise<boolean>((resolve, reject) => {
      this.pending.push({
        apply,
        inputRouteIntentId,
        inputRouteSignature,
        resolve,
        reject
      })
    })
    this.publishBusyIfChanged()
    if (!this.draining) void this.drain(stop)
    return result
  }

  private async drain(stop: () => Promise<RouteStopOutcome>): Promise<void> {
    this.draining = true
    let safe = false
    try {
      safe = (await stop()).safeToRestartPreview
    } catch {
      safe = false
    }

    while (this.pending.length > 0) {
      const operation = this.pending.shift()!
      if (!safe) {
        this.retireFailedInputRoute(
          operation.inputRouteIntentId,
          operation.inputRouteSignature
        )
        operation.resolve(false)
        continue
      }
      try {
        await operation.apply()
        operation.resolve(true)
      } catch (error) {
        this.retireFailedInputRoute(
          operation.inputRouteIntentId,
          operation.inputRouteSignature
        )
        operation.reject(error)
      }
    }

    this.draining = false
    this.publishBusyIfChanged()
    const notify = this.afterDrain
    const deferred = this.deferredInputRoute
    const restartPreview = safe && (
      deferred === null
        ? this.restartAfterDrain
        : deferred.acknowledged
    )
    if (restartPreview && deferred?.acknowledged) this.deferredInputRoute = null
    this.afterDrain = null
    this.restartAfterDrain = true
    if (safe) {
      notify?.(restartPreview)
      if (restartPreview) this.emitPreviewRestart()
    }
    // Scheduling is synchronous, but the drain callback may enqueue another
    // route. Start a fresh cleanup boundary for that new batch.
    if (this.pending.length > 0 && !this.draining) void this.drain(stop)
  }

  private retireFailedInputRoute(id: number | null, signature: string | null): void {
    if (
      id === null || signature === null ||
      this.deferredInputRoute?.id !== id ||
      this.deferredInputRoute.signature !== signature
    ) return
    this.deferredInputRoute = null
    // The requested input never committed. A safe queue boundary may reopen
    // the last rendered route even though this batch originally waited for
    // input props.
    this.restartAfterDrain = true
    if (this.renderedInputRoute !== null) this.desiredInputRoute = this.renderedInputRoute
  }

  private emitPreviewRestart(): void {
    for (const listener of this.previewRestartListeners) {
      try { listener() } catch { /* a remounted view cannot corrupt queue ownership */ }
    }
  }

  private publishBusyIfChanged(): void {
    const busy = this.busy
    if (busy === this.lastPublishedBusy) return
    this.lastPublishedBusy = busy
    for (const listener of this.busyListeners) {
      try { listener() } catch { /* view failures cannot corrupt queue ownership */ }
    }
  }
}

