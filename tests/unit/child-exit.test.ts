import { spawn } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { onChildSettled } from '../../src/main/child-exit'

/**
 * These tests spawn real children — the behaviour under test is in the pipe,
 * and a mocked EventEmitter cannot have it.
 *
 * Read the payload tests for what they ARE: a contract that a big payload
 * arrives whole, not a regression test for truncation. Reading at 'exit' was
 * measured here and never came up short (macOS + node 26, 400 trials, 1 KB to
 * 8 MB), so those two pass against the old code as well — do not take their
 * green as proof the helper is earning its keep on this platform.
 *
 * The one with teeth is the last: a grandchild holding the inherited stdout
 * is the case where 'close' never arrives, and it is the reason this waits on
 * a grace timer instead of on 'close' alone. That one fails against both the
 * old 'exit' code and a naive 'close' swap — the first reads early, the
 * second hangs forever.
 */

/** One JSON object shaped like the MMS aligner's, `words` entries and all. */
const bigPayloadScript = (words: number) =>
  `const w=[];for(let i=0;i<${words};i++)w.push({i,s:i*0.5,e:i*0.5+0.4,score:0.9876,v:0.543});` +
  `process.stdout.write(JSON.stringify({words:w}));`

function run(script: string): Promise<{ out: string; code: number | null }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['-e', script])
    let out = ''
    child.stdout.on('data', (c: Buffer) => {
      out += c.toString('utf8')
    })
    onChildSettled(child, 'test', (code) => resolve({ out, code }))
  })
}

describe('onChildSettled', () => {
  it('delivers a payload far past the pipe buffer whole', async () => {
    const WORDS = 4000 // ~200 KB — a long song's word count, several buffers
    const { out, code } = await run(bigPayloadScript(WORDS))
    expect(code).toBe(0)
    expect(out.length).toBeGreaterThan(64 * 1024)
    // the shape the aligner's caller relies on — parseable, and all of it
    const parsed = JSON.parse(out) as { words: { i: number }[] }
    expect(parsed.words).toHaveLength(WORDS)
    expect(parsed.words[WORDS - 1].i).toBe(WORDS - 1)
  })

  it('survives a payload written in slow chunks, ending right at exit', async () => {
    const { out, code } = await run(
      `let n=0;const t=setInterval(()=>{process.stdout.write('x'.repeat(9000));` +
        `if(++n===8){clearInterval(t);process.stdout.write('END');}},1);`
    )
    expect(code).toBe(0)
    expect(out.endsWith('END')).toBe(true)
    expect(out).toHaveLength(8 * 9000 + 3)
  })

  it('reports the exit code and passes a signal through', async () => {
    const plain = await run('process.exit(3)')
    expect(plain.code).toBe(3)

    const signal = await new Promise<NodeJS.Signals | null>((resolve) => {
      const child = spawn(process.execPath, ['-e', 'setTimeout(()=>{},60000)'])
      onChildSettled(child, 'test', (_code, sig) => resolve(sig))
      setTimeout(() => child.kill('SIGTERM'), 50)
    })
    expect(signal).toBe('SIGTERM')
  })

  it('calls the handler exactly once', async () => {
    let calls = 0
    await new Promise<void>((resolve) => {
      const child = spawn(process.execPath, ['-e', 'process.stdout.write("hi")'])
      onChildSettled(child, 'test', () => {
        calls++
        setTimeout(resolve, 120)
      })
    })
    expect(calls).toBe(1)
  })

  it('does not fire for a spawn that never started — that is the error handler', async () => {
    let fired = false
    await new Promise<void>((resolve) => {
      const child = spawn('singz-no-such-binary-anywhere', [])
      onChildSettled(child, 'test', () => {
        fired = true
      })
      child.on('error', () => setTimeout(resolve, 120))
    })
    expect(fired).toBe(false)
  })

  it('gives up after the grace when the stream is held open, and says so', async () => {
    // A child that exits while a GRANDCHILD keeps the inherited stdout open —
    // the torch-descendant case that makes a bare 'close' hang forever. The
    // handler must still run, on the grace timer.
    const script =
      `const {spawn}=require('child_process');` +
      `process.stdout.write('PARTIAL');` +
      `spawn(process.execPath,['-e','setTimeout(()=>{},4000)'],{stdio:['ignore',1,'ignore']});` +
      `setTimeout(()=>process.exit(0),50);`
    const started = Date.now()
    const { out, code } = await new Promise<{ out: string; code: number | null }>((resolve) => {
      const child = spawn(process.execPath, ['-e', script])
      let out = ''
      child.stdout.on('data', (c: Buffer) => {
        out += c.toString('utf8')
      })
      onChildSettled(child, 'test', (c) => resolve({ out, code: c }), 300)
    })
    expect(code).toBe(0)
    expect(out).toBe('PARTIAL')
    const waited = Date.now() - started
    expect(waited).toBeGreaterThanOrEqual(300) // it really did wait for the grace
    expect(waited).toBeLessThan(3000) // and really did not wait for the grandchild
  }, 10000)
})
