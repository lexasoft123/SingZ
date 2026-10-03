# Shared CREPE Tiny model

The frozen float32 weights are exported from the pinned torchcrepe ONNX model already used by the iOS trial. Runtime inference is implemented in `zdsp/src/analysis/crepe_tiny.cpp`: six convolution / ReLU / batch-normalization / max-pool blocks and a sigmoid classifier. Apple builds use Accelerate matrix multiplication; Android and Windows use the portable vectorizable kernel. zcore remains independent of zdsp.

- Model source: https://huggingface.co/FredrikKarlssonSpeech/torchcrepe-onnx
- Upstream architecture and license: https://github.com/maxrmorrison/torchcrepe (MIT; see `torchcrepe-LICENSE.txt`).
- ONNX SHA256: `48130a2e69a5f7ebfdfbd680a85a41dda9dffc9ce810f64481e0c6269ee5661b`
- Exported weights SHA256: `b0c88a1c16e329426efa53a66c25e04a6cca307e955dd0e27acc589b7c237a27`
- Regenerate with `scripts/export-crepe-tiny.py INPUT.onnx assets/pitch/crepe-tiny.bin` (Python onnx/numpy required only for export).
- The native probability parity fixture was generated using ONNX Runtime from six seeded noisy sinusoidal windows, without changing the preprocessing. All 360 probabilities must agree within 0.0001 on every platform.

Capture is resampled to 16 kHz in the ordinary delivery thread, using 1024-sample windows and 320-sample hops. No future-context decoder or exercise-target folding is used. The RMS gate and harmonic correction run against the original window. Raw WAV recording happens before these operations.
