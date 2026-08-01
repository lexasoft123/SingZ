/**
 * The ledger's job is to never lose a change: not across a crash, not when a
 * sync is running while the change lands, and not for the writers nobody
 * remembered to wire up (which is how four of the seven lyrics writers reached
 * Drive only by accident for months).
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  clearDirty,
  dirtyDirs,
  dirtyOutsideLibrary,
  dirtySeq,
  isDirty,
  markFileDirty,
  markLibraryDirty,
  markProjectDirty,
  withDirty
} from '../../src/main/sync-dirty'
import { writeSettings } from '../../src/main/settings'

const project = (root: string, name: string): string => {
  const dir = join(root, name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'project.json'), '{}')
  return dir
}

let root: string

beforeEach(() => {
  writeSettings({ gdriveDirty: undefined })
  root = mkdtempSync(join(tmpdir(), 'singz-dirty-'))
})

describe('the dirty ledger', () => {
  it('starts clean and remembers a marked project', () => {
    expect(isDirty()).toBe(false)
    const dir = project(root, 'Song One')
    markProjectDirty(dir, 'save')
    expect(isDirty()).toBe(true)
    expect(dirtyDirs()).toEqual([dir])
  })

  it('survives a crash — it is on disk, not in memory', async () => {
    const dir = project(root, 'Song One')
    markProjectDirty(dir, 'save')
    // what a relaunch gets: every module built anew, the settings file as it lies
    vi.resetModules()
    const fresh = await import('../../src/main/sync-dirty')
    expect(fresh.dirtyDirs()).toEqual([dir])
  })

  it('keeps a change that landed while a sync was running', () => {
    const one = project(root, 'Song One')
    markProjectDirty(one, 'save')
    const captured = dirtySeq() // what the sync saw when it started

    const two = project(root, 'Song Two')
    markProjectDirty(two, 'save during the run')

    clearDirty(captured)
    expect(dirtyDirs()).toEqual([two])
    expect(isDirty()).toBe(true)
  })

  it('goes clean when the sync covered everything it was told about', () => {
    markProjectDirty(project(root, 'Song One'), 'save')
    clearDirty(dirtySeq())
    expect(isDirty()).toBe(false)
    expect(dirtyDirs()).toEqual([])
  })

  it('marks on both edges of a long operation', async () => {
    const dir = project(root, 'Song One')
    let captured = 0
    await withDirty(dir, 'save', async () => {
      // a sync starts mid-save and captures the seq it can see
      captured = dirtySeq()
    })
    clearDirty(captured)
    expect(dirtyDirs()).toEqual([dir]) // the trailing mark stands
  })

  it('marks on both edges even when the operation throws', async () => {
    const dir = project(root, 'Song One')
    await expect(withDirty(dir, 'save', async () => Promise.reject(new Error('disk full')))).rejects.toThrow()
    expect(dirtyDirs()).toEqual([dir])
  })

  it('follows a written file to the project around it', () => {
    const dir = project(root, 'Song One')
    markFileDirty(join(dir, 'lyrics.json'), 'lyrics')
    expect(dirtyDirs()).toEqual([dir])
  })

  it('ignores a file with no project beside it — the hash cache is not ours', () => {
    mkdirSync(join(root, 'cache'), { recursive: true })
    markFileDirty(join(root, 'cache', 'lyrics.json'), 'lyrics')
    expect(isDirty()).toBe(false)
  })

  it('collapses to library-scope rather than growing forever', () => {
    for (let i = 0; i < 101; i++) markProjectDirty(project(root, `Song ${i}`), 'save')
    expect(dirtyDirs()).toEqual([])
    expect(isDirty()).toBe(true) // still dirty, just no longer itemised
  })

  it('drops the per-project list when the whole library moves', () => {
    markProjectDirty(project(root, 'Song One'), 'save')
    markLibraryDirty('library moved')
    expect(dirtyDirs()).toEqual([])
    expect(isDirty()).toBe(true)
    clearDirty(dirtySeq())
    expect(isDirty()).toBe(false)
  })

  it('names dirty projects the sync will never reach', () => {
    const inside = project(root, 'Song One')
    const outside = project(mkdtempSync(join(tmpdir(), 'singz-elsewhere-')), 'Borrowed Song')
    markProjectDirty(inside, 'save')
    markProjectDirty(outside, 'save')
    expect(dirtyOutsideLibrary(root)).toEqual([outside])
  })
})
