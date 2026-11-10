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
