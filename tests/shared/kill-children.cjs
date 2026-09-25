'use strict'
/**
 * Take down what this run started, the process's DIRECT children, and nothing
 * else. Two callers need it, and both at a moment when the app a driver
 * launched may still be running: the E2E watchdog at a deadline or on a signal
 * (tests/shared/watchdog.cjs), and the put-back's exit hook
 * (tests/e2e/mac/project-hold.cjs), which has to take the app down BEFORE it
 * puts a library project back, or a last save can land on top.
 *
 * macOS and Linux: `pkill -9 -P <pid>`, the direct children only; a
 * grandchild is not taken. Windows has no pkill, and until this existed the
 * app there went down only in Playwright's own exit handler, registered at
 * launch and so run after both callers. There, CIM lists the processes and
 * `taskkill /T /F` takes each child down with its tree: Electron's GPU and
 * renderer helpers are the app's children, not ours. PowerShell costs about a
 * second to start, which only these fallback paths pay.
 *
 * A Windows process keeps its parent's pid after the parent has gone, and pids
 * are handed out again: on a desktop, explorer.exe names a long-dead parent.
 * Naming a pid as parent proves nothing on its own; only a process created
 * after its parent can be its child. So a "child" older than this process is
 * someone else's and stays, or a run that drew explorer's old parent pid would
 * take the desktop down. The same holds at every level below: `/T` follows
 * parent pids, and nothing documents that taskkill checks the times, so a
 * child whose tree holds such a link anywhere goes alone. Its own children
 * then go with the app, or with Playwright's handler.
 *
 * Synchronous, because an 'exit' listener calls it. Best effort, and it never
 * throws: a failure here must never mask what the caller reports or puts back.
 */
const { execFileSync } = require('node:child_process')

// `$PID` first, since that PowerShell is itself one of the children; then one
// line per process: its pid, its parent's, and when it was created in 100 ns
// ticks (0 when CIM has no time for it).
const PROCESS_TABLE =
  '"self $PID"; Get-CimInstance Win32_Process | ForEach-Object { ' +
  '$t = if ($_.CreationDate) { $_.CreationDate.ToUniversalTime().Ticks } else { 0 }; ' +
  '"$($_.ProcessId) $($_.ParentProcessId) $t" }'

/** From PROCESS_TABLE's output: the children of `pid` to take down, each with
 *  whether its whole tree may go with it. */
function windowsTargets(listing, pid) {
  let self = -1
  const table = []
  for (const line of String(listing).split(/\r?\n/)) {
    const asking = /^\s*self (\d+)\s*$/.exec(line)
    if (asking) self = Number(asking[1])
    const row = /^\s*(\d+) (\d+) (\d+)\s*$/.exec(line)
    if (row) table.push({ pid: Number(row[1]), parent: Number(row[2]), created: BigInt(row[3]) })
  }
  const me = table.find((p) => p.pid === pid)
  // with no time to compare against, nothing can be told apart: take nothing
  if (!me || me.created === 0n) return []
  const childrenOf = new Map()
  for (const p of table) {
    if (!childrenOf.has(p.parent)) childrenOf.set(p.parent, [])
    childrenOf.get(p.parent).push(p)
  }
  const bornAfter = (parent, child) => child.pid !== parent.pid && child.created >= parent.created
  const targets = []
  for (const child of childrenOf.get(pid) ?? []) {
    if (child.pid === self || !bornAfter(me, child)) continue
    let whole = true
    const seen = new Set([child.pid])
    const queue = [child]
    for (let i = 0; i < queue.length && whole; i++) {
      for (const next of childrenOf.get(queue[i].pid) ?? []) {
        if (!bornAfter(queue[i], next) || seen.has(next.pid)) {
          whole = false
          break
        }
        seen.add(next.pid)
        queue.push(next)
      }
    }
    targets.push({ pid: child.pid, whole })
  }
  return targets
}

function killChildren(pid = process.pid, { platform = process.platform, exec = execFileSync } = {}) {
  try {
    if (platform !== 'win32') {
      exec('pkill', ['-9', '-P', String(pid)], { stdio: 'ignore', timeout: 5000 })
      return
    }
    const listing = exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', PROCESS_TABLE], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 30000,
      windowsHide: true
    })
    for (const { pid: child, whole } of windowsTargets(listing, Number(pid))) {
      try {
        exec('taskkill', ['/PID', String(child), ...(whole ? ['/T'] : []), '/F'], {
          stdio: 'ignore',
          timeout: 15000,
          windowsHide: true
        })
      } catch {
        // gone already, or not ours to take: the next one still goes
      }
    }
  } catch {
    // no children, no tool, or it refused: the caller goes on either way
  }
}

module.exports = { killChildren, windowsTargets }
