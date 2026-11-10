/**
 * Python source for the ONNX splitter runner, written into the split's cache
 * dir at spawn time (the installed pack stays untouched, so behavior changes
 * reach packs already in the field).
 *
 * Its one GPU job: the TensorRT-RTX plugin EP. DirectML is gone — across the
 * whole fleet it never completed a split (fused graph = TDR device-hung,
 * unfused = ISTFT ConvTranspose OOM; the wheel is frozen at ORT 1.24 in
 * sustained engineering).
 *
 * A v8 pack ships ONE onnxruntime — mainline, in site-packages, plugin-EP
 * capable — and both the cpu and trtrtx paths import it. The DML wheel and
 * the v5-v7 side-load of a second ort under python/rtx/ort are both gone;
 * this header described them until the pack rewrite outran it.
 *
 * For `--providers trtrtx` the runner preloads the shipped runtime dlls by
 * absolute path (ORT does not search the EP dll's directory for its
 * dependencies — bench-proven), registers the plugin EP, and re-points
 * session creation at the TensorRT-RTX devices via the V2 device API. Every
 * step prints what it saw — on a release build the field log is the only
 * evidence there is.
 */
import RUNNER from '../../scripts/onnx_runner.py?raw'
export const ONNX_RUNNER_PY = RUNNER
