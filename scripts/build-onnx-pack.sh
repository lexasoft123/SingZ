#!/usr/bin/env bash
# ONNX splitter pack: relocatable Python + demucs-onnx with the htdemucs fp16
# model prewarmed into python/model-cache. This is the DEFAULT splitter the
# app downloads on first run (Windows + Intel Macs; Apple Silicon uses the
# torch/MPS pack from build-gpu-pack.sh).
#
# Usage: scripts/build-onnx-pack.sh [win32-x64|darwin-x64]
#   win32-x64  — onnxruntime-directml (GPU on any vendor, CPU fallback)
#   darwin-x64 — onnxruntime CPU (CoreML crashes on this graph)
set -euo pipefail

TARGET="${1:-win32-x64}"
PBS_TAG="20260718"
case "$TARGET" in
  win32-x64)
    PBS_PY="cpython-3.12.13+${PBS_TAG}-x86_64-pc-windows-msvc-install_only.tar.gz"
    PYBIN="python/python.exe"
    SITE="python/Lib/site-packages"
    WANT_DML=1
    ;;
  darwin-x64)
    PBS_PY="cpython-3.12.13+${PBS_TAG}-x86_64-apple-darwin-install_only.tar.gz"
    PYBIN="python/bin/python3"
    SITE="python/lib/python3.12/site-packages"
    WANT_DML=0
    ;;
  *)
    echo "unknown target: $TARGET" >&2
    exit 1
    ;;
esac
PBS_URL="https://github.com/astral-sh/python-build-standalone/releases/download/${PBS_TAG}/${PBS_PY}"

ROOT=$(cd "$(dirname "$0")/.." && pwd)
WORK="$ROOT/.engines-src/onnx-pack-$TARGET"
OUT="$ROOT/vendor/packs"
OUTFILE="$OUT/gpu-splitter-$TARGET.tar.gz"

if [ -f "$OUTFILE" ]; then
  echo "cached: vendor/packs/$(basename "$OUTFILE")"
  exit 0
fi
mkdir -p "$WORK" "$OUT"

if [ ! -f "$WORK/$PBS_PY" ]; then
  curl -L --fail -o "$WORK/$PBS_PY" "$PBS_URL"
fi

PY="$WORK/$PYBIN"
if ! "$PY" -c "import demucs_onnx, onnxruntime" >/dev/null 2>&1; then
  rm -rf "$WORK/python"
  tar -C "$WORK" -xzf "$WORK/$PBS_PY"
  "$PY" -m pip install --no-cache-dir --upgrade pip >/dev/null
  "$PY" -m pip install --no-cache-dir demucs-onnx
  if [ "$WANT_DML" = 1 ]; then
    # swap the CPU-only onnxruntime for the DirectML build (same module name)
    "$PY" -m pip uninstall -y onnxruntime >/dev/null
    "$PY" -m pip install --no-cache-dir onnxruntime-directml
  fi
fi

# only the current model ships — drop caches from earlier pack generations
rm -rf "$WORK/python/model-cache/models--StemSplitio--htdemucs-onnx"

# embed the model + validate the stack (CPU provider: CI runners have no GPU)
"$PY" -c "import sys; from demucs_onnx.cli import main; sys.exit(main())" \
  prewarm --models htdemucs_6s --precision fp16weights --providers cpu \
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
  if [ "$TARGET" = win32-x64 ]; then
    echo "ERROR: pack still contains symlinks:" >&2
    find "$WORK/python" -type l >&2
    exit 1
  fi
  # macOS python builds legitimately contain symlinks (bin/python3 etc.) and
  # macOS tar extracts them fine — only the model cache must be link-free.
  if find "$WORK/python/model-cache" -type l | grep -q .; then
    echo "ERROR: model cache still contains symlinks" >&2
    exit 1
  fi
fi
find "$WORK/python/model-cache" -name 'htdemucs_6s_fp16weights.onnx' -type f -size +100M \
  | grep -q . || { echo "ERROR: no materialized model file in the cache" >&2; exit 1; }

# the pruned cache must resolve fully offline — that is what user machines do
HF_HUB_OFFLINE=1 "$PY" -c "import sys; from demucs_onnx.cli import main; sys.exit(main())" \
  prewarm --models htdemucs_6s --precision fp16weights --providers cpu \
  --cache-dir "$WORK/python/model-cache"

find "$WORK/python" -name '__pycache__' -type d -prune -exec rm -rf {} +
rm -rf "$WORK/$SITE/pip" "$WORK/$SITE/setuptools"

# version stamp: the app refuses packs older than its required format
cat > "$WORK/python/pack.json" << EOF
{ "formatVersion": 2, "target": "$TARGET", "builtAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)" }
EOF

tar -C "$WORK" -czf "$OUTFILE" python
du -sh "$WORK/python" "$OUTFILE"
echo "pack ready: $OUTFILE"
