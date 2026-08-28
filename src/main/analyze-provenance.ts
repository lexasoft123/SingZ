import { spawn } from 'node:child_process'
import { readFile, access } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { onChildSettled } from './child-exit'
import { log } from './log'

/**
 * Which singz-analyze is this, and did it come from this tree?
 *
 * resolveAnalyze returns whatever file sits in the vendor slot. Nothing used
 * to check that the file was built from the sources around it, and the only
 * currency check in the running app — the CLI's kPitchDetectVersion against
 * the renderer's PITCH_DETECT_VERSION — cannot see a same-version binary
 * built from DIFFERENT code, which is the interesting case:
 *
 *   During the v0.19.0 cut a parallel session rebuilt the shared
 *   vendor/darwin-arm64/singz-analyze from a sibling worktree whose branch
 *   had changed the live-input analysis adapter. The desktop — including
 *   audio-devices-e2e.cjs driving its native microphone path, the very code
 *   that adapter feeds — spawned the foreign binary for hours. Nothing
 *   shipped wrong, but it was caught by hand, days later, because the other
 *   session happened to mention the rebuild.
 *
 * So the binary is asked who it is, and the answer is checked against the
 * tree when there is a tree. Two sources, in order of trust:
 *
 *   1. `singz-analyze build-info` — the fingerprint COMPILED IN by
 *      vendor-analyze.sh. Travels inside the executable, so it survives a
 *      hand-copy and answers for an $SINGZ_ANALYZE override too.
 *   2. the `.source-hash` sidecar the same script writes — the fallback for
 *      a binary built before build-info existed.
 *
 * and the expectation comes from scripts/analyze-source-hash.sh, the one
 * definition of the fingerprint, run against this checkout.
 *
 * THIS NEVER REFUSES TO RUN. A dev machine legitimately runs a binary built
 * moments ago, a packaged app has no repo to hash, and a splitter that stops
 * working because a stamp file is missing would be a far worse bug than the
 * one being caught. Every outcome is a log line; the loud ones are loud.
 */

export interface AnalyzeBuildInfo {
  /** null when this build recorded none (host scripts, the phones). */
  sourceHash: string | null
  pitchDetectVersion: number | null
  keyDetectVersion: number | null
  beatDetectVersion: number | null
}

/** What we managed to learn about a binary.
 *
 *  `reported: undefined` means it could not answer at all — too old to have
 *  build-info, or it failed to run. A binary that DID answer but recorded no
 *  fingerprint is `{sourceHash: null}`, which is a different thing and takes
 *  a different path: only the first gets the sidecar's word. */
export interface ProvenanceFacts {
  reported?: AnalyzeBuildInfo
  sidecar: string | null
  expected: string | null
  binPath: string
}

export interface ProvenanceVerdict {
  level: 'info' | 'warn' | 'error'
  line: string
  /** The comparison actually made — for tests and for the E2E drivers. */
  state: 'match' | 'mismatch' | 'sidecar-drift' | 'unknown-source' | 'unchecked'
}

const REBUILD = 'rebuild it with scripts/vendor-analyze.sh'

/** The whole decision, as a pure function — the spawning and file reading
 *  above it have nothing to decide. */
export function provenanceVerdict(f: ProvenanceFacts): ProvenanceVerdict {
  const info = f.reported
  const detectors =
    info && info.pitchDetectVersion !== null
      ? ` (pitch v${info.pitchDetectVersion}, key v${info.keyDetectVersion}, beats v${info.beatDetectVersion})`
      : ''
  const short = (h: string | null): string => (h === null ? 'unrecorded' : h.slice(0, 12))
  // The binary's own word beats the sidecar: a file beside it can be
  // rewritten, replaced or simply left behind by a hand-copy.
  //
  // Which is why "it answered, and said it has no fingerprint" must NOT fall
  // back to the sidecar. Only vendor-analyze.sh stamps a binary, and it
  // writes the sidecar in the same breath — so a binary that answers
  // "unrecorded" was built by something else, and any .source-hash lying
  // beside it describes a DIFFERENT file. Falling back there turned a
  // hand-copied host build over a current slot into a clean `match`, which
  // inverts the rule this comment states. Only a binary too old to answer at
  // all (build-info exits 2) gets the sidecar's word.
  const answered = info !== undefined
  const stated = answered ? info.sourceHash : null
  const actual = answered ? stated : f.sidecar

  // No tree to compare against — the packaged app, or a checkout whose
  // scripts/git/bash could not be reached. RECORD it and say nothing more:
  // in the field the log is the only evidence there will ever be of which
  // core ran, and a warning nobody can act on is just noise.
  if (f.expected === null) {
    return {
      level: 'info',
      state: 'unchecked',
      line: `core singz-analyze ${short(actual)}${detectors} — no source tree here to check it against`
    }
  }

  if (actual === null) {
    return {
      level: 'warn',
      state: 'unknown-source',
      line:
        `core singz-analyze${detectors} ` +
        (answered
          ? 'reports no fingerprint, so it was not built by vendor-analyze.sh'
          : 'is too old to say which sources it was built from') +
        `, and this tree expects ${short(f.expected)} — ${REBUILD} to make it answerable`
    }
  }

  // Both present and disagreeing: somebody moved a binary without its stamp,
  // or a stamp without its binary. Whichever it is, one of the two files in
  // the vendor slot is lying about the other.
  if (stated !== null && f.sidecar !== null && stated !== f.sidecar) {
    return {
      level: 'error',
      state: 'sidecar-drift',
      line:
        `core singz-analyze reports sources ${short(stated)} but the .source-hash beside it says ` +
        `${short(f.sidecar)} — the binary and its stamp are not from the same build; ${REBUILD}`
    }
  }

  if (actual !== f.expected) {
    return {
      level: 'error',
      state: 'mismatch',
      line:
        `core singz-analyze was built from ${short(actual)}, but this tree is ${short(f.expected)} — ` +
        `it is running SOMEONE ELSE'S core${detectors}. Detector stamps cannot catch this; ${REBUILD}`
    }
  }

  return {
    level: 'info',
    state: 'match',
    line: `core singz-analyze ${short(actual)}${detectors} — built from this tree`
  }
}

/** Parse `singz-analyze build-info`. Anything malformed is "it did not
 *  answer" (undefined), never a guess. */
export function parseBuildInfo(stdout: string): AnalyzeBuildInfo | undefined {
  const line = stdout
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.startsWith('{'))
    .pop()
  if (line === undefined) return undefined
  try {
    const j = JSON.parse(line) as Record<string, unknown>
    const num = (k: string): number | null => (Number.isInteger(j[k]) ? (j[k] as number) : null)
    const hash = j.sourceHash
    if (hash !== null && typeof hash !== 'string') return undefined
    return {
      sourceHash: typeof hash === 'string' && hash !== '' ? hash : null,
      pitchDetectVersion: num('pitchDetectVersion'),
      keyDetectVersion: num('keyDetectVersion'),
      beatDetectVersion: num('beatDetectVersion')
    }
  } catch {
    return undefined
  }
}

/** build-info is instant (it reads nothing) — this is a hang catcher. */
const BUILD_INFO_MS = 10_000
/** The hash is ~50 ms warm; a cold page-cache or a busy machine can be slower. */
const HASH_MS = 30_000

function runCapturing(
  cmd: string,
  args: string[],
  source: string,
  ms: number
): Promise<string | null> {
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(cmd, args)
    } catch {
      resolve(null)
      return
    }
    const out: Buffer[] = []
    const timer = setTimeout(() => child.kill('SIGKILL'), ms)
    child.stdout?.on('data', (c: Buffer) => out.push(c))
    // Read it so the pipe cannot fill and wedge the child; nothing needs it.
    child.stderr?.on('data', () => {})
    child.on('error', () => {
      clearTimeout(timer)
      resolve(null)
    })
    onChildSettled(child, source, (code) => {
      clearTimeout(timer)
      resolve(code === 0 ? Buffer.concat(out).toString('utf8') : null)
    })
  })
}

async function readSidecar(binPath: string): Promise<string | null> {
  try {
    const raw = await readFile(`${binPath}.source-hash`, 'utf8')
    const value = raw.trim()
    return value === '' ? null : value
  } catch {
    return null
  }
}

/** This checkout's fingerprint, or null when there is no checkout to ask —
 *  a packaged app, or a machine with no bash/git on PATH. Memoized: the tree
 *  does not change under a running app, and a stale answer here would only
 *  ever produce a false alarm we would then have to explain. */
let expectedOnce: Promise<string | null> | null = null
export function expectedSourceHash(): Promise<string | null> {
  expectedOnce ??= (async () => {
    // out/main/analyze-provenance.js → the project root two levels up, the
    // same derivation resolveAnalyze uses to find the dev vendor dir.
    const root = join(import.meta.dirname, '..', '..')
    const script = join(root, 'scripts', 'analyze-source-hash.sh')
    try {
      await access(script)
    } catch {
      return null // packaged, or otherwise not a checkout
    }
    const out = await runCapturing('bash', [script, root], 'analyze-provenance', HASH_MS)
    const hash = out?.trim().split('\n').pop()?.trim()
    return hash !== undefined && /^[0-9a-f]{40}$/.test(hash) ? hash : null
  })()
  return expectedOnce
}

/** One verdict per binary path per session. */
const checked = new Map<string, Promise<ProvenanceVerdict>>()

/** Ask, decide, log. Returns the verdict for the drivers and the tests; the
 *  spawn path fires this and does not wait on it. */
export function checkAnalyzeProvenance(binPath: string): Promise<ProvenanceVerdict> {
  const already = checked.get(binPath)
  if (already) return already
  const run = (async (): Promise<ProvenanceVerdict> => {
    // Never rejects: the spawn path fires this and walks away, and an
    // unhandled rejection in main over a DIAGNOSTIC would be a worse bug
    // than the one it diagnoses.
    try {
      const [stdout, sidecar, expected] = await Promise.all([
        runCapturing(binPath, ['build-info'], 'analyze-provenance', BUILD_INFO_MS),
        readSidecar(binPath),
        expectedSourceHash()
      ])
      const verdict = provenanceVerdict({
        reported: stdout === null ? undefined : parseBuildInfo(stdout),
        sidecar,
        expected,
        binPath
      })
      log('analyze', `${verdict.line} [${dirname(binPath)}]`, verdict.level)
      return verdict
    } catch (err) {
      return {
        level: 'info',
        state: 'unchecked',
        line: `could not check which core is in ${dirname(binPath)}: ${err instanceof Error ? err.message : String(err)}`
      }
    }
  })()
  checked.set(binPath, run)
  return run
}

/** Test hook — the memo is per-session by design. */
export function resetProvenanceMemo(): void {
  checked.clear()
  expectedOnce = null
}
