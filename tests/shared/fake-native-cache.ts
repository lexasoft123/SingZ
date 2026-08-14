import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
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

// ---------------------------------------------------------------------------

export interface FakeNativeWriter {
  docsRoot: string
  pickAudioFile(): Promise<{ path: string; name: string; size: number } | null>
  ensureProjectDir(name: string): Promise<{ dir: string; path: string }>
  writeText(project: string, file: string, text: string): Promise<boolean>
  moveIntoProject(project: string, relPath: string, srcPath: string): Promise<string>
  copyIntoProject(project: string, relPath: string, srcPath: string): Promise<string>
  statFile(project: string, relPath: string): Promise<{ md5: string; size: number; mtimeMs: number }>
  deleteProject(project: string): Promise<boolean>
  readMediaTags(
    path: string
  ): Promise<{ artist?: string; title?: string; album?: string; durationMs?: number }>
}

/**
 * The reference writer half (Phase 1): what the Kotlin and Swift writer
 * methods do, over a temp documents root. Same guards (plain-child project
 * names, no path escapes), same desktop-mirrored safeName, same collision
 * suffixing, same .part+rename writes — so the phone writer's tests exercise
 * the semantics the phones actually run.
 */
export function fakeNativeWriter(docsRoot: string): FakeNativeWriter {
  const docChild = (project: string): string | null =>
    !project || project.includes('/') || project === '..' || project === '.'
      ? null
      : join(docsRoot, project)

  const relOk = (file: string): boolean =>
    !!file &&
    !file.startsWith('/') &&
    file.split('/').every((p) => p && p !== '.' && p !== '..')

  const safeName = (name: string): string => {
    const cleaned = name
      .replace(/\.(mp3|wav|flac|m4a|aac|ogg|oga|opus|aif|aiff)$/i, '')
      .replace(/[/\\:*?"<>|]/g, ' ')
      .replace(/\s{2,}/g, ' ')
      .trim()
    return cleaned || 'Untitled song'
  }

  const put = (out: string, write: (tmp: string) => void): void => {
    mkdirSync(dirname(out), { recursive: true })
    const tmp = `${out}.part`
    write(tmp)
    rmSync(out, { force: true })
    renameSync(tmp, out)
  }

  return {
    docsRoot,

    async pickAudioFile() {
      throw new Error('pickAudioFile needs a UI — tests hand paths in directly')
    },

    async ensureProjectDir(name) {
      const base = safeName(name)
      let dir = base
      let n = 2
      while (existsSync(join(docsRoot, dir, 'project.json'))) dir = `${base} ${n++}`
      const path = docChild(dir)
      if (!path) throw new Error('Bad project name')
      mkdirSync(path, { recursive: true })
      return { dir, path }
    },

    async writeText(project, file, text) {
      const dir = docChild(project)
      if (!dir || !relOk(file)) throw new Error('Bad project or file name')
      put(join(dir, file), (tmp) => writeFileSync(tmp, text, 'utf8'))
      return true
    },

    async moveIntoProject(project, relPath, srcPath) {
      const dir = docChild(project)
      if (!dir || !relOk(relPath)) throw new Error('Bad project or file name')
      const out = join(dir, relPath)
      put(out, (tmp) => writeFileSync(tmp, readFileSync(srcPath)))
      rmSync(srcPath, { force: true })
      return out
    },

    async copyIntoProject(project, relPath, srcPath) {
      const dir = docChild(project)
      if (!dir || !relOk(relPath)) throw new Error('Bad project or file name')
      const out = join(dir, relPath)
      put(out, (tmp) => writeFileSync(tmp, readFileSync(srcPath)))
      return out
    },

    async statFile(project, relPath) {
      const dir = docChild(project)
      if (!dir || !relOk(relPath)) throw new Error('Bad project or file name')
      const path = join(dir, relPath)
      const st = statSync(path)
      return { md5: md5Of(readFileSync(path)), size: st.size, mtimeMs: st.mtimeMs }
    },

    async deleteProject(project) {
      const dir = docChild(project)
      if (!dir || !existsSync(join(dir, 'project.json'))) throw new Error('Not a project folder')
      rmSync(dir, { recursive: true, force: true })
      return true
    },

    async readMediaTags() {
      return {}
    }
  }
}
