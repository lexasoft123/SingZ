#!/usr/bin/env bash
# Windows fast-splitter pack: relocatable Python + demucs-onnx +
# onnxruntime-directml, with the htdemucs fp16 ONNX model prewarmed into
# python/model-cache. Runs on Windows (CI git-bash). GPU via DirectML works on
# any vendor (NVIDIA/AMD/Intel iGPU); falls back to CPU, which is still ~5x
# faster than the bundled demucs.cpp.
set -euo pipefail

PBS_TAG="20260718"
PBS_PY="cpython-3.12.13+${PBS_TAG}-x86_64-pc-windows-msvc-install_only.tar.gz"
PBS_URL="https://github.com/astral-sh/python-build-standalone/releases/download/${PBS_TAG}/${PBS_PY}"

ROOT=$(cd "$(dirname "$0")/.." && pwd)
WORK="$ROOT/.engines-src/onnx-pack"
OUT="$ROOT/vendor/packs"
OUTFILE="$OUT/gpu-splitter-win32-x64.tar.gz"

if [ -f "$OUTFILE" ]; then
  echo "cached: vendor/packs/$(basename "$OUTFILE")"
  exit 0
fi
mkdir -p "$WORK" "$OUT"

if [ ! -f "$WORK/$PBS_PY" ]; then
  curl -L --fail -o "$WORK/$PBS_PY" "$PBS_URL"
fi

PY="$WORK/python/python.exe"
if ! "$PY" -c "import demucs_onnx, onnxruntime" >/dev/null 2>&1; then
  rm -rf "$WORK/python"
  tar -C "$WORK" -xzf "$WORK/$PBS_PY"
  "$PY" -m pip install --no-cache-dir --upgrade pip >/dev/null
  "$PY" -m pip install --no-cache-dir demucs-onnx
  # swap the CPU-only onnxruntime for the DirectML build (same module name)
  "$PY" -m pip uninstall -y onnxruntime >/dev/null
  "$PY" -m pip install --no-cache-dir onnxruntime-directml
fi

# embed the model + validate the stack (CPU provider: CI runners have no GPU)
"$PY" -c "import sys; from demucs_onnx.cli import main; sys.exit(main())" \
  prewarm --models htdemucs --precision fp16weights --providers cpu \
  --cache-dir "$WORK/python/model-cache"

# The hub cache links snapshots/<rev>/<file> to blobs/<hash> with a SYMLINK
# (CI runs as admin, so creating one succeeds). End users' Windows tar cannot
# extract symlinks without admin rights — the v0.2.2 pack failed exactly
# there. Materialize every link into a real file, then drop blobs/ so the
# model isn't shipped twice.
find "$WORK/python/model-cache" -type l | while IFS= read -r link; do
  target=$(readlink -f "$link")
  rm "$link"
  cp "$target" "$link"
done
find "$WORK/python/model-cache" -type d -name blobs -prune -exec rm -rf {} +

if find "$WORK/python" -type l | grep -q .; then
  echo "ERROR: pack still contains symlinks:" >&2
  find "$WORK/python" -type l >&2
  exit 1
fi
find "$WORK/python/model-cache" -name 'htdemucs_fp16weights.onnx' -type f -size +100M \
  | grep -q . || { echo "ERROR: no materialized model file in the cache" >&2; exit 1; }

# the pruned cache must resolve fully offline — that is what user machines do
HF_HUB_OFFLINE=1 "$PY" -c "import sys; from demucs_onnx.cli import main; sys.exit(main())" \
  prewarm --models htdemucs --precision fp16weights --providers cpu \
  --cache-dir "$WORK/python/model-cache"

find "$WORK/python" -name '__pycache__' -type d -prune -exec rm -rf {} +
rm -rf "$WORK/python/Lib/site-packages/pip" \
       "$WORK/python/Lib/site-packages/setuptools"

tar -C "$WORK" -czf "$OUTFILE" python
du -sh "$WORK/python" "$OUTFILE"
echo "pack ready: $OUTFILE"
