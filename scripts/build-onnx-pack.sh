#!/usr/bin/env bash
# ONNX splitter pack: relocatable Python + demucs-onnx with the htdemucs fp16
# model prewarmed into python/model-cache. This is the DEFAULT splitter the
# app downloads on first run (Windows + Intel Macs; Apple Silicon uses the
# torch/MPS pack from build-gpu-pack.sh).
#
# Usage: scripts/build-onnx-pack.sh [win32-x64|darwin-x64]
#   win32-x64  — mainline onnxruntime + TensorRT-RTX plugin EP (RTX 30xx+)
#   darwin-x64 — onnxruntime CPU (CoreML crashes on this graph)
set -euo pipefail

TARGET="${1:-win32-x64}"
PBS_TAG="20260718"
case "$TARGET" in
  win32-x64)
    PBS_PY="cpython-3.12.13+${PBS_TAG}-x86_64-pc-windows-msvc-install_only.tar.gz"
    PYBIN="python/python.exe"
    SITE="python/Lib/site-packages"
    WIN_PACK=1
    ;;
  darwin-x64)
    PBS_PY="cpython-3.12.13+${PBS_TAG}-x86_64-apple-darwin-install_only.tar.gz"
    PYBIN="python/bin/python3"
    SITE="python/lib/python3.12/site-packages"
    WIN_PACK=0
    ;;
  *)
    echo "unknown target: $TARGET" >&2
    exit 1
    ;;
esac
PBS_URL="https://github.com/astral-sh/python-build-standalone/releases/download/${PBS_TAG}/${PBS_PY}"

# Beat This! beat/downbeat model (MIT, code AND weights): exported to ONNX at
# build time from the sha-pinned final0 checkpoint, shipped with a numpy +
# onnxruntime runner (python/beat_runner.py). CPU provider only — 6 s/song;
# the DirectML fragility class stays quarantined to demucs.
BEAT_THIS_COMMIT="b95c8ab0c58c2d9fcfd40508ae8dffbc05ac4f5c"
BEAT_THIS_PIN="beat_this @ git+https://github.com/CPJKU/beat_this@${BEAT_THIS_COMMIT}"
TORCH_EXPORT_PIN="torch==2.13.0"
TORCHAUDIO_PIN="torchaudio==2.11.0"
NUMPY_PIN="numpy==2.5.1"
EINOPS_PIN="einops==0.8.2"
ROTARY_PIN="rotary-embedding-torch==0.9.1"
SOXR_PIN="soxr==1.1.0"
ONNX_PIN="onnx==1.22.0"             # the legacy exporter needs onnx…
ONNXSCRIPT_PIN="onnxscript==0.7.1"  # …and the dynamo fallback needs onnxscript
BEAT_CKPT_SHA256="8c328b45f59d8dd3dff219253ff6a8d6482be57d0133a29140e2febbf8eb8331"
BEAT_CKPT_URL="https://cloud.cp.jku.at/public.php/dav/files/7ik4RrBKTS273gp/final0.ckpt"

# TensorRT-RTX plugin EP (win32 only): DML is frozen at ORT 1.24 (sustained
# engineering) and dies on htdemucs both fused (TDR device-hung) and unfused
# (ISTFT ConvTranspose OOM). NVIDIA's prebuilt zip is self-contained — the
# EP dll AND the whole TRT-RTX runtime — and rides MAINLINE ort, shipped
# side by side under python/rtx and swapped into sys.path by the runner.
# cu12 flavor: oldest-driver compatibility across the fleet (581.x is fine).
TRTRTX_EP_TAG="v0.4.0"
TRTRTX_EP_ZIP="TensorRT-RTX-EP-ABI-${TRTRTX_EP_TAG}-cu12.zip"
TRTRTX_EP_URL="https://github.com/NVIDIA/TensorRT-RTX-EP-ABI/releases/download/${TRTRTX_EP_TAG}/${TRTRTX_EP_ZIP}"
ORT_MAINLINE_PIN="onnxruntime==1.28.0"
# The EP dll hard-depends on cudart64_12.dll, which drivers never install
# (nvml comes with the driver; cudart is the app's to ship) — proven on the
# bench Dell. The wheel carries nvidia/cuda_runtime/bin/cudart64_12.dll.
CUDART_WHL_URL="https://files.pythonhosted.org/packages/59/df/e7c3a360be4f7b93cee39271b792669baeb3846c58a4df6dfcf187a7ffab/nvidia_cuda_runtime_cu12-12.9.79-py3-none-win_amd64.whl"
# THE model (one file, both engines): the raw export is partition-hostile
# (24.8k nodes, ~20k shape machinery + 684 ScatterND) and its ISTFT-as-
# ConvTranspose ate 98% of all GPU time (per-layer field profile, RTX 3060
# at 100% util / 95 W losing to its own CPU). The pinned artifact is the
# offline-rebuilt graph: onnxsim-folded with the fixed (1,2,343980) input
# (needs ~16+ GB — std::bad_alloc on the CI runner, hence offline), ISTFT
# rewritten as MatMul + overlap-add (2.42 s per song on a 4060 Ti, RTF
# 0.02), weights stored fp16 with cast-to-fp32 (the original distribution's
# own trick; parity 2.3e-05). It REPLACES the prewarmed original in the hub
# cache, so cpu and TensorRT-RTX load the identical file; the parity gate
# below proves the swap against the just-prewarmed original on every build.
# Regenerate: onnxsim 0.7.3 fold -> ISTFT OLA rewrite -> fp16 initializers
# >1MB (2026-08-13 GPU investigation); upload to models-1, update sha256.
SIM_MODEL_URL="https://github.com/lexasoft123/SingZ/releases/download/models-1/htdemucs_6s_sim_fp16.onnx"
SIM_MODEL_SHA256="a339096332dc5cac7789431d9e59b2b1dd3d3b93724a3455b2a3886c7544925f"

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
  if [ "$WIN_PACK" = 1 ]; then
    # ONE onnxruntime: mainline, pinned — it hosts the TensorRT-RTX plugin
    # EP (needs >=1.23) and runs the cpu provider and the beat runner. The
    # frozen onnxruntime-directml wheel left with DirectML itself.
    "$PY" -m pip uninstall -y onnxruntime >/dev/null
    "$PY" -m pip install --no-cache-dir "$ORT_MAINLINE_PIN"
  fi
fi

# only the current model ships — drop caches from earlier pack generations
rm -rf "$WORK/python/model-cache/models--StemSplitio--htdemucs-onnx"

if [ "$TARGET" = win32-x64 ]; then
  # onnxruntime needs the MSVC C++ runtime; clean Windows installs lack it.
  # Microsoft permits redistributing these DLLs — ship them beside python.exe
  # (the application directory wins the DLL search order).
  for dll in msvcp140.dll msvcp140_1.dll msvcp140_2.dll vcruntime140.dll vcruntime140_1.dll; do
    [ -f "/c/Windows/System32/$dll" ] && cp "/c/Windows/System32/$dll" "$WORK/python/" || true
  done
  [ -f "$WORK/python/msvcp140.dll" ] || { echo "ERROR: msvcp140.dll not bundled" >&2; exit 1; }
  [ -f "$WORK/python/vcruntime140.dll" ] || { echo "ERROR: vcruntime140.dll not bundled" >&2; exit 1; }

  # ---- TensorRT-RTX plugin EP payload -----------------------------------
  if [ ! -d "$WORK/python/rtx/ep" ]; then
    if [ ! -f "$WORK/$TRTRTX_EP_ZIP" ]; then
      curl -L --fail -o "$WORK/$TRTRTX_EP_ZIP" "$TRTRTX_EP_URL"
    fi
    rm -rf "$WORK/python/rtx"
    mkdir -p "$WORK/python/rtx"
    "$PY" -c "import zipfile,sys; zipfile.ZipFile(sys.argv[1]).extractall(sys.argv[2])" \
      "$WORK/$TRTRTX_EP_ZIP" "$WORK/python/rtx/ep-unpack"
    mv "$WORK/python/rtx/ep-unpack"/TensorRT-RTX-EP-ABI-* "$WORK/python/rtx/ep"
    rmdir "$WORK/python/rtx/ep-unpack"
    rm -f "$WORK/python/rtx/ep"/*.pdb
    [ -f "$WORK/python/rtx/ep/onnxruntime_providers_nv_tensorrt_rtx.dll" ] \
      || { echo "ERROR: TRT-RTX EP dll missing after unzip" >&2; exit 1; }
    if [ ! -f "$WORK/cudart.whl" ]; then
      curl -L --fail -o "$WORK/cudart.whl" "$CUDART_WHL_URL"
    fi
    "$PY" -c "
import os, sys, zipfile
z = zipfile.ZipFile(sys.argv[1])
dlls = [n for n in z.namelist() if n.lower().endswith('.dll')]
assert dlls, 'no dlls in cudart wheel'
for n in dlls:
    open(os.path.join(sys.argv[2], os.path.basename(n)), 'wb').write(z.read(n))
print('cudart shipped:', [os.path.basename(n) for n in dlls])
" "$WORK/cudart.whl" "$WORK/python/rtx/ep"
    [ -f "$WORK/python/rtx/ep/cudart64_12.dll" ] || { echo "ERROR: cudart64_12.dll missing" >&2; exit 1; }
  fi
fi

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

# ---- Beat This! ---------------------------------------------------------
# The export needs a TORCH-capable python (the pack itself never ships
# torch). On macOS reuse the gpu pack's work python — build-gpu-pack.sh runs
# first, locally and in CI. On Windows CI there is no gpu pack, so bootstrap
# a scratch venv off the pack python (torch CPU wheels; ~2 min).
sha_of() { "$PY" -c "import hashlib,sys; print(hashlib.sha256(open(sys.argv[1],'rb').read()).hexdigest())" "$1"; }
BEAT_CKPT="$ROOT/.engines-src/beat-models/final0.ckpt"
mkdir -p "$(dirname "$BEAT_CKPT")"
if [ -f "$BEAT_CKPT" ] && [ "$(sha_of "$BEAT_CKPT")" != "$BEAT_CKPT_SHA256" ]; then
  echo "cached beat checkpoint has a wrong sha256 — refetching"
  rm -f "$BEAT_CKPT"
fi
if [ ! -f "$BEAT_CKPT" ]; then
  curl -L --fail -o "$BEAT_CKPT" "$BEAT_CKPT_URL"
fi
[ "$(sha_of "$BEAT_CKPT")" = "$BEAT_CKPT_SHA256" ] || { echo "beat checkpoint sha256 mismatch" >&2; exit 1; }

# The export runs in a venv so onnx/onnxscript (exporter-only deps) never
# leak into any shipped pack. On macOS the venv layers over the gpu pack's
# work python (--system-site-packages: torch + beat_this come from there);
# on Windows it is self-contained off the pack python (torch CPU wheels).
EXPORT_VENV="$ROOT/.engines-src/beat-export-$TARGET"
if [ "$TARGET" = win32-x64 ]; then
  EXPORT_PY="$EXPORT_VENV/Scripts/python.exe"
else
  EXPORT_PY="$EXPORT_VENV/bin/python3"
fi
if ! "$EXPORT_PY" -c "import torch, beat_this, onnx, onnxscript" >/dev/null 2>&1; then
  rm -rf "$EXPORT_VENV"
  if [ "$TARGET" = win32-x64 ]; then
    "$PY" -m venv "$EXPORT_VENV"
    "$EXPORT_PY" -m pip install --no-cache-dir --upgrade pip >/dev/null
    "$EXPORT_PY" -m pip install --no-cache-dir "$TORCH_EXPORT_PIN" "$NUMPY_PIN" \
      "$TORCHAUDIO_PIN" "$EINOPS_PIN" "$ROTARY_PIN" "$SOXR_PIN" "$BEAT_THIS_PIN" \
      "$ONNX_PIN" "$ONNXSCRIPT_PIN"
  else
    GPU_PY="$ROOT/.engines-src/gpu-pack/python/bin/python3"
    if ! { [ -x "$GPU_PY" ] && "$GPU_PY" -c "import torch, beat_this" >/dev/null 2>&1; }; then
      echo "ERROR: no torch python for the Beat This ONNX export —" >&2
      echo "       run scripts/build-gpu-pack.sh first (it provides one)" >&2
      exit 1
    fi
    "$GPU_PY" -m venv --system-site-packages "$EXPORT_VENV"
    "$EXPORT_PY" -m pip install --no-cache-dir --upgrade pip >/dev/null
    "$EXPORT_PY" -m pip install --no-cache-dir "$ONNX_PIN" "$ONNXSCRIPT_PIN"
  fi
fi

# ---- The ONE model: simplified graph, OLA ISTFT, fp16 weights ------------
# Fetch the pinned artifact, PARITY-GATE it against the just-prewarmed
# original through the pack's own onnxruntime (same discipline as the beat
# runner below), then REPLACE the original in the hub cache — cpu and
# TensorRT-RTX sessions load the identical file.
if [ "$TARGET" = win32-x64 ]; then
  MODEL_FILE=$(find "$WORK/python/model-cache" -name 'htdemucs_6s_fp16weights.onnx' -type f | head -n 1)
  [ -n "$MODEL_FILE" ] || { echo "ERROR: prewarmed model not found" >&2; exit 1; }
  TRT_MODEL="$WORK/htdemucs_6s_sim_fp16.onnx"
  if [ ! -f "$TRT_MODEL" ] || [ "$(sha_of "$TRT_MODEL")" != "$SIM_MODEL_SHA256" ]; then
    curl -L --fail -o "$TRT_MODEL" "$SIM_MODEL_URL"
  fi
  [ "$(sha_of "$TRT_MODEL")" = "$SIM_MODEL_SHA256" ] \
    || { echo "ERROR: sim model sha256 mismatch" >&2; exit 1; }
  "$PY" - "$MODEL_FILE" "$TRT_MODEL" << 'PYEOF'
import sys

import numpy as np
import onnxruntime as ort

rng = np.random.default_rng(7)
x = (rng.standard_normal((1, 2, 343980)) * 0.1).astype(np.float32)
out = []
for path in sys.argv[1:3]:
    sess = ort.InferenceSession(path, providers=["CPUExecutionProvider"])
    out.append(sess.run(["stems"], {"mix": x})[0])
diff = float(np.abs(out[0] - out[1]).max())
print(f"slim-model parity vs original: max abs diff {diff:.2e}")
assert diff < 1e-3, f"parity broken: {diff}"
PYEOF
  cp "$TRT_MODEL" "$MODEL_FILE"
  echo "hub-cache model replaced with the slim graph"
fi

# Export the two graphs (recipe: CPJKU/beat_this#12): the 20M model with a
# FIXED (1,1500,128) input — the runner chunks and zero-pads — plus the mel
# front-end as matmul-DFT (no STFT op: bulletproof across exporters and EPs),
# verified against torchaudio.transforms.MelSpectrogram before it ships.
BEAT_ONNX_DIR="$WORK/python/models/beat_this"
mkdir -p "$BEAT_ONNX_DIR"
"$EXPORT_PY" - "$BEAT_CKPT" "$BEAT_ONNX_DIR" << 'PYEOF'
import sys
from pathlib import Path

import numpy as np
import torch
import torch.nn as nn

from beat_this.inference import load_model
from beat_this.preprocessing import LogMelSpect

ckpt, outdir = sys.argv[1], Path(sys.argv[2])
torch.manual_seed(0)


def export(module, args_t, path, in_names, out_names, dyn=None):
    try:
        torch.onnx.export(module, args_t, str(path), opset_version=17,
                          do_constant_folding=True, input_names=in_names,
                          output_names=out_names, dynamic_axes=dyn,
                          dynamo=False)
        return "legacy"
    except Exception as err:
        print(f"legacy exporter failed ({type(err).__name__}: {err}); "
              "retrying with dynamo", file=sys.stderr)
        torch.onnx.export(module, args_t, str(path), opset_version=17,
                          input_names=in_names, output_names=out_names,
                          dynamic_axes=dyn, dynamo=True)
        return "dynamo"


class HeadsToTuple(nn.Module):
    """BeatThis returns {'beat','downbeat'} — fix the output order for ONNX."""

    def __init__(self, m):
        super().__init__()
        self.m = m

    def forward(self, x):
        out = self.m(x)
        return out["beat"], out["downbeat"]


model = HeadsToTuple(load_model(ckpt, device="cpu")).eval()
mode = export(model, (torch.randn(1, 1500, 128),), outdir / "beat_this.onnx",
              ["spect"], ["beat", "downbeat"])
print(f"beat_this.onnx exported ({mode} exporter, opset 17, fixed 1500 frames)")

N_FFT, HOP = 1024, 441


class MelFrontend(nn.Module):
    """LogMelSpect minus the framing (the runner frames in numpy): windowed
    frames -> DFT as two matmuls -> magnitude / sqrt(n_fft) -> mel -> log1p."""

    def __init__(self, fb):
        super().__init__()
        n = torch.arange(N_FFT, dtype=torch.float64)
        k = torch.arange(N_FFT // 2 + 1, dtype=torch.float64)
        ang = 2 * torch.pi * k[None, :] * n[:, None] / N_FFT
        self.register_buffer("cos_m", torch.cos(ang).float())
        self.register_buffer("sin_m", torch.sin(ang).float())
        self.register_buffer("window", torch.hann_window(N_FFT).float())
        self.register_buffer("fb", fb.float())  # (513, 128) from torchaudio
        self.scale = float(N_FFT) ** -0.5       # normalized="frame_length"

    def forward(self, frames):                  # (N, 1024) windowed below
        w = frames * self.window
        re = w @ self.cos_m
        im = w @ self.sin_m
        mag = (re * re + im * im).sqrt() * self.scale
        return torch.log1p(1000.0 * (mag @ self.fb))


ref = LogMelSpect(device="cpu")
mel = MelFrontend(ref.spect_class.mel_scale.fb).eval()

# prove the matmul front-end + the runner's numpy framing == torchaudio
rng = np.random.default_rng(1)
sig = (rng.standard_normal(22050 * 20) * 0.1).astype(np.float32)
with torch.no_grad():
    want = ref(torch.tensor(sig))
    padded = np.pad(sig, N_FFT // 2, mode="reflect")
    frames = np.lib.stride_tricks.sliding_window_view(padded, N_FFT)[::HOP]
    got = mel(torch.tensor(np.ascontiguousarray(frames)))
assert want.shape == got.shape, (want.shape, got.shape)
diff = (want - got).abs().max().item()
print(f"mel front-end vs torchaudio: max abs log-mel diff {diff:.2e}")
assert diff < 2e-3, f"mel front-end mismatch: {diff}"

mode = export(mel, (torch.randn(2100, N_FFT),), outdir / "logmel.onnx",
              ["frames"], ["logmel"],
              dyn={"frames": {0: "n"}, "logmel": {0: "n"}})
print(f"logmel.onnx exported ({mode} exporter, opset 17, dynamic frames)")

# fp16 weights for the beat model (half the download); the runner casts
# back to fp32 at load and the parity gate below re-proves beats and
# downbeats against the torch reference. logmel stays fp32 — it is tiny
# and its DFT/mel bases are precision-sensitive.
import onnx
from onnx import numpy_helper

bt_path = str(outdir / "beat_this.onnx")
bt = onnx.load(bt_path)
big = [i for i in bt.graph.initializer
       if i.data_type == onnx.TensorProto.FLOAT and int(np.prod(i.dims or [1])) * 4 > 1_000_000]
casts = []
for i in big:
    arr = numpy_helper.to_array(i)
    bt.graph.initializer.remove(i)
    bt.graph.initializer.append(numpy_helper.from_array(arr.astype(np.float16), i.name + "_fp16"))
    casts.append(onnx.helper.make_node("Cast", [i.name + "_fp16"], [i.name],
                                       to=onnx.TensorProto.FLOAT, name=f"cast_{i.name}"))
nodes = casts + list(bt.graph.node)
del bt.graph.node[:]
bt.graph.node.extend(nodes)
onnx.checker.check_model(bt)
onnx.save(bt, bt_path)
print(f"beat_this.onnx weights -> fp16 ({len(big)} tensors)")
PYEOF

cp "$ROOT/scripts/beat_runner_onnx.py" "$WORK/python/beat_runner.py"

# PARITY GATE: the shipped ONNX runner must reproduce the torch flavor on a
# fixture clip — every beat within one frame (0.02 s), downbeats identical —
# and pass the same tempo/meter sanity checks as the gpu pack's beat smoke.
PARITY="$WORK/beat-parity"
rm -rf "$PARITY"
mkdir -p "$PARITY"
"$PY" "$ROOT/scripts/beat_runner_fixture.py" --out "$PARITY/click.f32" --sr 22050 --secs 60
HF_HUB_OFFLINE=1 PYTHONUNBUFFERED=1 "$EXPORT_PY" "$ROOT/scripts/beat_runner.py" \
  --f32 "$PARITY/click.f32" --sr 22050 --device cpu \
  --models "$(dirname "$BEAT_CKPT")" > "$PARITY/torch.json"
HF_HUB_OFFLINE=1 PYTHONUNBUFFERED=1 "$PY" "$WORK/python/beat_runner.py" \
  --f32 "$PARITY/click.f32" --sr 22050 > "$PARITY/onnx.json"
"$PY" "$ROOT/scripts/beat_runner_check.py" "$PARITY/onnx.json"
"$PY" - "$PARITY/torch.json" "$PARITY/onnx.json" << 'PYEOF'
import json
import sys

t = json.load(open(sys.argv[1]))
o = json.load(open(sys.argv[2]))
assert len(t["beat_prob"]) == len(o["beat_prob"]), \
    f"frame count differs: torch {len(t['beat_prob'])} vs onnx {len(o['beat_prob'])}"
assert len(t["beats"]) == len(o["beats"]), \
    f"beat count differs: torch {len(t['beats'])} vs onnx {len(o['beats'])}"
db = max((abs(a - b) for a, b in zip(t["beats"], o["beats"])), default=0.0)
assert db <= 0.02, f"beat time drift {db:.3f}s > 0.02s (one frame)"
assert len(t["downbeats"]) == len(o["downbeats"]), \
    f"downbeat count differs: torch {len(t['downbeats'])} vs onnx {len(o['downbeats'])}"
dd = max((abs(a - b) for a, b in zip(t["downbeats"], o["downbeats"])), default=0.0)
assert dd <= 0.02, f"downbeat drift {dd:.3f}s > 0.02s"
mp = max(abs(a - b) for a, b in zip(t["beat_prob"], o["beat_prob"]))
print(f"parity OK: {len(t['beats'])} beats (max dt {db:.3f}s), "
      f"{len(t['downbeats'])} downbeats (max dt {dd:.3f}s), "
      f"max framewise prob diff {mp:.3f}")
PYEOF
rm -rf "$PARITY"

find "$WORK/python" -name '__pycache__' -type d -prune -exec rm -rf {} +
rm -rf "$WORK/$SITE/pip" "$WORK/$SITE/setuptools"
if [ "$TARGET" = win32-x64 ]; then
  # user-download hygiene: debug symbols and tk/tcl are dead weight
  # (python312.pdb alone is 18 MB; libcrypto's another 23)
  find "$WORK/python" -name '*.pdb' -delete
  rm -rf "$WORK/python/tcl" "$WORK/python/Lib/tkinter" \
    "$WORK/python/Lib/idlelib" "$WORK/python/Lib/turtledemo"
  rm -f "$WORK/python/DLLs/_tkinter.pyd" "$WORK/python/DLLs/tcl86t.dll" "$WORK/python/DLLs/tk86t.dll"
fi

# version stamp: the app refuses packs older than its required format
# (v8 = ONE model file — simplified, OLA ISTFT, fp16 weights — replacing
# the original+sibling pair; ONE onnxruntime — mainline in site-packages,
# the DirectML wheel and the side-loaded rtx/ort copy are gone; pdb/tcl
# pruned; fp16 beat model — keep in sync with PACK_FORMAT_REQUIRED in
# src/main/models.ts)
cat > "$WORK/python/pack.json" << EOF
{ "formatVersion": 8, "target": "$TARGET", "builtAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)" }
EOF

tar -C "$WORK" -czf "$OUTFILE" python
du -sh "$WORK/python" "$OUTFILE"
echo "pack ready: $OUTFILE"
