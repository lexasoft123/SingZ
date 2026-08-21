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
    # per-word voiced ratio vs the song's loud level: words the trellis parked
    # in vocal silence (choir/talk-box outros overwhelm the letter models and
    # the wildcard eats the real singing) must not anchor the retime
    for w in out:
        i0 = int(w["s"] * 100)
        i1 = max(i0 + 1, int(w["e"] * 100))
        seg = env[i0 : min(i1, m)]
        w["v"] = round(float(seg.mean() / loud), 3) if (loud > 0 and len(seg) > 0) else 0.0
    p(100)
    print(json.dumps({"words": out}))
except Exception as ex:
    print(json.dumps({"error": "%s: %s" % (type(ex).__name__, ex)}))
`

// ONNX-pack variant (Windows, Intel Macs): same protocol, same RIFF input,
// but emissions come from our exported mms-fa.onnx via onnxruntime and the
// CTC Viterbi runs in numpy. The torchaudio pipeline wrapper's three extras
// (whole-input layer norm, log_softmax, star column at log-prob 0) are
// replicated by hand. Label map is MMS_FA's, fixed by the export.
const ALIGN_ONNX_PY = String.raw`
import json, sys
def p(x):
    sys.stderr.write("P %d\n" % int(x)); sys.stderr.flush()
try:
    import numpy as np
    import onnxruntime as ort
    vocals, tokens_path, model_path = sys.argv[1], sys.argv[2], sys.argv[3]
    with open(tokens_path) as f:
        toks = json.load(f)
    p(2)
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
    kind, n_ch, in_sr, bits = fmt
    if kind == 3 or (kind == 0xFFFE and bits == 32):
        x = np.frombuffer(data, dtype=np.float32)
    elif kind in (1, 0xFFFE) and bits == 16:
        x = np.frombuffer(data, dtype=np.int16).astype(np.float32) / 32768.0
    else:
        raise ValueError("unsupported wav format %s/%s-bit" % (kind, bits))
    x = x.reshape(-1, n_ch).mean(axis=1).astype(np.float64)
    SR = 16000
    if in_sr != SR:
        # FFT resample: clean enough for feature extraction, no scipy needed
        n_out = int(round(len(x) * SR / in_sr))
        X = np.fft.rfft(x)
        keep = n_out // 2 + 1
        Y = np.zeros(keep, dtype=complex)
        Y[: min(keep, len(X))] = X[: min(keep, len(X))]
        x = np.fft.irfft(Y, n_out) * (n_out / len(x))
    x = x.astype(np.float32)
    p(8)
    sess = ort.InferenceSession(model_path, providers=["CPUExecutionProvider"])
    p(20)
    CHUNK = 30 * SR
    ems = []
    n = len(x)
    steps = max(1, (n + CHUNK - 1) // CHUNK)
    for c in range(steps):
        piece = x[c * CHUNK : (c + 1) * CHUNK]
        if len(piece) < 400:
            break
        # torchaudio wrapper: layer_norm over the whole (chunk) input
        piece = (piece - piece.mean()) / np.sqrt(piece.var() + 1e-5)
        logits = sess.run(None, {"waveform": piece[None, :]})[0][0]
        # log_softmax + star column at log-prob 0 (the wildcard trick)
        lse = np.log(np.exp(logits - logits.max(axis=1, keepdims=True)).sum(axis=1, keepdims=True)) + logits.max(axis=1, keepdims=True)
        logp = logits - lse
        star = np.zeros((logp.shape[0], 1), dtype=logp.dtype)
        ems.append(np.concatenate([logp, star], axis=1))
        p(20 + 55 * (c + 1) / steps)
    emission = np.concatenate(ems, axis=0)
    frames = emission.shape[0]
    spf = n / SR / frames
    DICT = {"-": 0, "a": 1, "i": 2, "e": 3, "n": 4, "o": 5, "u": 6, "t": 7, "s": 8, "r": 9, "m": 10, "k": 11, "l": 12, "d": 13, "g": 14, "h": 15, "y": 16, "b": 17, "p": 18, "w": 19, "c": 20, "v": 21, "j": 22, "z": 23, "f": 24, "'": 25, "q": 26, "x": 27, "*": 28}
    star = DICT["*"]
    aligned_ids = [star]
    spans = []  # (token index, start position in aligned_ids, char count)
    last_line = None
    for k, t in enumerate(toks):
        w = t.get("t", "")
        ids = [DICT[ch] for ch in w if ch in DICT]
        if not ids:
            continue
        line = t.get("l")
        if last_line is not None and line != last_line:
            aligned_ids.append(star)
        last_line = line
        spans.append((k, len(aligned_ids), len(ids)))
        aligned_ids.extend(ids)
    aligned_ids.append(star)
    if len(aligned_ids) <= 2:
        print(json.dumps({"error": "no alignable words"})); sys.exit(0)
    # CTC Viterbi over the standard blank-interleaved state graph
    tgt = aligned_ids
    S = 2 * len(tgt) + 1
    labels = np.zeros(S, dtype=np.int64)
    labels[1::2] = tgt
    can_skip = np.zeros(S, dtype=bool)
    for s in range(3, S, 2):
        can_skip[s] = labels[s] != labels[s - 2]
    NEG = np.float32(-1e30)
    dp = np.full(S, NEG, dtype=np.float32)
    dp[0] = emission[0, 0]
    if S > 1:
        dp[1] = emission[0, labels[1]]
    bp = np.zeros((frames, S), dtype=np.int8)
    em_lab = emission[:, labels]
    for t_i in range(1, frames):
        stay = dp
        prev = np.concatenate(([NEG], dp[:-1]))
        skip = np.concatenate(([NEG, NEG], dp[:-2]))
        skip = np.where(can_skip, skip, NEG)
        choice = np.argmax(np.stack([stay, prev, skip]), axis=0).astype(np.int8)
        best = np.maximum(np.maximum(stay, prev), skip)
        bp[t_i] = choice
        dp = best + em_lab[t_i]
        if t_i % 500 == 0:
            p(75 + 15 * t_i / frames)
    s = S - 1 if dp[S - 1] >= dp[S - 2] else S - 2
    path = np.zeros(frames, dtype=np.int32)
    for t_i in range(frames - 1, -1, -1):
        path[t_i] = s
        s -= int(bp[t_i, s])
    p(92)
    # state path -> per-token frame spans + mean prob scores
    tok_frames = {}
    probs = np.exp(em_lab[np.arange(frames), path])
    for t_i in range(frames):
        st = path[t_i]
        if st % 2 == 1:
            ti = (st - 1) // 2
            fr = tok_frames.setdefault(ti, [t_i, t_i, 0.0, 0])
            fr[1] = t_i
            fr[2] += float(probs[t_i])
            fr[3] += 1
    out = []
    for k, start, n_chars in spans:
        idxs = list(range(start, start + n_chars))
        frames_used = [tok_frames.get(i) for i in idxs if tok_frames.get(i)]
        if not frames_used:
            continue
        s0 = min(f[0] for f in frames_used) * spf
        e0 = (max(f[1] for f in frames_used) + 1) * spf
        sc = sum(f[2] for f in frames_used) / max(1, sum(f[3] for f in frames_used))
        out.append({"i": toks[k]["i"], "s": round(s0, 3), "e": round(e0, 3), "score": round(sc, 4)})
    p(94)
    xnp = x
    HOPS = SR // 100
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
                best = i / 100.0  # keep scanning back - earliest rise of this note
        if best is not None and best < w["s"]:
            w["s"] = round(max(prev_e + 0.01, best), 3)
    for w in out:
        i0 = int(w["s"] * 100)
        i1 = max(i0 + 1, int(w["e"] * 100))
        seg = env[i0 : min(i1, m)]
        w["v"] = round(float(seg.mean() / loud), 3) if (loud > 0 and len(seg) > 0) else 0.0
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
