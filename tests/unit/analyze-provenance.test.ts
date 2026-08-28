import { execFile } from 'node:child_process'
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'
import {
  checkAnalyzeProvenance,
  parseBuildInfo,
  provenanceVerdict,
  resetProvenanceMemo
} from '../../src/main/analyze-provenance'

/**
 * "Is the singz-analyze I am about to spawn the one built from this tree?"
 *
 * The case with teeth is `mismatch`: a binary carrying CURRENT detector
 * stamps, built from someone else's sources. Every other currency check in
 * the app passes it — that is the whole reason this exists — so the table
 * below is the only place that failure is pinned.
 *
 * Nothing here may ever produce a refusal. A verdict is a log line; the
 * levels are what differ.
 */

const run = promisify(execFile)
const ROOT = join(__dirname, '..', '..')
const HASH_SCRIPT = join(ROOT, 'scripts', 'analyze-source-hash.sh')

const TREE = 'a'.repeat(40)
const OTHER = 'b'.repeat(40)
const info = (sourceHash: string | null) => ({
  sourceHash,
  pitchDetectVersion: 2,
  keyDetectVersion: 2,
  beatDetectVersion: 23
})

describe('provenanceVerdict', () => {
  it('is quiet when the binary says it came from this tree', () => {
    const v = provenanceVerdict({ reported: info(TREE), sidecar: TREE, expected: TREE, binPath: '/v/singz-analyze' })
    expect(v.state).toBe('match')
    expect(v.level).toBe('info')
  })

  it('is LOUD when a current-stamped binary was built from other sources — the v0.19.0 case', () => {
    const v = provenanceVerdict({ reported: info(OTHER), sidecar: OTHER, expected: TREE, binPath: '/v/singz-analyze' })
    expect(v.state).toBe('mismatch')
    expect(v.level).toBe('error')
    // the detector stamps are current and identical on both sides; only the
    // source hash differs, so the line must name both
    expect(v.line).toContain(OTHER.slice(0, 12))
    expect(v.line).toContain(TREE.slice(0, 12))
    expect(v.line).toContain('scripts/vendor-analyze.sh')
  })

  it('trusts the binary over the sidecar, and says so when they disagree', () => {
    const v = provenanceVerdict({ reported: info(TREE), sidecar: OTHER, expected: TREE, binPath: '/v/singz-analyze' })
    expect(v.state).toBe('sidecar-drift')
    expect(v.level).toBe('error')
  })

  it('falls back to the sidecar for a binary too old to have build-info', () => {
    const stale = provenanceVerdict({ reported: undefined, sidecar: OTHER, expected: TREE, binPath: '/v/a' })
    expect(stale.state).toBe('mismatch')
    const good = provenanceVerdict({ reported: undefined, sidecar: TREE, expected: TREE, binPath: '/v/a' })
    expect(good.state).toBe('match')
  })

  it('does NOT let a sidecar vouch for a binary that answered "unrecorded"', () => {
    // Only vendor-analyze.sh stamps a binary, and it writes the sidecar in
    // the same breath. A binary that answers build-info with no fingerprint
    // was built by something else, so a matching .source-hash beside it is
    // describing a different file — this used to read as a clean match.
    const v = provenanceVerdict({ reported: info(null), sidecar: TREE, expected: TREE, binPath: '/v/a' })
    expect(v.state).toBe('unknown-source')
    expect(v.line).toContain('not built by vendor-analyze.sh')
  })

  it('warns, without accusing, when nothing states a source at all', () => {
    const v = provenanceVerdict({ reported: info(null), sidecar: null, expected: TREE, binPath: '/v/a' })
    expect(v.state).toBe('unknown-source')
    expect(v.level).toBe('warn')
  })

  it('RECORDS and does not warn with no tree to check against — the packaged app', () => {
    const v = provenanceVerdict({ reported: info(TREE), sidecar: null, expected: null, binPath: '/A/e/singz-analyze' })
    expect(v.state).toBe('unchecked')
    expect(v.level).toBe('info')
    // the field log is the only evidence there will be of which core ran
    expect(v.line).toContain(TREE.slice(0, 12))
    expect(v.line).toContain('pitch v2')
  })

  it('records an unstamped binary in a packaged build without inventing a hash', () => {
    const v = provenanceVerdict({ reported: info(null), sidecar: null, expected: null, binPath: '/A/e/a' })
    expect(v.level).toBe('info')
    expect(v.line).toContain('unrecorded')
  })
})

describe('parseBuildInfo', () => {
  it('reads the CLI object, hash and detector stamps', () => {
    const j = parseBuildInfo(
      '{"version":1,"sourceHash":"' + TREE + '","pitchDetectVersion":2,"keyDetectVersion":2,"beatDetectVersion":23}\n'
    )
    expect(j?.sourceHash).toBe(TREE)
    expect(j?.beatDetectVersion).toBe(23)
  })

  it('reads an unstamped build as "no hash", not as a failure', () => {
    const j = parseBuildInfo('{"version":1,"sourceHash":null,"pitchDetectVersion":2}')
    expect(j).not.toBeUndefined()
    expect(j?.sourceHash).toBeNull()
  })

  it('refuses garbage and empty output rather than guessing', () => {
    expect(parseBuildInfo('unknown command build-info\n')).toBeUndefined()
    expect(parseBuildInfo('')).toBeUndefined()
    expect(parseBuildInfo('{"sourceHash":17}')).toBeUndefined()
  })
})

describe('scripts/analyze-source-hash.sh', () => {
  it('is deterministic and prints one 40-hex line', async () => {
    const a = await run('bash', [HASH_SCRIPT, ROOT])
    const b = await run('bash', [HASH_SCRIPT, ROOT])
    expect(a.stdout.trim()).toMatch(/^[0-9a-f]{40}$/)
    expect(b.stdout.trim()).toBe(a.stdout.trim())
  })

  it('refuses a root with no sources at all', async () => {
    await expect(run('bash', [HASH_SCRIPT, join(ROOT, 'no-such-checkout')])).rejects.toThrow()
  })

  /** A checkout with only the files the fingerprint claims to cover. */
  function fakeCheckout(): string {
    const root = mkdtempSync(join(tmpdir(), 'singz-hash-'))
    const core = join(root, 'mobile', 'native', 'core')
    const third = join(root, 'mobile', 'native', 'third_party', 'flac', 'src')
    mkdirSync(core, { recursive: true })
    mkdirSync(third, { recursive: true })
    mkdirSync(join(root, 'scripts'), { recursive: true })
    writeFileSync(join(core, 'melody.cpp'), '// stand-in\n')
    writeFileSync(join(third, 'stream_decoder.c'), '/* stand-in */\n')
    for (const name of ['vendor-analyze.sh', 'analyze-source-hash.sh'])
      copyFileSync(join(ROOT, 'scripts', name), join(root, 'scripts', name))
    return root
  }
  const hashOf = async (root: string): Promise<string> =>
    (await run('bash', [HASH_SCRIPT, root])).stdout.trim()

  it('MOVES when the vendored libFLAC changes — it is linked into the binary', async () => {
    // singz_flac compiles into singz_core compiles into singz-analyze, and
    // flac_io.cpp is how the CLI reads v2 stems at all, so a patched FLAC
    // changes the binary. third_party sat outside the original fingerprint:
    // survivable while this was a build-cache key, but as the authoritative
    // answer to "which core is this" it would have vouched for a stale binary
    // in green. Asserting the SCRIPT MENTIONS $THIRD was the first attempt and
    // it was worthless — the guard at the top mentions it too, so dropping it
    // from the find would have kept that green.
    const root = fakeCheckout()
    const before = await hashOf(root)
    expect(before).toMatch(/^[0-9a-f]{40}$/)
    const flac = join(root, 'mobile', 'native', 'third_party', 'flac', 'src', 'stream_decoder.c')
    writeFileSync(flac, '/* stand-in */\n/* patched upstream */\n')
    expect(await hashOf(root)).not.toBe(before)
  })

  it('moves for a core change too, and is stable when nothing moves', async () => {
    const root = fakeCheckout()
    const before = await hashOf(root)
    expect(await hashOf(root)).toBe(before)
    writeFileSync(join(root, 'mobile', 'native', 'core', 'melody.cpp'), '// edited\n')
    expect(await hashOf(root)).not.toBe(before)
  })

  // The one with teeth, and the reason it is spelled out: a MISSING root is
  // caught by the guard at the top of the script and never reaches the file
  // list, so it proves nothing about the list. What has twice produced a
  // confident hash of the WRONG file set is a root that exists and cannot be
  // fully read — once through `git hash-object` inside a process
  // substitution, once through `find` inside a brace group, both of which
  // hand back a short list with exit 0. Root reads everything, so this cannot
  // run as root.
  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'FAILS rather than hash a short list when part of the tree cannot be read',
    async () => {
      const root = fakeCheckout()
      const blocked = join(root, 'mobile', 'native', 'core', 'unreadable')
      mkdirSync(blocked, { recursive: true })
      writeFileSync(join(blocked, 'hidden.cpp'), '// must not be silently dropped\n')
      expect(await hashOf(root)).toMatch(/^[0-9a-f]{40}$/)

      chmodSync(blocked, 0o000)
      try {
        await expect(run('bash', [HASH_SCRIPT, root])).rejects.toThrow()
      } finally {
        chmodSync(blocked, 0o755)
      }
    }
  )

})

/** A stand-in singz-analyze: the only thing the check asks of it is
 *  `build-info`, so a script that prints one is a faithful one. */
function fakeCore(stated: string | null, sidecar: string | null): string {
  const dir = mkdtempSync(join(tmpdir(), 'singz-prov-'))
  const bin = join(dir, 'singz-analyze')
  const hash = stated === null ? 'null' : `"${stated}"`
  writeFileSync(
    bin,
    `#!/bin/sh\n[ "$1" = build-info ] || { echo "unknown command $1" >&2; exit 2; }\n` +
      `echo '{"version":1,"sourceHash":${hash},"pitchDetectVersion":2,"keyDetectVersion":2,"beatDetectVersion":23}'\n`
  )
  chmodSync(bin, 0o755)
  if (sidecar !== null) writeFileSync(`${bin}.source-hash`, `${sidecar}\n`)
  return bin
}

// POSIX only: the fake is a #! script, which spawn cannot run on Windows
// without a shell. The decision table above is platform-free and the E2E
// drivers cover the real binary on both.
describe.skipIf(process.platform === 'win32')('checkAnalyzeProvenance, wired up', () => {
  it('reads a real build-info off a real spawn and compares it with this tree', async () => {
    resetProvenanceMemo()
    const expected = (await run('bash', [HASH_SCRIPT, ROOT])).stdout.trim()
    const v = await checkAnalyzeProvenance(fakeCore(expected, expected))
    expect(v.state).toBe('match')
  })

  it('catches the foreign binary — current stamps, other sources', async () => {
    resetProvenanceMemo()
    const v = await checkAnalyzeProvenance(fakeCore(OTHER, OTHER))
    expect(v.state).toBe('mismatch')
    expect(v.level).toBe('error')
  })

  it('falls back to the sidecar when the binary predates build-info', async () => {
    resetProvenanceMemo()
    const dir = mkdtempSync(join(tmpdir(), 'singz-prov-old-'))
    const bin = join(dir, 'singz-analyze')
    writeFileSync(bin, '#!/bin/sh\necho "unknown command $1" >&2\nexit 2\n')
    chmodSync(bin, 0o755)
    writeFileSync(`${bin}.source-hash`, `${OTHER}\n`)
    const v = await checkAnalyzeProvenance(bin)
    expect(v.state).toBe('mismatch')
    expect(v.line).toContain(OTHER.slice(0, 12))
  })

  it('answers once per binary — the check must not ride every spawn', async () => {
    resetProvenanceMemo()
    const bin = fakeCore(OTHER, OTHER)
    const [a, b] = await Promise.all([checkAnalyzeProvenance(bin), checkAnalyzeProvenance(bin)])
    expect(a).toBe(b)
  })

  it('never throws at a binary that is missing or not executable', async () => {
    resetProvenanceMemo()
    const v = await checkAnalyzeProvenance(join(tmpdir(), 'singz-prov-absent', 'singz-analyze'))
    expect(v.state).toBe('unknown-source')
    expect(v.level).toBe('warn')
  })
})

// The vendored binary for THIS platform, when the machine has built one. It
// is the only case that proves the C++ half — an unstamped build reports
// null and the fixtures above would never notice.
const VENDORED = join(ROOT, 'vendor', `${process.platform}-${process.arch}`, process.platform === 'win32' ? 'singz-analyze.exe' : 'singz-analyze')
describe.skipIf(!existsSync(VENDORED))('the vendored singz-analyze (skipped where none is built)', () => {
  it('reports the sources it was built from, and they are this tree', async () => {
    resetProvenanceMemo()
    const v = await checkAnalyzeProvenance(VENDORED)
    // A mismatch here is the finding, not a broken test: this worktree is
    // running a core somebody else built. Rebuild with vendor-analyze.sh.
    expect(v.state).toBe('match')
  })
})
