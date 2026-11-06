import { spawn } from 'node:child_process'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { LyricLine, LyricsProgress } from '../shared/types'
import { romanize, type CtcWord } from './align'
import { flacToWav } from './flac'
import { log } from './log'
import { isOnnxPack, mmsModelPath, packPython, torchHome } from './models'
import { spawnEnv } from './separation'
import { onChildSettled } from './child-exit'
// Protocol: stderr lines "P <0-100>" drive progress; stdout is one JSON
// object {words:[{i,s,e,score}]} or {error:"..."}.
import ALIGN_PY from '../../scripts/mms_align.py?raw'
// ONNX-pack variant (Windows, Intel Macs): same protocol, same RIFF input,
// but emissions come from our exported mms-fa.onnx via onnxruntime and the
// CTC Viterbi runs in numpy. The torchaudio pipeline wrapper's three extras
// (whole-input layer norm, log_softmax, star column at log-prob 0) are
// replicated by hand. Label map is MMS_FA's, fixed by the export.
import ALIGN_ONNX_PY from '../../scripts/mms_align_onnx.py?raw'

/**
 * Precise word alignment: MMS forced alignment (CTC) through the GPU
 * splitter pack's python (torch + torchaudio ship with it on macOS).
 * The multilingual checkpoint (~1.2 GB, registry id 'aligner') lives in
 * the shared models dir under a torch-hub layout — see models.ts.
 */

/**
 * The pack python can run the aligner: the torch pack does it via
 * torchaudio's forced_align; the ONNX pack (Windows, Intel Macs) runs the
 * exported MMS model through onnxruntime with the CTC trellis in numpy.
 */
export async function preciseCapable(): Promise<boolean> {
  try {
    const { access } = await import('node:fs/promises')
    await access(packPython())
    return true
  } catch {
    return false
  }
}

export interface MmsRun {
  child: ReturnType<typeof spawn>
  done: Promise<CtcWord[]>
}

/** Spawn the pack-python forced aligner over the vocals for these lyrics. */
export async function runMmsAlign(
  vocalsPath: string,
  ref: LyricLine[],
  onProgress: (p: LyricsProgress) => void
): Promise<MmsRun> {
  const flat: { i: number; t: string; li: number; wi: number }[] = []
  ref.forEach((line, li) =>
    line.words.forEach((w, wi) => {
      flat.push({ i: flat.length, t: romanize(w.w), li, wi })
    })
  )
  const dir = join(tmpdir(), `singz-align-${Date.now()}`)
  await mkdir(dir, { recursive: true })
  const tokensPath = join(dir, 'tokens.json')
  await writeFile(tokensPath, JSON.stringify(flat.map(({ i, t, li }) => ({ i, t, l: li }))), 'utf8')

  // the pack python reads WAV only — decode FLAC stems with our libFLAC
  let wavPath = vocalsPath
  if (/\.flac$/i.test(vocalsPath)) {
    wavPath = join(dir, 'vocals.wav')
    const res = await flacToWav(vocalsPath, wavPath)
    if (!res.ok) {
      await rm(dir, { recursive: true, force: true })
      throw new Error(`could not decode the vocals stem: ${res.error}`)
    }
  }

  const onnx = isOnnxPack()
  const child = spawn(
    packPython(),
    onnx
      ? ['-c', ALIGN_ONNX_PY, wavPath, tokensPath, mmsModelPath()]
      : ['-c', ALIGN_PY, wavPath, tokensPath],
    {
      env: {
        ...spawnEnv(),
        PYTHONUNBUFFERED: '1',
        TORCH_HOME: torchHome(),
        HF_HUB_OFFLINE: '1'
      }
    }
  )

  const done = new Promise<CtcWord[]>((resolve, reject) => {
    let out = ''
    let errTail = ''
    child.stdout?.on('data', (c: Buffer) => {
      out += c.toString('utf8')
    })
    child.stderr?.on('data', (c: Buffer) => {
      const text = c.toString('utf8')
      errTail = (errTail + text).slice(-4000)
      for (const m of text.matchAll(/^P (\d+)$/gm)) {
        onProgress({ stage: 'transcribing', percent: Math.min(99, parseInt(m[1], 10)) })
      }
    })
    child.on('error', (err) => {
      void rm(dir, { recursive: true, force: true })
      reject(new Error(`Could not start the aligner: ${err.message}`))
    })
    onChildSettled(child, 'lyrics', (code, signal) => {
      void rm(dir, { recursive: true, force: true })
      // SIGTERM is cancel() doing its job, not a failure: node reports a
      // killed child as code null + a signal (TerminateProcess on Windows
      // too), and cancel() is the only thing that signals this child. It used
      // to reach the field log as `[error] mms align failed (exit null):
      // Unexpected end of JSON input` — the loudest line in a report whose
      // real complaint was elsewhere, and the only evidence a release build
      // leaves behind. Any OTHER signal is the pack python dying for real
      // (SIGSEGV, SIGKILL from the OOM killer): those keep the error level
      // and the traceback, which are the whole point of the log.
      if (signal === 'SIGTERM') {
        log('lyrics', 'mms align stopped (cancelled)')
        reject(new Error('The aligner was stopped.'))
        return
      }
      if (signal !== null) {
        log('lyrics', `mms align died on ${signal} — ${errTail.slice(-300)}`, 'error')
        reject(new Error(`The aligner stopped unexpectedly (${signal}).`))
        return
      }
      try {
        const parsed = JSON.parse(out.trim().split('\n').pop() ?? '') as {
          words?: { i: number; s: number; e: number; score: number; v?: number }[]
          error?: string
        }
        if (parsed.error || !parsed.words) throw new Error(parsed.error ?? 'no output')
        const words: CtcWord[] = []
        for (const w of parsed.words) {
          const src = flat[w.i]
          if (!src) continue
          words.push({ li: src.li, wi: src.wi, s: w.s, e: w.e, score: w.score, voiced: w.v })
        }
        resolve(words)
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        log('lyrics', `mms align failed (exit ${code}): ${msg} — ${errTail.slice(-300)}`, 'error')
        reject(new Error(msg))
      }
    })
  })
  return { child, done }
}
