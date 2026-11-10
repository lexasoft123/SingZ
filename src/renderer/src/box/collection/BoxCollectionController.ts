import type { DriveDeviceChallenge } from '../../../../shared/drive-device'
import type { ProjectListItem } from '../../../../shared/types'
import type { SingzApi } from '../../../../shared/types'
import { inspectBoxProject, projectMetadata, type BoxProjectInspection } from '../project'
import { tCollection } from './i18n'
import {
  driveEntryId,
  localEntryId,
  type BoxCollectionApi,
  type CollectionEntry,
  type CollectionPrepareResult,
  type CollectionSnapshot
} from './types'

interface DownloadJob {
  epoch: number
  entryId: string
  remoteId: string
  cancelled: boolean
  promise: Promise<CollectionPrepareResult>
  settle: () => void
  settled: Promise<void>
}

export class BoxCollectionController {
  private localItems: ProjectListItem[] = []
  private remoteItems: { id: string; name: string; songPath?: string }[] = []
  private cachedDriveIds = new Map<string, string>()
  private localGeneration = 0
  private remoteGeneration = 0
  private inspectionGenerations = new Map<string, number>()
  private authGeneration = 0
  private downloadGeneration = 0
  private authTimer: ReturnType<typeof setTimeout> | null = null
  private authChallenge: DriveDeviceChallenge | null = null
  private cancelAuthContext: { generation: number } | null = null
  private downloadJob: DownloadJob | null = null
  private progressUnsubscribe: (() => void) | null = null
  private disposed = false
  private readonly listeners = new Set<() => void>()
  private snapshot: CollectionSnapshot = {
    entries: [],
    localStatus: 'loading',
    localError: null,
    cacheError: null,
    remoteStatus: 'idle',
    remoteError: null,
    rows: {},
    auth: { phase: 'loading', signedIn: false, configured: false, challenge: null, error: null },
    download: null
  }

  constructor(private readonly api: BoxCollectionApi) {}

  getSnapshot = (): CollectionSnapshot => this.snapshot

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private publish(patch: Partial<CollectionSnapshot> = {}): void {
    if (this.disposed) return
    const entries = this.mergeEntries()
    this.snapshot = { ...this.snapshot, entries, ...patch }
    for (const listener of this.listeners) listener()
  }

  private mergeEntries(): CollectionEntry[] {
    const entries: CollectionEntry[] = this.localItems.map(local => ({
      id: localEntryId(local.dir),
      remoteId: this.cachedDriveIds.get(local.dir) ?? null,
      name: local.name,
      local
    }))
    const byPath = new Map(this.localItems.map(item => [item.songPath, item]))
    const matched = new Set<string>()
    const claim = (local: ProjectListItem | undefined, remoteId: string): boolean => {
      const entry = local && entries.find(candidate => candidate.id === localEntryId(local.dir))
      if (!entry || matched.has(entry.id)) return false
      entry.remoteId = remoteId
      matched.add(entry.id)
      return true
    }
    // Exact cache identities claim local copies before weaker song-path matches.
    const unclaimed = this.remoteItems.filter(remote =>
      !claim(this.localItems.find(item => this.cachedDriveIds.get(item.dir) === remote.id), remote.id))
    for (const remote of unclaimed) {
      if (claim(remote.songPath ? byPath.get(remote.songPath) : undefined, remote.id)) continue
      // A Drive project that cannot own a local copy stays visible as its own row.
      entries.push({ id: driveEntryId(remote.id), remoteId: remote.id, name: remote.name, local: null })
    }
    return entries
  }

  private errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error)
  }

  async initialize(): Promise<void> {
    await Promise.all([this.refreshLocal(), this.refreshAccount()])
  }

  async refreshLocal(isCurrent: () => boolean = () => true): Promise<ProjectListItem[]> {
    const generation = ++this.localGeneration
    this.publish({ localStatus: 'loading', localError: null })
    try {
      const result = await this.api.listProjects()
      let cacheError: string | null = null
      let cachedDriveIds: Map<string, string> | null = null
      if (this.api.storageSnapshot) {
        try {
          const storage = await this.api.storageSnapshot()
          if (storage.ok) cachedDriveIds = new Map(storage.value.projects.map(item => [item.dir, item.driveId]))
          else cacheError = storage.error
        } catch (error) {
          cacheError = this.errorMessage(error)
        }
      }
      if (generation !== this.localGeneration || this.disposed) return result.projects
      if (cachedDriveIds !== null) this.cachedDriveIds = cachedDriveIds
      this.localItems = result.projects
      const rows = { ...this.snapshot.rows }
      const valid = new Set(result.projects.map(item => localEntryId(item.dir)))
      for (const id of Object.keys(rows)) if (id.startsWith('local:') && !valid.has(id)) delete rows[id]
      this.publish({ localStatus: 'ready', localError: null, cacheError, rows })
      let cursor = 0
      const worker = async (): Promise<void> => {
        while (cursor < result.projects.length && generation === this.localGeneration && !this.disposed && isCurrent()) {
          const item = result.projects[cursor++]
          await this.inspectLocal(item, isCurrent)
        }
      }
      await Promise.all(Array.from({ length: Math.min(4, result.projects.length) }, () => worker()))
      return result.projects
    } catch (error) {
      if (generation === this.localGeneration) {
        this.publish({ localStatus: 'error', localError: this.errorMessage(error) })
      }
      throw error
    }
  }

  async refreshAccount(): Promise<void> {
    const generation = ++this.authGeneration
    try {
      const status = await this.api.gdriveStatus()
      if (generation !== this.authGeneration || this.disposed) return
      this.authChallenge = null
      this.publish({
        auth: {
          phase: status.signedIn ? 'complete' : 'signed-out',
          signedIn: status.signedIn,
          configured: status.deviceSignInConfigured,
          challenge: null,
          error: null
        }
      })
      if (status.signedIn) await this.refreshRemote()
      else {
        ++this.remoteGeneration
        this.remoteItems = []
        this.publish({ remoteStatus: 'idle', remoteError: null })
      }
    } catch (error) {
      if (generation !== this.authGeneration) return
      this.publish({
        auth: {
          ...this.snapshot.auth,
          phase: this.snapshot.auth.signedIn ? 'complete' : 'error',
          error: this.errorMessage(error)
        }
      })
    }
  }

  async refreshRemote(): Promise<void> {
    const generation = ++this.remoteGeneration
    this.publish({ remoteStatus: 'loading', remoteError: null })
    try {
      const result = await this.api.gdriveProjects()
      if (generation !== this.remoteGeneration || this.disposed) return
      if (!result.ok) {
        this.publish({
          remoteStatus: 'error',
          remoteError: result.error ?? tCollection('collection.driveReadFailed')
        })
        return
      }
      this.remoteItems = result.projects
      this.publish({ remoteStatus: 'ready', remoteError: null })
    } catch (error) {
      if (generation !== this.remoteGeneration) return
      this.publish({ remoteStatus: 'error', remoteError: this.errorMessage(error) })
    }
  }

  async refresh(): Promise<void> {
    const local = this.refreshLocal().catch(() => undefined)
    const remote = this.snapshot.auth.signedIn ? this.refreshRemote() : Promise.resolve()
    await Promise.all([local, remote])
  }

  private async inspectLocal(item: ProjectListItem, isCurrent: () => boolean = () => true): Promise<BoxProjectInspection | null> {
    const id = localEntryId(item.dir)
    const generation = (this.inspectionGenerations.get(id) ?? 0) + 1
    this.inspectionGenerations.set(id, generation)
    try {
      const { inspection } = await inspectBoxProject(this.api as SingzApi, item)
      if (this.disposed || !isCurrent() || this.inspectionGenerations.get(id) !== generation) return inspection
      const current = this.localItems.find(candidate => candidate.dir === item.dir && candidate.songPath === item.songPath)
      if (!current) return inspection
      const rows = {
        ...this.snapshot.rows,
        [id]: {
          inspection,
          metadata: inspection.project
            ? projectMetadata(inspection.project, this.snapshot.rows[id]?.metadata?.duration ?? null)
            : this.snapshot.rows[id]?.metadata
        }
      }
      this.publish({ rows })
      return inspection
    } catch (error) {
      if (!this.disposed && isCurrent() && this.inspectionGenerations.get(id) === generation) {
        this.publish({
          rows: {
            ...this.snapshot.rows,
            [id]: {
              inspection: { readiness: 'error', project: null, message: this.errorMessage(error) }
            }
          }
        })
      }
      return { readiness: 'error', project: null, message: this.errorMessage(error) }
    }
  }

  private entryForId(entryId: string): CollectionEntry | null {
    return this.snapshot.entries.find(entry => entry.id === entryId || (entry.remoteId !== null && driveEntryId(entry.remoteId) === entryId)) ?? null
  }

  async verifyCached(entryId: string): Promise<CollectionPrepareResult> {
    const entry = this.entryForId(entryId)
    if (!entry?.local || !entry.local.songPath) return { ok: false, error: tCollection('collection.noLocalCopy') }
    const inspection = await this.inspectLocal(entry.local)
    if (!inspection) return { ok: false, error: tCollection('collection.superseded') }
    return { ok: inspection.readiness === 'ready', inspection }
  }

  async prepare(entryId: string): Promise<CollectionPrepareResult> {
    const entry = this.entryForId(entryId)
    if (!entry) return { ok: false, error: tCollection('collection.missing') }
    if (entry.local) return this.verifyCached(entry.id)
    if (!entry.remoteId) return { ok: false, error: tCollection('collection.unavailable') }
    if (this.downloadJob) {
      if (this.downloadJob.remoteId === entry.remoteId) return this.downloadJob.promise
      return { ok: false, error: tCollection('collection.downloadBusy') }
    }
    if (!this.snapshot.auth.signedIn) return { ok: false, error: tCollection('collection.signInFirst') }

    const epoch = ++this.downloadGeneration
    let settle!: () => void
    const settled = new Promise<void>(resolve => { settle = resolve })
    const job: DownloadJob = {
      epoch,
      entryId: entry.id,
      remoteId: entry.remoteId,
      cancelled: false,
      promise: Promise.resolve({ ok: false }),
      settle,
      settled
    }
    this.downloadJob = job
    job.promise = this.runDownload(job)
    return job.promise
  }

  private runDownload(job: DownloadJob): Promise<CollectionPrepareResult> {
    return (async () => {
      let unsubscribe: (() => void) | null = null
      const isCurrent = (): boolean => !job.cancelled && this.downloadGeneration === job.epoch && !this.disposed
      try {
        unsubscribe = this.api.onGdriveProgress(progress => {
          if (this.downloadJob !== job || !isCurrent()) return
          this.publish({
            download: {
              entryId: job.entryId,
              phase: 'downloading',
              msg: progress.msg,
              frac: Number.isFinite(progress.frac) ? Math.max(0, Math.min(1, progress.frac)) : 0
            }
          })
        })
        this.progressUnsubscribe = unsubscribe
        this.publish({ download: { entryId: job.entryId, phase: 'downloading', msg: '', frac: 0 } })
        const result = await this.api.gdriveDownload(job.remoteId)
        if (!isCurrent()) return { ok: false, cancelled: true }
        if (!result.ok || result.cancelled) {
          return { ok: false, cancelled: result.cancelled, error: result.error }
        }
        if (!result.songPath) return { ok: false, error: tCollection('collection.noDownloadResult') }
        const songPath = result.songPath
        this.remoteItems = this.remoteItems.map(item => item.id === job.remoteId ? { ...item, songPath } : item)
        this.publish()
        let projects: ProjectListItem[]
        try {
          projects = await this.refreshLocal(isCurrent)
        } catch (error) {
          return isCurrent() ? { ok: false, error: this.errorMessage(error) } : { ok: false, cancelled: true }
        }
        if (!isCurrent()) return { ok: false, cancelled: true }
        const local = projects.find(item => item.songPath === songPath)
        if (!local) return { ok: false, error: tCollection('collection.notInLibrary') }
        const id = localEntryId(local.dir)
        const inspection = await this.inspectLocal(local, isCurrent)
        if (!isCurrent()) return { ok: false, cancelled: true }
        if (!inspection) return { ok: false, error: tCollection('collection.superseded') }
        return {
          ok: inspection.readiness === 'ready',
          inspection: this.snapshot.rows[id]?.inspection ?? inspection
        }
      } catch (error) {
        if (!isCurrent()) return { ok: false, cancelled: true }
        return { ok: false, error: this.errorMessage(error) }
      } finally {
        unsubscribe?.()
        if (this.progressUnsubscribe === unsubscribe) this.progressUnsubscribe = null
        if (this.downloadJob === job) {
          this.downloadJob = null
          this.publish({ download: null })
        }
        job.settle()
      }
    })()
  }

  async cancelDownload(): Promise<void> {
    const job = this.downloadJob
    if (!job) return
    job.cancelled = true
    ++this.downloadGeneration
    this.publish({ download: { entryId: job.entryId, phase: 'cancelling', msg: this.snapshot.download?.msg ?? '', frac: this.snapshot.download?.frac ?? 0 } })
    try {
      await this.api.gdriveCancelDownload()
    } catch {
      // The original download remains authoritative and is always awaited.
    }
    await job.settled
  }

  async startSignIn(): Promise<void> {
    if (this.snapshot.auth.phase === 'starting' || this.snapshot.auth.phase === 'pending') return
    const generation = ++this.authGeneration
    this.cancelAuthContext = null
    this.clearAuthTimer()
    this.authChallenge = null
    this.publish({ auth: { ...this.snapshot.auth, phase: 'starting', challenge: null, error: null } })
    try {
      const status = await this.api.gdriveStatus()
      if (generation !== this.authGeneration || this.disposed) return
      if (status.signedIn) {
        await this.finishSignIn(generation)
        return
      }
      const result = await this.api.gdriveDeviceStart()
      if (generation !== this.authGeneration || this.disposed) {
        const ownsCancellation = (this.cancelAuthContext as { generation: number } | null)?.generation === generation
        if (result.ok) {
          const cancelled = await this.api.gdriveDeviceCancel(result.challenge.sessionId).catch(() => undefined)
          if (cancelled?.complete && ownsCancellation) {
            await this.finishSignIn(this.authGeneration)
            return
          }
        }
        if (ownsCancellation && !this.disposed) {
          this.cancelAuthContext = null
          this.publish({
            auth: { ...this.snapshot.auth, phase: 'cancelled', signedIn: false, challenge: null, error: null }
          })
        }
        return
      }
      if (!result.ok) {
        this.publish({
          auth: { ...this.snapshot.auth, phase: 'error', signedIn: false, challenge: null, error: result.code }
        })
        return
      }
      this.authChallenge = result.challenge
      this.publish({
        auth: {
          phase: 'pending',
          signedIn: false,
          configured: status.deviceSignInConfigured,
          challenge: result.challenge,
          error: null
        }
      })
      this.scheduleAuthPoll(generation, result.challenge.sessionId)
    } catch (error) {
      if (generation !== this.authGeneration || this.disposed) return
      this.publish({
        auth: { ...this.snapshot.auth, phase: 'error', signedIn: false, challenge: null, error: this.errorMessage(error) }
      })
    }
  }

  private scheduleAuthPoll(generation: number, sessionId: string): void {
    this.clearAuthTimer()
    this.authTimer = setTimeout(() => {
      void this.pollAuth(generation, sessionId)
    }, 1000)
  }

  private async pollAuth(generation: number, sessionId: string): Promise<void> {
    try {
      const status = await this.api.gdriveDeviceStatus(sessionId)
      if (generation !== this.authGeneration || this.disposed || this.authChallenge?.sessionId !== sessionId) return
      if (status.phase === 'complete') {
        await this.finishSignIn(generation)
        return
      }
      if (status.phase === 'pending') {
        this.scheduleAuthPoll(generation, sessionId)
        return
      }
      this.authChallenge = null
      this.publish({
        auth: {
          ...this.snapshot.auth,
          phase: status.phase === 'cancelled' ? 'cancelled' : 'error',
          signedIn: false,
          challenge: null,
          error: status.code ?? status.phase
        }
      })
    } catch (error) {
      if (generation !== this.authGeneration || this.disposed) return
      this.authChallenge = null
      this.publish({
        auth: { ...this.snapshot.auth, phase: 'error', challenge: null, error: this.errorMessage(error) }
      })
    }
  }

  private async finishSignIn(generation: number): Promise<void> {
    if (generation !== this.authGeneration || this.disposed) return
    this.clearAuthTimer()
    this.authChallenge = null
    this.cancelAuthContext = null
    this.publish({
      auth: { phase: 'complete', signedIn: true, configured: true, challenge: null, error: null }
    })
    await this.refreshRemote()
  }

  private clearAuthTimer(): void {
    if (this.authTimer !== null) clearTimeout(this.authTimer)
    this.authTimer = null
  }

  async cancelSignIn(): Promise<void> {
    const generation = ++this.authGeneration
    const challenge = this.authChallenge
    const starting = this.snapshot.auth.phase === 'starting'
    this.cancelAuthContext = { generation: generation - 1 }
    this.clearAuthTimer()
    this.authChallenge = null
    this.publish({
      auth: { ...this.snapshot.auth, phase: 'cancelled', signedIn: false, challenge: null, error: null }
    })
    if (!challenge && !starting) {
      this.cancelAuthContext = null
      return
    }
    const result = challenge
      ? await this.api.gdriveDeviceCancel(challenge.sessionId).catch(() => undefined)
      : undefined
    if (generation !== this.authGeneration || this.disposed) return
    if (result?.complete) {
      await this.finishSignIn(generation)
      return
    }
    if (!starting) this.cancelAuthContext = null
  }

  async signOut(): Promise<boolean> {
    ++this.authGeneration
    ++this.remoteGeneration
    this.clearAuthTimer()
    this.authChallenge = null
    this.cancelAuthContext = null
    const job = this.downloadJob
    if (job) {
      job.cancelled = true
      ++this.downloadGeneration
      this.publish({ download: { ...this.snapshot.download!, phase: 'cancelling' } })
    }
    let signedOut = false
    try {
      const result = await this.api.gdriveSignOut()
      if (job) await job.settled
      if (this.disposed) return false
      if (!result.ok) {
        await this.restoreAfterFailedSignOut()
        return false
      }
      signedOut = true
      this.remoteItems = []
      this.publish({
        remoteStatus: 'idle',
        remoteError: null,
        auth: { phase: 'signed-out', signedIn: false, configured: this.snapshot.auth.configured, challenge: null, error: null }
      })
      return true
    } catch {
      if (!signedOut && !this.disposed) await this.restoreAfterFailedSignOut()
      return false
    }
  }

  /** Sign-out invalidated in-flight auth/remote reads up front; re-read the truth so nothing stays 'loading'. */
  private async restoreAfterFailedSignOut(): Promise<void> {
    if (this.snapshot.remoteStatus === 'loading') this.publish({ remoteStatus: 'idle' })
    await this.refreshAccount()
  }

  recordOpened(item: ProjectListItem, inspection: BoxProjectInspection, metadata: CollectionSnapshot['rows'][string]['metadata']): void {
    this.publish({
      rows: {
        ...this.snapshot.rows,
        [localEntryId(item.dir)]: { inspection, metadata }
      }
    })
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    ++this.authGeneration
    ++this.downloadGeneration
    this.clearAuthTimer()
    this.progressUnsubscribe?.()
    this.progressUnsubscribe = null
    const challenge = this.authChallenge
    if (challenge) void this.api.gdriveDeviceCancel(challenge.sessionId).catch(() => undefined)
    if (this.downloadJob) {
      this.downloadJob.cancelled = true
      void this.api.gdriveCancelDownload().catch(() => undefined)
    }
    this.listeners.clear()
  }
}
