import { spawn } from 'node:child_process'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { LyricLine, LyricsProgress } from '../shared/types'
import { romanize, type CtcWord } from './align'
import { flacToWav } from './flac'
import { log } from './log'
import { isOnnxPack, packPython, torchHome } from './models'
import { spawnEnv } from './separation'

/**
 * Precise word alignment: MMS forced alignment (CTC) through the GPU
 * splitter pack's python (torch + torchaudio ship with it on macOS).
 * The multilingual checkpoint (~1.2 GB, registry id 'aligner') lives in
 * the shared models dir under a torch-hub layout — see models.ts.
 */

/** The pack python can run the aligner (torch pack, not the ONNX one). */
export async function preciseCapable(): Promise<boolean> {
  try {
    const { access } = await import('node:fs/promises')
    await access(packPython())
    return !isOnnxPack()
  } catch {
    return false
  }
}

// Protocol: stderr lines "P <0-100>" drive progress; stdout is one JSON
// object {words:[{i,s,e,score}]} or {error:"..."}.
const ALIGN_PY = String.raw`
import json, sys
def p(x):
    sys.stderr.write("P %d\n" % int(x)); sys.stderr.flush()
try:
    import numpy as np
    import torch, torchaudio
    vocals, tokens_path = sys.argv[1], sys.argv[2]
    with open(tokens_path) as f:
        toks = json.load(f)
    p(2)
    # torchaudio 2.11 dropped bundled decoding (wants torchcodec, absent in
    # the pack) — parse the RIFF ourselves: PCM16 or float32, as our own
    # decoder and the splitter write them.
    with open(vocals, "rb") as f:
        raw = f.read()
    if raw[0:4] != b"RIFF" or raw[8:12] != b"WAVE":
        raise ValueError("aligner input must be a WAV file")
    off, fmt, data = 12, None, None
    while off + 8 <= len(raw):
        cid = raw[off : off + 4]
        size = int.from_bytes(raw[off + 4 : off + 8], "little")
        if cid == b"fmt ":
            fmt = (
                int.from_bytes(raw[off + 8 : off + 10], "little"),
                int.from_bytes(raw[off + 10 : off + 12], "little"),
                int.from_bytes(raw[off + 12 : off + 16], "little"),
                int.from_bytes(raw[off + 22 : off + 24], "little"),
            )
        elif cid == b"data":
            data = raw[off + 8 : off + 8 + size]
        off += 8 + size + (size % 2)
    if fmt is None or data is None:
        raise ValueError("missing fmt/data chunk")
    kind, n_ch, sr, bits = fmt
    if kind == 3 or (kind == 0xFFFE and bits == 32):
        x = np.frombuffer(data, dtype=np.float32)
    elif kind in (1, 0xFFFE) and bits == 16:
        x = np.frombuffer(data, dtype=np.int16).astype(np.float32) / 32768.0
    else:
        raise ValueError("unsupported wav format %s/%s-bit" % (kind, bits))
    x = x.reshape(-1, n_ch).mean(axis=1)
    wav = torch.from_numpy(np.ascontiguousarray(x)).unsqueeze(0)
    bundle = torchaudio.pipelines.MMS_FA
    if sr != bundle.sample_rate:
        wav = torchaudio.functional.resample(wav, sr, bundle.sample_rate)
        sr = bundle.sample_rate
    p(8)
    model = bundle.get_model(with_star=True)
    device = "cpu"  # forced_align has no MPS kernel; emissions are cheap enough
    model = model.to(device).eval()
    p(20)
    CHUNK = 30 * sr
    ems = []
    with torch.inference_mode():
        n = wav.size(1)
        steps = max(1, (n + CHUNK - 1) // CHUNK)
        for c in range(steps):
            piece = wav[:, c * CHUNK : (c + 1) * CHUNK]
            if piece.size(1) < 400:
                break
            em, _ = model(piece.to(device))
            ems.append(em[0].cpu())
            p(20 + 60 * (c + 1) / steps)
    emission = torch.cat(ems, 0)
    frames = emission.size(0)
    spf = wav.size(1) / sr / frames  # seconds per frame
    dic = bundle.get_dict()  # includes the <star> wildcard
    star = dic["*"]
    aligned_ids = [star]  # leading star absorbs the intro
    spans = []            # (tok_index, n_chars) — star tokens excluded
    last_line = None
    for k, t in enumerate(toks):
        w = t.get("t", "")
        ids = [dic[ch] for ch in w if ch in dic]
        if not ids:
            continue
        line = t.get("l")
        if last_line is not None and line != last_line:
            # a star between lines parks interludes/breathers on the wildcard
            # instead of stretching word tokens across instrumental gaps
            aligned_ids.append(star)
        last_line = line
        spans.append((k, len(ids)))
        aligned_ids.extend(ids)
    aligned_ids.append(star)  # trailing star absorbs the outro
    if len(aligned_ids) <= 2:
        print(json.dumps({"error": "no alignable words"})); sys.exit(0)
    targets = torch.tensor([aligned_ids], dtype=torch.int32)
    alignment, scores = torchaudio.functional.forced_align(
        emission.unsqueeze(0), targets, blank=0
    )
    p(92)
    token_spans = torchaudio.functional.merge_tokens(alignment[0], scores[0].exp())
    token_spans = [s for s in token_spans if s.token != star]
    # regroup char spans into words
    out = []
    ci = 0
    for k, n_chars in spans:
        chunk = token_spans[ci : ci + n_chars]
        ci += n_chars
        if not chunk:
            continue
        s = chunk[0].start * spf
        e = chunk[-1].end * spf
        sc = sum(c.score for c in chunk) / len(chunk)
        out.append({"i": toks[k]["i"], "s": round(s, 3), "e": round(e, 3), "score": round(float(sc), 4)})
    # CTC evidence peaks into the vowel, so phrase entries land ~100-200ms
    # late — snap words that follow a rest back to the local energy rise.
    xnp = wav[0].numpy()
    HOPS = sr // 100  # 10 ms
    m = len(xnp) // HOPS
    env = np.sqrt((xnp[: m * HOPS].reshape(m, HOPS) ** 2).mean(axis=1))
    loud = np.percentile(env[env > 0], 90) if (env > 0).any() else 0.0
    T, quiet = loud * 0.15, loud * 0.06
    for k in range(len(out)):
        w = out[k]
        prev_e = out[k - 1]["e"] if k > 0 else 0.0
        if w["s"] - prev_e < 0.3 or loud == 0:
            continue
        i1 = int(w["s"] * 100)
        i0 = max(int(prev_e * 100) + 1, i1 - 30)
        best = None
        for i in range(min(i1 + 8, m - 1), i0, -1):
            if env[i] >= T and env[max(0, i - 3) : i].min() < quiet:
                best = i / 100.0
                # keep scanning back — we want the earliest rise of this note
        if best is not None and best < w["s"]:
            w["s"] = round(max(prev_e + 0.01, best), 3)
    p(100)
    print(json.dumps({"words": out}))
except Exception as ex:
    print(json.dumps({"error": "%s: %s" % (type(ex).__name__, ex)}))
`

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

  const child = spawn(packPython(), ['-c', ALIGN_PY, wavPath, tokensPath], {
    env: {
      ...spawnEnv(),
      PYTHONUNBUFFERED: '1',
      TORCH_HOME: torchHome(),
      HF_HUB_OFFLINE: '1'
    }
  })

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
    child.on('exit', (code) => {
      void rm(dir, { recursive: true, force: true })
      try {
        const parsed = JSON.parse(out.trim().split('\n').pop() ?? '') as {
          words?: { i: number; s: number; e: number; score: number }[]
          error?: string
        }
        if (parsed.error || !parsed.words) throw new Error(parsed.error ?? 'no output')
        const words: CtcWord[] = []
        for (const w of parsed.words) {
          const src = flat[w.i]
          if (!src) continue
          words.push({ li: src.li, wi: src.wi, s: w.s, e: w.e, score: w.score })
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
