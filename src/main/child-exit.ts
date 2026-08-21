import type { ChildProcess } from 'node:child_process'
import { log } from './log'

/**
 * "The child is finished AND everything it printed has arrived."
 *
 * `'exit'` alone does not mean that: it fires when the process ends, which can
 * be before node has drained the stdout pipe, so a handler that parses stdout
 * there can read a truncated payload. It surfaces as a bogus
 * `Unexpected end of JSON input` — a failure invented by the reader, blamed on
 * the engine. Only two of our children are actually exposed (the MMS aligner
 * and the beat runner each print one JSON object; the aligner's is ~50 bytes
 * per word, so a long song approaches the 64 KB pipe buffer), but the rest
 * lose their stderr tail the same way, which is the error message the user
 * gets — so every spawn goes through here.
 *
 * MEASURED BEFORE BELIEVING, and the answer was not the expected one: on
 * macOS + node 26, reading at `'exit'` was never short — 400 trials, payloads
 * from 1 KB to 8 MB, busy parent loop or idle, 0 truncations
 * (scripts are throwaway; the numbers are the point). So this is NOT a fix for
 * a reproduced field bug. It is `'close'` because `'close'` is the event that
 * actually promises drained stdio, and because the fleet is mostly Windows,
 * where libuv pipes are a different implementation (IOCP) with different
 * ordering and no way to measure from a Mac. Treat the truncation risk as
 * unproven here rather than as history.
 *
 * What it is NOT allowed to do is wait forever: the splitter pack loads
 * torch and can leave a descendant holding the inherited pipe, and none of
 * these call sites has a timeout — so a plain `'close'` swap would trade a
 * rare wrong log line for a "splitting…" spinner that never ends, which is a
 * far worse failure. Hence the grace timer: `'close'` if it comes, otherwise
 * whatever had arrived by then, and a line in the log saying so, so a
 * truncated read diagnoses itself instead of looking like a corrupt engine.
 */
const GRACE_MS = 2000

export function onChildSettled(
  child: ChildProcess,
  source: string,
  handler: (code: number | null, signal: NodeJS.Signals | null) => void,
  graceMs = GRACE_MS
): void {
  let handled = false
  let closed = false
  let exit: { code: number | null; signal: NodeJS.Signals | null } | null = null
  let timer: NodeJS.Timeout | null = null

  // Only an exit means there is a result to report. A spawn that failed emits
  // 'error' (and may emit 'close') without ever emitting 'exit' — that is the
  // call site's own 'error' handler's business, not ours.
  const settle = (drained: boolean): void => {
    if (handled || !exit) return
    handled = true
    if (timer) clearTimeout(timer)
    if (!drained) {
      log(
        source,
        `the process exited but its output stream never closed — reading the ${graceMs} ms of it that arrived`,
        'warn'
      )
    }
    handler(exit.code, exit.signal)
  }

  // 'close' normally follows 'exit', but the order is not guaranteed to us, so
  // both directions are handled — arming the grace timer after a close that
  // already happened would delay every single run by the full grace.
  child.on('close', () => {
    closed = true
    settle(true)
  })
  child.on('exit', (code, signal) => {
    exit = { code, signal }
    if (closed) settle(true)
    else timer = setTimeout(() => settle(false), graceMs)
  })
}
