import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const { loopzBuildInputs, zcoreGitlinkRevision } = require('../../scripts/zcore-gitlink.cjs') as {
  loopzBuildInputs(root: string): { revision: string; files: string[] }
  zcoreGitlinkRevision(root: string): string
}
const scratch: string[] = []
afterEach(() => {
  for (const path of scratch.splice(0)) rmSync(path, { recursive: true, force: true })
})

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'singz-loopz-provenance-'))
  scratch.push(root)
  const child = join(root, 'third_party', 'loopz')
  const hooks = join(root, 'empty-hooks')
  mkdirSync(child, { recursive: true })
  mkdirSync(hooks)
  const git = (cwd: string, args: string[]) => execFileSync('git', [
    '-c', `core.hooksPath=${hooks}`, '-c', 'commit.gpgsign=false', '-C', cwd, ...args
  ], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env, GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
      GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
      GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid'
    }
  }).trim()
  const write = (path: string, bytes: string) => {
    mkdirSync(dirname(join(child, path)), { recursive: true })
    writeFileSync(join(child, path), bytes)
  }
  git(root, ['init', '-q'])
  git(child, ['init', '-q'])
  for (const path of ['CMakeLists.txt', 'native/runtime/control.cpp', 'native/include/control.hpp',
    'vendor/nlohmann/json.hpp', 'interface/player.tsx', 'native/platform/macos/desktop/view.mm',
    'build/generated.cpp']) write(path, `fixture ${path}\n`)
  const nested = join(child, 'vendor', 'zcore')
  mkdirSync(nested, { recursive: true })
  git(nested, ['init', '-q'])
  write('vendor/zcore/CMakeLists.txt', '# nested zCore\n')
  git(nested, ['add', '.'])
  git(nested, ['commit', '-qm', 'nested fixture'])
  git(child, ['add', '.'])
  git(child, ['commit', '-qm', 'LoopZ fixture'])
  const revision = git(child, ['rev-parse', 'HEAD'])
  git(root, ['update-index', '--add', '--cacheinfo', `160000,${revision},third_party/loopz`])
  return { root, child, nested, git, write, revision }
}

function fingerprint(root: string) {
  const input = loopzBuildInputs(root)
  const hash = createHash('sha1').update(input.revision)
  for (const path of input.files) hash.update(path).update(readFileSync(path))
  return hash.digest('hex')
}

describe('LoopZ addon source provenance', () => {
  it('includes the compiled JSON header while excluding GUI, generated files and nested zCore', () => {
    const { root, child, revision } = fixture()
    const input = loopzBuildInputs(root)
    expect(input.revision).toBe(revision)
    const paths = input.files.map(path => relative(child, path).replaceAll('\\', '/'))
    expect(paths).toContain('vendor/nlohmann/json.hpp')
    expect(paths).toContain('native/runtime/control.cpp')
    expect(paths).not.toContain('interface/player.tsx')
    expect(paths).not.toContain('native/platform/macos/desktop/view.mm')
    expect(paths).not.toContain('build/generated.cpp')
    expect(paths.some(path => path.startsWith('vendor/zcore'))).toBe(false)
  })

  it('rejects a dirty JSON header before cached builder or loader fingerprint acceptance', () => {
    const { root, write } = fixture()
    expect(fingerprint(root)).toMatch(/^[a-f0-9]{40}$/)
    write('vendor/nlohmann/json.hpp', 'changed compiled JSON provider\n')
    expect(() => fingerprint(root)).toThrow(/LoopZ checkout is dirty/)
  })

  it('rejects a clean child at a different commit than the parent pin', () => {
    const { root, child, git, write } = fixture()
    write('vendor/nlohmann/json.hpp', 'committed replacement JSON\n')
    git(child, ['add', '.'])
    git(child, ['commit', '-qm', 'replacement'])
    expect(() => loopzBuildInputs(root)).toThrow(/does not match the parent gitlink/)
  })

  it('rejects staged and untracked source changes', () => {
    const { root, child, git, write } = fixture()
    write('native/runtime/control.cpp', 'staged source change\n')
    git(child, ['add', 'native/runtime/control.cpp'])
    expect(() => loopzBuildInputs(root)).toThrow(/dirty/)
    const other = fixture()
    other.write('native/runtime/untracked.cpp', 'untracked source\n')
    expect(() => loopzBuildInputs(other.root)).toThrow(/dirty/)
  })

  it('rejects dirty nested dependencies even though their files are fingerprinted separately', () => {
    const { root, write } = fixture()
    write('vendor/zcore/CMakeLists.txt', '# changed nested dependency\n')
    expect(() => loopzBuildInputs(root)).toThrow(/dirty/)
  })

  it('rejects an uninitialized directory that resolves to the parent repository', () => {
    const { root, child } = fixture()
    rmSync(join(child, '.git'), { recursive: true, force: true })
    expect(() => loopzBuildInputs(root)).toThrow(/not an initialized submodule/)
  })

  it('preserves the existing lightweight zCore gitlink semantics', () => {
    const { root, git, revision } = fixture()
    git(root, ['update-index', '--add', '--cacheinfo', `160000,${revision},third_party/zcore`])
    expect(zcoreGitlinkRevision(root)).toBe(revision)
  })
})
