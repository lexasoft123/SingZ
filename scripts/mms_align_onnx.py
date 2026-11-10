
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
