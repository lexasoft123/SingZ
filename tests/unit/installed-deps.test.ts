import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'

type Entry = { version?: string; resolved?: string; integrity?: string; optional?: boolean; devOptional?: boolean; link?: boolean }
type Packages = Record<string, Entry>

const require = createRequire(import.meta.url)
const { staleDeps } = require('../../scripts/check-installed-deps.cjs') as {
  staleDeps: (locked: Packages, files: (key: string) => { version?: string } | null, record?: Packages) => string[]
}

/**
 * The build refuses a node_modules that is not the lockfile's. The case it
 * exists for: a checkout that pulled a new kit pin without `npm ci`, whose
 * build then shipped the kit it already had.
 */
const kit = (tag: string, integrity: string): Entry => ({
  version: tag,
  resolved: `https://github.com/lexasoft123/singz-ui/archive/refs/tags/v${tag}.tar.gz`,
  integrity
})
/** node_modules as its package.json files say: key → version. */
const onDisk =
  (versions: Record<string, string>) =>
  (key: string): { version: string } | null =>
    key in versions ? { version: versions[key] } : null

describe('installed deps check', () => {
  it('names a kit installed from an older tag than the lockfile pins', () => {
    const locked = { '': {}, 'node_modules/@singz/ui': kit('1.8.1', 'sha512-new') }
    const files = onDisk({ 'node_modules/@singz/ui': '1.7.0' })
    const record = { 'node_modules/@singz/ui': kit('1.7.0', 'sha512-old') }
    expect(staleDeps(locked, files, record)).toEqual(['@singz/ui: installed 1.7.0, locked 1.8.1'])
  })

  it('believes the files over a record that describes other ones', () => {
    // the field laptop: node_modules copied from tree to tree with the kit
    // replaced by hand, so npm's record still says the kit of a month ago
    const locked = { 'node_modules/@singz/ui': kit('1.8.1', 'sha512-new') }
    const files = onDisk({ 'node_modules/@singz/ui': '1.8.1' })
    const record = { 'node_modules/@singz/ui': kit('1.0.1', 'sha512-ancient') }
    expect(staleDeps(locked, files, record)).toEqual([])
    // ...and a stale kit under an up-to-date record is still caught by its files
    expect(staleDeps(locked, onDisk({ 'node_modules/@singz/ui': '1.7.0' }), { 'node_modules/@singz/ui': kit('1.8.1', 'sha512-new') })).toEqual([
      '@singz/ui: installed 1.7.0, locked 1.8.1'
    ])
  })

  it('notices a changed source or integrity when the record agrees with the files', () => {
    // a kit tag re-cut without bumping package.json's version field
    const locked = { 'node_modules/@singz/ui': kit('1.8.1', 'sha512-b') }
    const files = onDisk({ 'node_modules/@singz/ui': '1.8.1' })
    const record = { 'node_modules/@singz/ui': kit('1.8.1', 'sha512-a') }
    expect(staleDeps(locked, files, record)).toEqual(['@singz/ui: installed 1.8.1 with a different integrity than locked'])
  })

  it('wants every package the lockfile needs, but not another platform’s optional binaries', () => {
    const locked: Packages = {
      'node_modules/react': { version: '19.2.8' },
      'node_modules/@esbuild/linux-x64': { version: '0.25.0', optional: true },
      'node_modules/fsevents': { version: '2.3.3', devOptional: true },
      'node_modules/workspace-pkg': { link: true, resolved: 'packages/workspace-pkg' }
    }
    expect(staleDeps(locked, onDisk({}))).toEqual(['react 19.2.8: not installed'])
  })

  it('names a nested copy by its own package name', () => {
    const locked = { 'node_modules/a/node_modules/b': { version: '2.0.0' } }
    expect(staleDeps(locked, onDisk({ 'node_modules/a/node_modules/b': '1.0.0' }))).toEqual(['b: installed 1.0.0, locked 2.0.0'])
  })

  it('passes a fresh install of this repository', () => {
    // npm ci in CI and in every worktree setup: each package.json carries the
    // version the lockfile recorded from it, and the record matches both
    const locked = (JSON.parse(readFileSync(new URL('../../package-lock.json', import.meta.url), 'utf8')) as { packages: Packages }).packages
    const installed = Object.entries(locked).filter(([k, v]) => k.startsWith('node_modules/') && !v.optional && !v.link)
    const files = onDisk(Object.fromEntries(installed.map(([k, v]) => [k, v.version ?? ''])))
    expect(staleDeps(locked, files, Object.fromEntries(installed))).toEqual([])
  })
})
