import { lstat, mkdir, readFile, readdir, realpath, rename, rmdir, statfs, unlink } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path'
import type { BoxResult, BoxStorageSnapshot } from '../../shared/box-contract'

const MAX_PROJECTS = 512
const MAX_PROJECT_ENTRIES = 4096
const MAX_PROJECT_DEPTH = 8
const MAX_DOCUMENT_BYTES = 1024 * 1024

export type BoxCacheGuard = {
  beginCacheRemoval(dir: string): BoxResult<number>
  endCacheRemoval(token: number): void
}

const failure = <T>(error: string, code: string): BoxResult<T> => ({ ok: false, error, code })
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

export class BoxStorageService {
  readonly cacheRoot: string

  constructor(
    readonly userDataDir: string,
    private readonly guard: BoxCacheGuard,
    private readonly preRemoveGuard?: (dir: string) => Promise<BoxResult<null>>
  ) {
    this.cacheRoot = join(userDataDir, 'drive-projects')
  }

  async snapshot(): Promise<BoxResult<BoxStorageSnapshot>> {
    try {
      await mkdir(this.userDataDir, { recursive: true, mode: 0o700 })
      const projects: BoxStorageSnapshot['projects'] = []
      const entries = await this.rootEntries()
      for (const entry of entries.slice(0, MAX_PROJECTS)) {
        if (!entry.isDirectory() || entry.isSymbolicLink() || entry.name.startsWith('.singz-')) continue
        const dir = join(this.cacheRoot, entry.name)
        const cached = await this.inspectCacheEntry(dir)
        if (!cached) continue
        projects.push({ dir, name: cached.name, bytes: cached.bytes, driveId: entry.name })
      }
      const capacity = await this.capacity()
      return {
        ok: true,
        value: {
          ...capacity,
          cacheBytes: projects.reduce((total, project) => total + project.bytes, 0),
          projects
        }
      }
    } catch (error) {
      return failure(`Could not inspect Box cache: ${error instanceof Error ? error.message : String(error)}`, 'storage-read-failed')
    }
  }

  async removeCachedProject(rawDir: string): Promise<BoxResult<null>> {
    if (
      typeof rawDir !== 'string' || !isAbsolute(rawDir) || rawDir.includes('\0') ||
      rawDir.split(/[\\/]/).some((part) => part === '..')
    ) {
      return failure('Cached project must be an absolute direct child without traversal.', 'invalid-path')
    }
    const dir = resolve(rawDir)
    const reservation = this.guard.beginCacheRemoval(dir)
    if (!reservation.ok) return failure(reservation.error, reservation.code ?? 'project-busy')
    try {
      if (!(await this.managedDirectChild(dir))) {
        return failure('Refused to remove an unverified or non-local project.', 'invalid-project')
      }
      if (this.preRemoveGuard) {
        const result = await this.preRemoveGuard(dir)
        if (!result.ok) return result
      }
      const quarantine = join(this.cacheRoot, `.singz-removing-${process.pid}-${randomBytes(8).toString('hex')}`)
      await rename(dir, quarantine)
      await this.removeTree(quarantine)
      return { ok: true, value: null }
    } catch (error) {
      return failure(`Could not remove cached project: ${error instanceof Error ? error.message : String(error)}`, 'storage-write-failed')
    } finally {
      this.guard.endCacheRemoval(reservation.value)
    }
  }

  private async rootEntries() {
    try {
      const info = await lstat(this.cacheRoot)
      if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Box cache root is not a real directory.')
      return await readdir(this.cacheRoot, { withFileTypes: true })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }
  }

  private async capacity(): Promise<{ totalBytes: number; freeBytes: number }> {
    let target = this.cacheRoot
    try {
      await lstat(target)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      target = this.userDataDir
    }
    const stats = await statfs(target)
    const blockSize = Number(stats.bsize)
    const totalBytes = Number(stats.blocks) * blockSize
    const freeBytes = Number(stats.bavail) * blockSize
    if (!Number.isSafeInteger(totalBytes) || !Number.isSafeInteger(freeBytes) || totalBytes < 0 || freeBytes < 0) {
      throw new Error('Filesystem capacity is outside the supported range.')
    }
    return { totalBytes, freeBytes }
  }

  private async managedDirectChild(dir: string): Promise<boolean> {
    if (dirname(dir) !== resolve(this.cacheRoot) || !/^[A-Za-z0-9_-]{1,200}$/.test(basename(dir)) ||
      basename(dir).startsWith('.singz-')) return false
    const rootInfo = await lstat(this.cacheRoot)
    if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) return false
    const info = await lstat(dir)
    if (!info.isDirectory() || info.isSymbolicLink()) return false
    const [realRoot, realDir] = await Promise.all([realpath(this.cacheRoot), realpath(dir)])
    if (dirname(realDir) !== realRoot || !realDir.startsWith(realRoot + sep)) return false
    return await this.projectMarker(join(dir, 'project.json')) !== null
  }

  private async inspectCacheEntry(dir: string): Promise<{ name: string; bytes: number } | null> {
    try {
      if (!(await this.managedDirectChild(dir))) return null
      let name = basename(dir)
      const marker = await this.projectMarker(join(dir, 'project.json'))
      if (marker && marker.size <= MAX_DOCUMENT_BYTES) {
        try {
          const parsed: unknown = JSON.parse(await readFile(join(dir, 'project.json'), 'utf8'))
          if (record(parsed) && typeof parsed.name === 'string' && parsed.name.length > 0 &&
            parsed.name.length <= 512 && !/[\u0000-\u001f\u007f]/.test(parsed.name)) name = parsed.name
        } catch {
          // A damaged finalized cache document still names a removable local cache entry.
        }
      }
      const walked = await this.walk(dir)
      return walked ? { name, bytes: walked.bytes } : null
    } catch {
      return null
    }
  }

  private async projectMarker(file: string): Promise<{ size: number } | null> {
    try {
      const info = await lstat(file)
      return info.isFile() && !info.isSymbolicLink() && Number.isSafeInteger(info.size) && info.size >= 0
        ? { size: info.size }
        : null
    } catch {
      return null
    }
  }

  private async walk(root: string): Promise<{ bytes: number } | null> {
    let entries = 0
    let bytes = 0
    const visit = async (dir: string, depth: number): Promise<boolean> => {
      if (depth > MAX_PROJECT_DEPTH) return false
      const children = await readdir(dir, { withFileTypes: true })
      entries += children.length
      if (entries > MAX_PROJECT_ENTRIES) return false
      for (const child of children) {
        const path = join(dir, child.name)
        const info = await lstat(path)
        if (info.isSymbolicLink()) continue
        if (info.isDirectory()) {
          if (!(await visit(path, depth + 1))) return false
        } else if (info.isFile()) {
          if (!Number.isSafeInteger(info.size)) return false
          bytes += info.size
          if (!Number.isSafeInteger(bytes)) return false
        }
      }
      return true
    }
    try {
      return await visit(root, 0) ? { bytes } : null
    } catch {
      return null
    }
  }

  private async removeTree(path: string, depth = 0, budget = { entries: 0 }): Promise<void> {
    if (depth > MAX_PROJECT_DEPTH) throw new Error('Cached project exceeded the removal depth limit.')
    const info = await lstat(path)
    if (!info.isDirectory() || info.isSymbolicLink()) {
      await unlink(path)
      return
    }
    const children = await readdir(path)
    budget.entries += children.length
    if (budget.entries > MAX_PROJECT_ENTRIES) throw new Error('Cached project exceeded the removal entry limit.')
    for (const child of children) await this.removeTree(join(path, child), depth + 1, budget)
    await rmdir(path)
  }
}
