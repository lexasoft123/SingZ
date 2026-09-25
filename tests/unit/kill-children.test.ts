import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

type Exec = (cmd: string, args: string[], options: object) => unknown
type Target = { pid: number; whole: boolean }
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { killChildren, windowsTargets } = require('../shared/kill-children.cjs') as {
  killChildren(pid?: number, deps?: { platform?: string; exec?: Exec }): void
  windowsTargets(listing: string, pid: number): Target[]
}
const HELPER = join(process.cwd(), 'tests/shared/kill-children.cjs')

/** What the PowerShell prints: itself, then pid, parent pid and creation
 *  ticks per process, with Windows line ends. */
function listing(self: number, rows: [pid: number, parent: number, created: bigint | number][]) {
  return [`self ${self}`, ...rows.map(([pid, parent, created]) => `${pid} ${parent} ${created}`), ''].join('\r\n')
}

/** Whether `pid` is running right now. */
function alive(pid: number) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** Every command killChildren runs, with a canned answer from PowerShell. */
function recorder(powershellSays = '') {
  const calls: { cmd: string; args: string[] }[] = []
  const exec: Exec = (cmd, args) => {
    calls.push({ cmd, args })
    return cmd === 'powershell.exe' ? powershellSays : ''
  }
  return { calls, exec }
}

/** A process that names a dead parent keeps that pid for as long as it lives,
 *  and Windows hands the pid out again: on a desktop, explorer.exe names one.
 *  4242 is the run here, started at tick 1000. */
const RUN: [number, number, number] = [4242, 4, 1000]

describe('killChildren', () => {
  it('asks pkill for the direct children on macOS and Linux', () => {
    for (const platform of ['darwin', 'linux']) {
      const r = recorder()
      killChildren(4242, { platform, exec: r.exec })
      expect(r.calls).toEqual([{ cmd: 'pkill', args: ['-9', '-P', '4242'] }])
    }
  })

  it('lists the processes through CIM on Windows and takes each child down with its tree', () => {
    const r = recorder(
      listing(9000, [
        RUN,
        [9000, 4242, 3000], // the PowerShell asking, one of the children itself
        [5150, 4242, 2000],
        [6160, 4242, 2500],
        [7000, 5150, 2100] // a grandchild: /T takes it with 5150
      ])
    )
    killChildren(4242, { platform: 'win32', exec: r.exec })
    expect(r.calls[0].cmd).toBe('powershell.exe')
    const query = r.calls[0].args.join(' ')
    expect(query).toContain('Get-CimInstance Win32_Process')
    expect(query).toContain('"self $PID"')
    expect(query).toContain('CreationDate')
    expect(r.calls.slice(1)).toEqual([
      { cmd: 'taskkill', args: ['/PID', '5150', '/T', '/F'] },
      { cmd: 'taskkill', args: ['/PID', '6160', '/T', '/F'] }
    ])
  })

  it('leaves a process that names the run as its parent but is older than the run', () => {
    // explorer.exe, had this run drawn its dead parent's pid
    const r = recorder(listing(9000, [RUN, [7788, 4242, 500], [5150, 4242, 2000]]))
    killChildren(4242, { platform: 'win32', exec: r.exec })
    expect(r.calls.slice(1)).toEqual([{ cmd: 'taskkill', args: ['/PID', '5150', '/T', '/F'] }])
  })

  it('takes a child alone when its tree holds a process older than the parent it names', () => {
    // taskkill /T would follow 7000's pid to 8000, which is not really below it
    const r = recorder(listing(9000, [RUN, [5150, 4242, 2000], [7000, 5150, 2100], [8000, 7000, 1500]]))
    killChildren(4242, { platform: 'win32', exec: r.exec })
    expect(r.calls.slice(1)).toEqual([{ cmd: 'taskkill', args: ['/PID', '5150', '/F'] }])
  })

  it('takes nothing when it cannot tell when the run began', () => {
    const missing = recorder(listing(9000, [[5150, 4242, 2000]]))
    killChildren(4242, { platform: 'win32', exec: missing.exec })
    expect(missing.calls.length).toBe(1)
    const timeless = recorder(listing(9000, [[4242, 4, 0], [5150, 4242, 2000]]))
    killChildren(4242, { platform: 'win32', exec: timeless.exec })
    expect(timeless.calls.length).toBe(1)
  })

  it('compares creation times to the tick, past what a double can hold', () => {
    // real ticks are ~6.4e17; as doubles these two are the same number
    const born = 639000000000000005n
    expect(windowsTargets(listing(9, [[4242, 4, born], [5150, 4242, born - 1n]]), 4242)).toEqual([])
    expect(windowsTargets(listing(9, [[4242, 4, born], [5150, 4242, born]]), 4242)).toEqual([
      { pid: 5150, whole: true }
    ])
  })

  it('never throws, and a child that will not go does not spare the next', () => {
    const taken: string[] = []
    const exec: Exec = (cmd, args) => {
      if (cmd === 'powershell.exe') return `junk\r\n${listing(9, [[1, 0, 10], [11, 1, 20], [22, 1, 30]])}`
      taken.push(args[1])
      if (args[1] === '11') throw new Error('Access is denied')
      return ''
    }
    expect(() => killChildren(1, { platform: 'win32', exec })).not.toThrow()
    expect(taken).toEqual(['11', '22'])
    const refuse: Exec = () => {
      throw new Error('not here')
    }
    expect(() => killChildren(1, { platform: 'darwin', exec: refuse })).not.toThrow()
    expect(() => killChildren(1, { platform: 'win32', exec: refuse })).not.toThrow()
  })

  it('takes a real child down on this platform, and not the process that asked', () => {
    // A parent that starts an idle child and asks for its children to go; it
    // prints only if it outlived its own request.
    const script = [
      `const { killChildren } = require(${JSON.stringify(HELPER)})`,
      "const child = require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })",
      "child.on('spawn', () => killChildren(process.pid))",
      "child.on('exit', () => { console.log('child gone'); process.exit(0) })",
      "setTimeout(() => { console.log('child still alive'); child.kill('SIGKILL'); process.exit(3) }, 20000)"
    ].join('\n')
    const run = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8', timeout: 45000 })
    expect(run.stdout.trim()).toBe('child gone')
    expect(run.status).toBe(0)
  })

  it.runIf(process.platform === 'win32')("takes a child's own children with it on Windows", () => {
    // Electron's helpers are the app's children, not the run's: the child
    // here starts one of its own, and both must go. Detached, because libuv
    // puts every other child in a job that dies with its parent, which would
    // take the grandchild down with or without `/T`. It ends itself in a
    // minute, so nothing here ever has to signal a pid it saw die: Windows
    // hands those out again.
    const dir = mkdtempSync(join(tmpdir(), 'singz-kill-children-'))
    const pidFile = join(dir, 'grandchild.pid')
    const child = [
      "const g = require('node:child_process').spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { detached: true, stdio: 'ignore' })",
      `require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(g.pid))`,
      'setTimeout(() => {}, 60000)'
    ].join('\n')
    const script = [
      `const { killChildren } = require(${JSON.stringify(HELPER)})`,
      `require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(child)}], { stdio: 'ignore' })`,
      'const started = Date.now()',
      'const wait = setInterval(() => {',
      '  let grand = 0',
      `  try { grand = Number(require('node:fs').readFileSync(${JSON.stringify(pidFile)}, 'utf8')) } catch {}`,
      '  if (grand > 0) {',
      '    clearInterval(wait)',
      '    killChildren(process.pid)',
      '    setTimeout(() => {',
      '      let alive = true',
      '      try { process.kill(grand, 0) } catch { alive = false }',
      "      console.log(alive ? 'grandchild alive' : 'grandchild gone')",
      '      // seen alive this instant, so still ours',
      '      if (alive) process.kill(grand)',
      '      process.exit(0)',
      '    }, 1000)',
      "  } else if (Date.now() - started > 20000) { console.log('no grandchild'); process.exit(3) }",
      '}, 50)'
    ].join('\n')
    try {
      const run = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8', timeout: 45000 })
      expect(run.stdout.trim()).toBe('grandchild gone')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it.runIf(process.platform === 'win32')('passes over a process whose parent has gone', () => {
    // A parent that starts a child and exits. The child still names the dead
    // parent's pid, and Windows can hand that pid to a new process, so nothing
    // may be taken for it; unguarded, the query took the orphan.
    const dir = mkdtempSync(join(tmpdir(), 'singz-kill-children-'))
    const pidFile = join(dir, 'orphan.pid')
    const script = [
      "const orphan = require('node:child_process').spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { detached: true, stdio: 'ignore' })",
      `require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(orphan.pid))`,
      'orphan.unref()'
    ].join('\n')
    // no pipes, so nothing the orphan inherits keeps this call waiting on it
    const parent = spawnSync(process.execPath, ['-e', script], { stdio: 'ignore', timeout: 30000 })
    let orphan = 0
    try {
      orphan = Number(readFileSync(pidFile, 'utf8'))
      expect(orphan).toBeGreaterThan(0)
      // it does name that parent, so there was something to refuse
      const names = execFileSync(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-Command', `(Get-CimInstance Win32_Process -Filter "ProcessId=${orphan}").ParentProcessId`],
        { encoding: 'utf8', timeout: 30000, windowsHide: true }
      )
      expect(Number(names)).toBe(parent.pid)
      const taken: string[] = []
      const exec: Exec = (cmd, args, options) => {
        if (cmd !== 'taskkill') return execFileSync(cmd, args, options)
        taken.push(args[1])
        return ''
      }
      killChildren(parent.pid, { platform: 'win32', exec })
      expect(taken).toEqual([])
    } finally {
      // it ends itself within the minute; take it sooner only while it is
      // seen alive, since a pid that has gone can be someone else's by now
      if (orphan > 0 && alive(orphan)) process.kill(orphan)
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
