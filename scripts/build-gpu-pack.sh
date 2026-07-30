#!/usr/bin/env bash
# Build the optional "Fast splitter (GPU)" pack: a relocatable Python with
# torch (MPS) + demucs, tarred for download via the setup wizard.
# macOS Apple Silicon only — MPS does not exist elsewhere.
# Usage: scripts/build-gpu-pack.sh   → vendor/packs/gpu-splitter-darwin-arm64.tar.gz
set -euo pipefail
export PYTHONDONTWRITEBYTECODE=1   # keep build-time runs from re-littering __pycache__

# Pinned engine set — proven to split with NO ffmpeg on PATH (sphn decodes
# mp3/wav/flac/ogg natively; the app renders a WAV for everything else).
# torchaudio USED to be deliberately absent (its load()/save() need torchcodec
# since 2.9); Beat This needs torchaudio.transforms.MelSpectrogram, which is
# pure torch — torchaudio 2.11.0 declares no deps, never touches torchcodec on
# that path, and demucs still never imports it (the no-ffmpeg smoke split
# below proves the coexistence). Bump pins only if that smoke split passes.
TORCH_PIN="torch==2.13.0"
DEMUCS_PIN="demucs==4.1.0"
SPHN_PIN="sphn==0.2.1"
NUMPY_PIN="numpy==2.5.1"

# Beat This! beat/downbeat model (MIT, code AND weights) — runs as
# python/beat_runner.py on f32 PCM, weights embedded so it works offline.
BEAT_THIS_COMMIT="b95c8ab0c58c2d9fcfd40508ae8dffbc05ac4f5c"
BEAT_THIS_PIN="beat_this @ git+https://github.com/CPJKU/beat_this@${BEAT_THIS_COMMIT}"
TORCHAUDIO_PIN="torchaudio==2.11.0"
EINOPS_PIN="einops==0.8.2"
ROTARY_PIN="rotary-embedding-torch==0.9.1"
SOXR_PIN="soxr==1.1.0"
BEAT_CKPT_SHA256="8c328b45f59d8dd3dff219253ff6a8d6482be57d0133a29140e2febbf8eb8331"
BEAT_CKPT_URL="https://cloud.cp.jku.at/public.php/dav/files/7ik4RrBKTS273gp/final0.ckpt"

PBS_TAG="20260718"
PBS_PY="cpython-3.12.13+${PBS_TAG}-aarch64-apple-darwin-install_only.tar.gz"
PBS_URL="https://github.com/astral-sh/python-build-standalone/releases/download/${PBS_TAG}/${PBS_PY}"

ROOT=$(cd "$(dirname "$0")/.." && pwd)
WORK="$ROOT/.engines-src/gpu-pack"
OUT="$ROOT/vendor/packs"
mkdir -p "$WORK" "$OUT"

if [ -f "$OUT/gpu-splitter-darwin-arm64.tar.gz" ]; then
  echo "cached: vendor/packs/gpu-splitter-darwin-arm64.tar.gz"
  exit 0
fi

if [ ! -f "$WORK/$PBS_PY" ]; then
  curl -L --fail -o "$WORK/$PBS_PY" "$PBS_URL"
fi

PY="$WORK/python/bin/python3"
if ! "$PY" -c "import demucs, torch; assert torch.__version__ == '${TORCH_PIN#*==}' and demucs.__version__ == '${DEMUCS_PIN#*==}'" >/dev/null 2>&1; then
  rm -rf "$WORK/python"
  tar -C "$WORK" -xzf "$WORK/$PBS_PY"   # extracts to $WORK/python
  "$PY" -m pip install --no-cache-dir --upgrade pip >/dev/null
  "$PY" -m pip install --no-cache-dir "$TORCH_PIN" "$DEMUCS_PIN" "$SPHN_PIN" "$NUMPY_PIN"
fi

# add beat_this (+ its pinned deps) — reused work trees had pip pruned, so
# bootstrap it back first; torch/numpy pins ride along so the resolver can
# never float them
if ! "$PY" -c "import beat_this, torchaudio; assert torchaudio.__version__ == '${TORCHAUDIO_PIN#*==}'" >/dev/null 2>&1; then
  if ! "$PY" -m pip --version >/dev/null 2>&1; then
    # the pack prune strips the pip package but leaves its dist-info, which
    # makes ensurepip believe pip is still there — clear both, then bootstrap
    rm -rf "$WORK/python/lib/python3.12/site-packages/pip" \
           "$WORK/python/lib/python3.12/site-packages"/pip-*.dist-info
    "$PY" -m ensurepip >/dev/null
    "$PY" -m pip --version >/dev/null 2>&1 || { echo "could not bootstrap pip in the pack python" >&2; exit 1; }
  fi
  "$PY" -m pip install --no-cache-dir "$TORCH_PIN" "$NUMPY_PIN" "$TORCHAUDIO_PIN" \
    "$EINOPS_PIN" "$ROTARY_PIN" "$SOXR_PIN" "$BEAT_THIS_PIN"
fi
# MelSpectrogram must import (pure-torch path), and demucs must still import
# untouched — it must never start seeing torchaudio features that pull
# torchcodec (the no-ffmpeg smoke split below is the real proof).
"$PY" -c "import torchaudio.transforms; from beat_this.inference import load_model"
"$PY" -c "import demucs, torch; assert torch.__version__ == '${TORCH_PIN#*==}' and demucs.__version__ == '${DEMUCS_PIN#*==}'"

# prune what inference never needs
rm -rf "$WORK/python/lib/python3.12/site-packages/pip" \
       "$WORK/python/lib/python3.12/site-packages/setuptools" \
       "$WORK/python/lib/python3.12/site-packages/torch/include" \
       "$WORK/python/lib/python3.12/site-packages/torch/test"

# embed the htdemucs_6s checkpoint so the first split needs no download
# (demucs 4.1 fetches via huggingface-hub → HF_HOME; older paths use TORCH_HOME)
rm -rf "$WORK/python/torch-home" "$WORK/python/hf-home"   # only the current model ships
mkdir -p "$WORK/python/torch-home" "$WORK/python/hf-home"
TORCH_HOME="$WORK/python/torch-home" HF_HOME="$WORK/python/hf-home" \
  "$PY" -c "from demucs.pretrained import get_model; get_model('htdemucs_6s')"
# HF caches checkpoints as extension-less blobs — assert on any large file
FOUND=$(find "$WORK/python/torch-home" "$WORK/python/hf-home" -type f -size +10M 2>/dev/null | head -1 || true)
[ -n "$FOUND" ] || { echo "checkpoint embed failed"; exit 1; }
echo "embedded checkpoint blob: $FOUND ($(du -h "$FOUND" | cut -f1))"

# sanity: demucs must import and answer --help with this python
"$PY" -m demucs --help >/dev/null

# smoke split: end-user machines have no ffmpeg and no network — the pack
# must split an mp3 on a bare PATH using only its embedded checkpoint.
# (The v0.7.0 rebuild scare: unpinned deps can silently change audio IO.)
SMOKE="$WORK/smoke"
rm -rf "$SMOKE"
mkdir -p "$SMOKE/home"
"$PY" - "$SMOKE/tone.mp3" << 'PYEOF'
import sys
import numpy as np
import torch
from demucs.audio import encode_mp3
sr = 44100
t = np.arange(sr * 4) / sr
mono = (0.3 * np.sin(2 * np.pi * 82.4 * t) + 0.15 * np.sin(2 * np.pi * 440 * t)).astype('float32')
encode_mp3(torch.from_numpy(np.stack([mono, mono])), sys.argv[1], sr, 128, 7, verbose=False)
PYEOF
env -i PATH="/usr/bin:/bin" HOME="$SMOKE/home" \
  TORCH_HOME="$WORK/python/torch-home" HF_HOME="$WORK/python/hf-home" HF_HUB_OFFLINE=1 \
  "$PY" -m demucs -d cpu -n htdemucs_6s --filename '{stem}.{ext}' -o "$SMOKE/out" "$SMOKE/tone.mp3"
for stem in vocals drums bass guitar piano other; do
  [ -s "$SMOKE/out/htdemucs_6s/$stem.wav" ] || { echo "smoke split produced no $stem.wav"; exit 1; }
done
echo "smoke split OK (no ffmpeg, offline)"
rm -rf "$SMOKE"

# ---- Beat This! ---------------------------------------------------------
# Embed the final0 checkpoint (77 MB, sha-pinned) next to the runner: the
# runner loads it by explicit relative path, never the network. The download
# is cached in .engines-src (the ONNX pack export reuses the same file).
BEAT_CKPT="$ROOT/.engines-src/beat-models/final0.ckpt"
mkdir -p "$(dirname "$BEAT_CKPT")"
sha_of() { "$PY" -c "import hashlib,sys; print(hashlib.sha256(open(sys.argv[1],'rb').read()).hexdigest())" "$1"; }
if [ -f "$BEAT_CKPT" ] && [ "$(sha_of "$BEAT_CKPT")" != "$BEAT_CKPT_SHA256" ]; then
  echo "cached beat checkpoint has a wrong sha256 — refetching"
  rm -f "$BEAT_CKPT"
fi
if [ ! -f "$BEAT_CKPT" ]; then
  curl -L --fail -o "$BEAT_CKPT" "$BEAT_CKPT_URL"
fi
[ "$(sha_of "$BEAT_CKPT")" = "$BEAT_CKPT_SHA256" ] || { echo "beat checkpoint sha256 mismatch" >&2; exit 1; }

mkdir -p "$WORK/python/models/beat_this"
cp "$BEAT_CKPT" "$WORK/python/models/beat_this/final0.ckpt"
cp "$ROOT/scripts/beat_runner.py" "$WORK/python/beat_runner.py"

# BEAT SMOKE: like the split smoke, on a bare PATH — the shipped runner must
# find 120 bpm and 4/4 downbeats on a synthesized click track, offline.
BSMOKE="$WORK/beat-smoke"
rm -rf "$BSMOKE"
mkdir -p "$BSMOKE/home"
"$PY" "$ROOT/scripts/beat_runner_fixture.py" --out "$BSMOKE/click.f32" --sr 22050 --secs 60
env -i PATH="/usr/bin:/bin" HOME="$BSMOKE/home" HF_HUB_OFFLINE=1 PYTHONUNBUFFERED=1 \
  "$PY" "$WORK/python/beat_runner.py" --f32 "$BSMOKE/click.f32" --sr 22050 > "$BSMOKE/out.json"
"$PY" "$ROOT/scripts/beat_runner_check.py" "$BSMOKE/out.json"
echo "beat smoke OK (no network, bare PATH)"
rm -rf "$BSMOKE"

find "$WORK/python" -name '__pycache__' -type d -prune -exec rm -rf {} +

# version stamp: the app refuses packs older than its required format
# (v4 = the pack ships the Beat This runner + weights — keep in sync with
# PACK_FORMAT_REQUIRED in src/main/models.ts)
cat > "$WORK/python/pack.json" << EOF
{ "formatVersion": 4, "target": "darwin-arm64", "builtAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)" }
EOF

tar -C "$WORK" -czf "$OUT/gpu-splitter-darwin-arm64.tar.gz" python
du -sh "$WORK/python" "$OUT/gpu-splitter-darwin-arm64.tar.gz"
echo "pack ready: $OUT/gpu-splitter-darwin-arm64.tar.gz"
