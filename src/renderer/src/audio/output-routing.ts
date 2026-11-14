import { t } from '../i18n'
import { outputLabelKey } from '../../../shared/output-device-policy'

export type PlaybackOutputId = string | undefined

/** The status line while the playback route is unconfirmed, in the current language. */
export const playbackOutputUnconfirmedCopy = (): string => t('settings.output.unconfirmedStatus')

export type PlaybackOutputReconcileResult =
  | { kind: 'applied'; outputId: PlaybackOutputId }
  | { kind: 'missing'; outputId: string }
  | { kind: 'stale' }

export class PlaybackOutputSelectionError extends Error {
  constructor(
    readonly causeValue: unknown,
    readonly current: boolean,
    /** The direct rollback could not prove the committed physical route. The
     * caller must await a current reconcile before treating the route as
     * confirmed. */
    readonly repairRequired = false,
    /** Intent generation restored by the failed rollback. Only this exact
     * generation may be repaired; a newer direct pick always wins. */
    readonly repairVersion?: number
  ) {
    super(causeValue instanceof Error ? causeValue.message : String(causeValue))
    this.name = 'PlaybackOutputSelectionError'
  }
}

interface PlaybackOutputArbiterDependencies {
  setOutput: (uid: string) => Promise<void>
  enumerateOutputs: () => Promise<readonly { uid: string }[]>
  commit: (outputId: PlaybackOutputId) => void
}

/** App-lifetime record of a playback route that could not be confirmed after
 * both rollback and authoritative repair failed. It stays unconfirmed (and the
 * app refuses to start new song playback) until a current route operation
 * positively confirms a sink. Repeated failures are idempotent. */
export class PlaybackOutputRouteSafety {
  private unconfirmedValue = false

  constructor(
    private readonly onUnconfirmedChange: (unconfirmed: boolean) => void
  ) {}

  get unconfirmed(): boolean {
    return this.unconfirmedValue
  }

  retainUnconfirmed(): void {
    if (this.unconfirmedValue) return
    this.unconfirmedValue = true
    this.onUnconfirmedChange(true)
  }

  /** Call only for a current `applied`/`missing` reconcile result or a direct
   * selection that returned true. Stale/superseded operations deliberately do
   * not cross this boundary. */
  confirmCurrentRoute(): void {
    if (!this.unconfirmedValue) return
    this.unconfirmedValue = false
    this.onUnconfirmedChange(false)
  }
}

/** One app-lifetime, serialized authority for native playback routing.
 *
 * A direct user choice establishes desired intent and its version before any
 * asynchronous native route change starts. Inventory may run concurrently so a
 * direct choice never waits behind a stalled enumeration; only physical sink
 * writes serialize. Every await is followed by a version check, so an older
 * inventory result cannot write a sink after a newer pick, while an already
 * pending old sink write is followed by the newest one. A failed current pick
 * restores the last committed intent before the caller's awaited repair runs,
 * keeping the controlled preference truthful without an unowned late write. */
export class PlaybackOutputArbiter {
  private desiredOutputId: PlaybackOutputId
  private committedOutputId: PlaybackOutputId
  private intentVersion = 0
  private reconcileRequest = 0
  private routeTail: Promise<void> = Promise.resolve()

  constructor(
    initialOutputId: PlaybackOutputId,
    private readonly dependencies: PlaybackOutputArbiterDependencies
  ) {
    this.desiredOutputId = initialOutputId
    this.committedOutputId = initialOutputId
  }

  /** Apply-then-commit. false means a newer direct selection superseded this
   * one; it is not an error and must not overwrite that selection's status. */
  select(outputId: PlaybackOutputId, persist = true): Promise<boolean> {
    const version = ++this.intentVersion
    // Direct intent invalidates all older boot/device inventory immediately.
    this.reconcileRequest += 1
    this.desiredOutputId = outputId
    return this.enqueueRoute(async () => {
      if (!this.current(version)) return false
      try {
        await this.dependencies.setOutput(outputId ?? '')
      } catch (error) {
        if (!this.current(version)) {
          throw new PlaybackOutputSelectionError(error, false)
        }

        // A superseded selection can have changed the physical sink without
        // committing it (B succeeded, then current C failed). Restore the last
        // committed route A now, inside this serialized sink operation. Merely
        // changing desired intent would leave physical playback on B.
        const rollbackOutputId = this.committedOutputId
        this.desiredOutputId = rollbackOutputId
        const rollbackVersion = ++this.intentVersion
        let rollbackFailed = false
        try {
          await this.dependencies.setOutput(rollbackOutputId ?? '')
        } catch {
          rollbackFailed = true
        }

        // A newer direct D selected during rollback owns the next queued sink
        // write and its UI status. The older C failure is stale by then.
        const current = this.current(rollbackVersion)
        const repairRequired = rollbackFailed && current
        throw new PlaybackOutputSelectionError(
          error,
          current,
          repairRequired,
          repairRequired ? rollbackVersion : undefined
        )
      }
      if (!this.current(version)) return false
      this.committedOutputId = outputId
      if (persist) this.dependencies.commit(outputId)
      return true
    })
  }

  /** Migrate only if no direct choice arrived while inventory was loading. */
  async migrateLegacy(resolve: (id: string) => Promise<string | undefined>, legacyId?: string): Promise<'migrated' | 'missing' | 'stale'> {
    const id = legacyId ?? this.desiredOutputId
    if (!id) return 'stale'
    const version = this.intentVersion
    const uid = await resolve(id)
    if (!this.current(version)) return 'stale'
    if (!(await this.select(uid, !!uid))) return 'stale'
    return uid ? 'migrated' : 'missing'
  }

  /** Boot and device-change repair. The desired output is deliberately read
   * from the arbiter, not captured from a render or saved-preference closure. */
  async reconcile(): Promise<PlaybackOutputReconcileResult> {
    const request = ++this.reconcileRequest
    while (request === this.reconcileRequest) {
      const version = this.intentVersion
      const outputId = this.desiredOutputId
      if (outputId) {
        let devices: readonly { uid: string }[]
        try {
          devices = await this.dependencies.enumerateOutputs()
        } catch (error) {
          // Inventory belongs to both the reconcile request and the direct
          // intent it inspected. A later request/pick makes its rejection
          // stale just as surely as a late successful inventory result.
          if (
            request !== this.reconcileRequest || !this.current(version)
          ) return { kind: 'stale' }
          throw error
        }
        if (request !== this.reconcileRequest) return { kind: 'stale' }
        if (!this.current(version)) continue
        if (!devices.some((device) =>
          device.uid === outputId
        )) {
          const result = await this.enqueueRoute(async () => {
            if (request !== this.reconcileRequest) return 'stale' as const
            if (!this.current(version)) return 'retry' as const
            try {
              await this.dependencies.setOutput('')
            } catch (error) {
              if (
                request !== this.reconcileRequest || !this.current(version)
              ) return 'stale' as const
              throw error
            }
            if (request !== this.reconcileRequest) return 'stale' as const
            if (!this.current(version)) return 'retry' as const
            return 'applied' as const
          })
          if (result === 'stale') return { kind: 'stale' }
          if (result === 'retry') continue
          return { kind: 'missing', outputId }
        }
      }
      if (request !== this.reconcileRequest) return { kind: 'stale' }
      if (!this.current(version)) continue
      const result = await this.enqueueRoute(async () => {
        if (request !== this.reconcileRequest) return 'stale' as const
        if (!this.current(version)) return 'retry' as const
        try {
          await this.dependencies.setOutput(outputId ?? '')
        } catch (error) {
          if (
            request !== this.reconcileRequest || !this.current(version)
          ) return 'stale' as const
          throw error
        }
        if (request !== this.reconcileRequest) return 'stale' as const
        if (!this.current(version)) return 'retry' as const
        return 'applied' as const
      })
      if (result === 'stale') return { kind: 'stale' }
      if (result === 'retry') continue
      return { kind: 'applied', outputId }
    }
    return { kind: 'stale' }
  }

  /** Awaited repair for the exact committed intent whose direct rollback
   * failed. Unlike device-change reconcile, another inventory request cannot
   * invalidate this operation and leave its physical sink write unowned. */
  async repairSelectionFailure(
    failure: PlaybackOutputSelectionError
  ): Promise<PlaybackOutputReconcileResult> {
    const version = failure.repairVersion
    if (!failure.repairRequired || version === undefined || !this.current(version)) {
      return { kind: 'stale' }
    }
    // Retire inventory work that inspected the failed selection. A later
    // devicechange may still verify the same current intent independently.
    this.reconcileRequest += 1
    const outputId = this.desiredOutputId
    if (outputId) {
      let devices: readonly { uid: string }[]
      try {
        devices = await this.dependencies.enumerateOutputs()
      } catch (error) {
        if (!this.current(version)) return { kind: 'stale' }
        throw error
      }
      if (!this.current(version)) return { kind: 'stale' }
      if (!devices.some((device) =>
        device.uid === outputId
      )) {
        return this.enqueueRoute(async () => {
          if (!this.current(version)) return { kind: 'stale' } as const
          try {
            await this.dependencies.setOutput('')
          } catch (error) {
            if (!this.current(version)) return { kind: 'stale' } as const
            throw error
          }
          if (!this.current(version)) return { kind: 'stale' } as const
          return { kind: 'missing', outputId } as const
        })
      }
    }
    return this.enqueueRoute(async () => {
      if (!this.current(version)) return { kind: 'stale' } as const
      try {
        await this.dependencies.setOutput(outputId ?? '')
      } catch (error) {
        if (!this.current(version)) return { kind: 'stale' } as const
        throw error
      }
      if (!this.current(version)) return { kind: 'stale' } as const
      return { kind: 'applied', outputId } as const
    })
  }

  private current(version: number): boolean {
    return version === this.intentVersion
  }

  private enqueueRoute<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.routeTail.then(operation, operation)
    this.routeTail = result.then(() => undefined, () => undefined)
    return result
  }
}

/** Small compatibility helper for isolated route applications. App.tsx uses
 * PlaybackOutputArbiter so direct and reconciliation paths share authority. */
export async function applyPlaybackOutputSelection(
  id: PlaybackOutputId,
  setOutput: (uid: string) => Promise<void>,
  commit: (id: PlaybackOutputId) => void
): Promise<void> {
  await setOutput(id ?? '')
  commit(id)
}

/** Map legacy Chromium output IDs only when both device names are unambiguous. */
export function nativeOutputUidForBrowser(
  id: string,
  browser: readonly { id: string; label: string }[],
  native: readonly { uid: string; label: string; outputChannels: number }[]
): string | undefined {
  // Historical builds persisted native:<uid> in the browser output preference.
  // Strip only that obsolete wrapper; a native UID may itself contain colons or commas.
  const uid = id.startsWith('native:') ? id.slice(7) : id
  const direct = native.filter(row => row.uid === uid && row.outputChannels > 0)
  if (direct.length === 1) return direct[0].uid
  const selected = browser.find(row => row.id === id)
  const label = selected ? outputLabelKey(selected.label) : ''
  if (!label) return undefined
  // Chromium lists system-default/communications aliases alongside the same
  // physical endpoint. Only distinct concrete endpoints create ambiguity.
  const endpoints = browser.filter(row => outputLabelKey(row.label) === label &&
    row.id !== 'default' && row.id !== 'communications')
  if (endpoints.length > 1) return undefined
  const matches = native.filter(row => row.outputChannels > 0 && outputLabelKey(row.label) === label)
  return matches.length === 1 ? matches[0].uid : undefined
}


/** Provider device UIDs occupy separate namespaces; match only unique labels. */
export function remapNativeOutputUid(
  uid: string,
  from: readonly { uid: string; label: string; outputChannels: number }[],
  to: readonly { uid: string; label: string; outputChannels: number }[]
): string | undefined {
  const source = from.filter(row => row.uid === uid && row.outputChannels > 0)
  if (source.length !== 1) return undefined
  const label = outputLabelKey(source[0].label)
  if (!label || from.filter(row => row.outputChannels > 0 && outputLabelKey(row.label) === label).length !== 1) return undefined
  const matches = to.filter(row => row.outputChannels > 0 && outputLabelKey(row.label) === label)
  return matches.length === 1 ? matches[0].uid : undefined
}


type OutputInventoryDevice = { uid: string; label: string; outputChannels: number }
/** Clear the old namespace before applying a mapped UID in the new one. */
export async function switchPlaybackProvider(
  previous: 'wasapi' | 'asio', next: 'wasapi' | 'asio', uid: string | undefined,
  deps: {
    inventory: (provider: 'wasapi' | 'asio') => Promise<readonly OutputInventoryDevice[]>
    select: (id: PlaybackOutputId) => Promise<boolean>
    setProvider: (provider: 'wasapi' | 'asio') => void
  }
): Promise<'mapped' | 'missing' | 'stale'> {
  let mapped: string | undefined
  if (uid) {
    try {
      const [from, to] = await Promise.all([deps.inventory(previous), deps.inventory(next)])
      mapped = remapNativeOutputUid(uid, from, to)
    } catch { /* The device cannot be mapped reliably. */ }
  }
  if (!(await deps.select(undefined))) return 'stale'
  deps.setProvider(next)
  if (mapped && !(await deps.select(mapped))) return 'stale'
  return uid && !mapped ? 'missing' : 'mapped'
}
