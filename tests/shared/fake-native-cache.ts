import { createHash } from 'node:crypto'
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, sep } from 'node:path'
import { isCurrent } from '../../mobile/src/current'

/**
 * The reference FolderAccess: what the Kotlin and Swift modules do, over a temp
 * folder instead of a phone. It exists so the mobile suite stops carrying its
 * own third implementation of the size/md5 ladder — this one imports the same
 * `isCurrent` the app does, so a change to the rule cannot pass the tests while
 * disagreeing with the natives.
 *
 * Faithful in the ways that have bitten: the download lands in a .part file
 * first, what arrives is verified against the md5 that was asked for (and
 * deleted when it does not match), the md5 memo is keyed on size+mtime, and
 * cacheUsage reports per-file sizes with .part excluded.
 */

export interface FakeNativeCache {
  root: string
  fetchToCache(
    project: string,
    file: string,
    url: string,
    auth: string,
    expectedMd5: string,
    expectedBytes: number
  ): Promise<{ path: string; downloaded: boolean }>
  cacheUsage(): Promise<{ project: string; bytes: number; files: number; sizes: Record<string, number> }[]>
  clearCache(project: string): Promise<boolean>
  /** Every real download this run — the only thing that costs a singer anything. */
  downloads: string[]
  /** Bytes as they sit on disk, for equality against the desktop's library. */
  read(project: string, file: string): Buffer
  hashCalls: number
}

const md5Of = (b: Buffer): string => createHash('md5').update(b).digest('hex')

export function fakeNativeCache(root: string): FakeNativeCache {
  const downloads: string[] = []
  /** path → "size:mtimeMs:md5", exactly the natives' memo. */
  const memo = new Map<string, string>()
  let hashCalls = 0

  const hashOf = (path: string): string => {
    const st = statSync(path)
    const stamp = `${st.size}:${Math.round(st.mtimeMs)}`
    const kept = memo.get(path)
    if (kept?.startsWith(`${stamp}:`)) return kept.slice(stamp.length + 1)
    hashCalls++
    const md5 = md5Of(readFileSync(path))
    memo.set(path, `${stamp}:${md5}`)
    return md5
  }

  /** Facts about the copy on disk. The md5 is a getter, not a value: the two
   *  natives only hash after the cheap checks pass, and a reference that hashed
   *  eagerly would be a fourth, different implementation of the ladder. */
  const facts = (path: string, wantMd5: string): { size: number; readonly md5?: string } | null => {
    let st
    try {
      st = statSync(path)
    } catch {
      return null
    }
    return {
      size: st.size,
      get md5() {
        return wantMd5 ? hashOf(path) : undefined
      }
    }
  }

  const api: FakeNativeCache = {
    root,
    downloads,
    get hashCalls() {
      return hashCalls
    },
    read: (project, file) => readFileSync(join(root, project, file)),

    async fetchToCache(project, file, url, auth, expectedMd5, expectedBytes) {
      const out = join(root, project, file)
      const have = facts(out, expectedMd5)
      if (isCurrent(have, { size: expectedBytes, md5: expectedMd5 })) {
        return { path: out, downloaded: false }
      }
      const res = await fetch(url, auth ? { headers: { Authorization: auth } } : undefined)
      if (!res.ok) throw new Error(`Drive download failed (${res.status}) for ${file}`)
      const bytes = Buffer.from(await res.arrayBuffer())
      mkdirSync(dirname(out), { recursive: true })
      const part = `${out}.part`
      writeFileSync(part, bytes)
      writeFileSync(out, readFileSync(part))
      rmSync(part, { force: true })
      if (expectedMd5 && md5Of(bytes) !== expectedMd5) {
        rmSync(out, { force: true })
        throw new Error(`${file} arrived damaged — try again`)
      }
      downloads.push(`${project}/${file}`)
      return { path: out, downloaded: true }
    },

    async cacheUsage() {
      const out: { project: string; bytes: number; files: number; sizes: Record<string, number> }[] = []
      let dirs: string[]
      try {
        dirs = readdirSync(root, { withFileTypes: true })
          .filter((d) => d.isDirectory())
          .map((d) => d.name)
      } catch {
        return out
      }
      for (const project of dirs) {
        const base = join(root, project)
        const sizes: Record<string, number> = {}
        let bytes = 0
        const walk = (dir: string): void => {
          for (const e of readdirSync(dir, { withFileTypes: true })) {
            const path = join(dir, e.name)
            if (e.isDirectory()) walk(path)
            // .part is a download in flight, not bytes the phone has
            else if (!e.name.endsWith('.part')) {
              const size = statSync(path).size
              sizes[relative(base, path).split(sep).join('/')] = size
              bytes += size
            }
          }
        }
        walk(base)
        const files = Object.keys(sizes).length
        if (files > 0) out.push({ project, bytes, files, sizes })
      }
      return out
    },

    async clearCache(project) {
      rmSync(project ? join(root, project) : root, { recursive: true, force: true })
      for (const key of [...memo.keys()]) {
        if (key.startsWith(join(root, project))) memo.delete(key)
      }
      return true
    }
  }
  return api
}
