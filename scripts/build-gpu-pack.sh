#!/usr/bin/env bash
# Build the optional "Fast splitter (GPU)" pack: a relocatable Python with
# torch (MPS) + demucs, tarred for download via the setup wizard.
# macOS Apple Silicon only — MPS does not exist elsewhere.
# Usage: scripts/build-gpu-pack.sh   → vendor/packs/gpu-splitter-darwin-arm64.tar.gz
set -euo pipefail

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
if ! "$PY" -c "import demucs, torch" >/dev/null 2>&1; then
  rm -rf "$WORK/python"
  tar -C "$WORK" -xzf "$WORK/$PBS_PY"   # extracts to $WORK/python
  "$PY" -m pip install --no-cache-dir --upgrade pip >/dev/null
  "$PY" -m pip install --no-cache-dir torch torchaudio demucs numpy
fi

# prune what inference never needs
find "$WORK/python" -name '__pycache__' -type d -prune -exec rm -rf {} +
rm -rf "$WORK/python/lib/python3.12/site-packages/pip" \
       "$WORK/python/lib/python3.12/site-packages/setuptools" \
       "$WORK/python/lib/python3.12/site-packages/torch/include" \
       "$WORK/python/lib/python3.12/site-packages/torch/test"

# embed the htdemucs checkpoint so the first split needs no download
# (demucs 4.1 fetches via huggingface-hub → HF_HOME; older paths use TORCH_HOME)
mkdir -p "$WORK/python/torch-home" "$WORK/python/hf-home"
TORCH_HOME="$WORK/python/torch-home" HF_HOME="$WORK/python/hf-home" \
  "$PY" -c "from demucs.pretrained import get_model; get_model('htdemucs')"
# HF caches checkpoints as extension-less blobs — assert on any large file
FOUND=$(find "$WORK/python/torch-home" "$WORK/python/hf-home" -type f -size +10M 2>/dev/null | head -1 || true)
[ -n "$FOUND" ] || { echo "checkpoint embed failed"; exit 1; }
echo "embedded checkpoint blob: $FOUND ($(du -h "$FOUND" | cut -f1))"

# sanity: demucs must import and answer --help with this python
"$PY" -m demucs --help >/dev/null

tar -C "$WORK" -czf "$OUT/gpu-splitter-darwin-arm64.tar.gz" python
du -sh "$WORK/python" "$OUT/gpu-splitter-darwin-arm64.tar.gz"
echo "pack ready: $OUT/gpu-splitter-darwin-arm64.tar.gz"
