#!/usr/bin/env bash
# Build the optional "Fast splitter (GPU)" pack: a relocatable Python with
# torch (MPS) + demucs, tarred for download via the setup wizard.
# macOS Apple Silicon only — MPS does not exist elsewhere.
# Usage: scripts/build-gpu-pack.sh   → vendor/packs/gpu-splitter-darwin-arm64.tar.gz
set -euo pipefail
export PYTHONDONTWRITEBYTECODE=1   # keep build-time runs from re-littering __pycache__

# Pinned engine set — proven to split with NO ffmpeg on PATH (sphn decodes
# mp3/wav/flac/ogg natively; the app renders a WAV for everything else).
# torchaudio is deliberately absent: demucs 4.1 never imports it, and since
# 2.9 its load()/save() raise ImportError without torchcodec (which needs
# system ffmpeg libs). Bump pins only if the no-ffmpeg smoke split passes.
TORCH_PIN="torch==2.13.0"
DEMUCS_PIN="demucs==4.1.0"
SPHN_PIN="sphn==0.2.1"
NUMPY_PIN="numpy==2.5.1"

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

find "$WORK/python" -name '__pycache__' -type d -prune -exec rm -rf {} +

# version stamp: the app refuses packs older than its required format
cat > "$WORK/python/pack.json" << EOF
{ "formatVersion": 3, "target": "darwin-arm64", "builtAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)" }
EOF

tar -C "$WORK" -czf "$OUT/gpu-splitter-darwin-arm64.tar.gz" python
du -sh "$WORK/python" "$OUT/gpu-splitter-darwin-arm64.tar.gz"
echo "pack ready: $OUT/gpu-splitter-darwin-arm64.tar.gz"
