/**
 * Python source for the ONNX splitter runner, written into the split's cache
 * dir at spawn time (the installed pack stays untouched, so behavior changes
 * reach packs already in the field).
 *
 * Its one GPU job: the TensorRT-RTX plugin EP. DirectML is gone — across the
 * whole fleet it never completed a split (fused graph = TDR device-hung,
 * unfused = ISTFT ConvTranspose OOM; the wheel is frozen at ORT 1.24 in
 * sustained engineering). The pack's base onnxruntime import still IS the
 * DML wheel — the cpu provider runs through it unchanged — but no attempt
 * targets DmlExecutionProvider any more.
 *
 * For `--providers trtrtx` the runner side-loads MAINLINE ort from
 * python/rtx/ort, preloads the shipped runtime dlls by absolute path (ORT
 * does not search the EP dll's directory for its dependencies — bench-
 * proven), registers the plugin EP, and re-points session creation at the
 * TensorRT-RTX devices via the V2 device API. Every step prints what it saw
 * — on a release build the field log is the only evidence there is.
 */
export const ONNX_RUNNER_PY = `
import os, sys


def setup_trtrtx():
    """TensorRT-RTX plugin EP (GeForce RTX 30xx+) on MAINLINE ort, shipped
    side by side with the pack's base wheel under python/rtx. Exits the
    process when the GPU or payload can't serve — the app's ladder moves on."""
    base = os.path.join(os.path.dirname(sys.executable), "rtx")
    ep_dll = os.path.join(base, "ep", "onnxruntime_providers_nv_tensorrt_rtx.dll")
    if not os.path.isfile(ep_dll):
        print("TensorRT RTX payload missing from this pack", flush=True)
        sys.exit(3)
    sys.path.insert(0, os.path.join(base, "ort"))
    import onnxruntime as ort
    print(f"TensorRT RTX: onnxruntime {ort.__version__} (mainline, side-loaded)", flush=True)
    # ORT loads the EP dll without searching its directory for dependencies
    # (add_dll_directory is NOT consulted for them). Preload every shipped
    # dll by absolute path instead; a module already in the process
    # satisfies dependency lookups by name. A few passes because they
    # depend on each other in no particular filename order.
    import ctypes
    ep_dir = os.path.join(base, "ep")
    pending = [f for f in os.listdir(ep_dir)
               if f.lower().endswith(".dll") and f != os.path.basename(ep_dll)]
    for _ in range(3):
        failed = []
        for f in pending:
            try:
                ctypes.WinDLL(os.path.join(ep_dir, f))
            except OSError:
                failed.append(f)
        pending = failed
        if not pending:
            break
    if pending:
        print(f"TensorRT RTX runtime dlls would not load here: {', '.join(pending)}", flush=True)
    try:
        ort.register_execution_provider_library("NvTensorRtRtx", ep_dll)
        all_devs = list(ort.get_ep_devices())
    except Exception as err:
        print(f"TensorRT RTX would not start here: {err}", flush=True)
        sys.exit(3)
    # The factory's self-reported name is "TensorRTRTX" (read out of the dll;
    # the docs say NvTensorRtRtxExecutionProvider — an exact match dropped a
    # real RTX 3060 in the field). Match loosely and print what was seen, so
    # the next rename diagnoses itself from the log.
    for d in all_devs:
        print(f"ep device: {getattr(d, 'ep_name', '?')}", flush=True)
    devs = [d for d in all_devs
            if "tensorrt" in str(getattr(d, "ep_name", "")).lower()]
    if not devs:
        print("TensorRT RTX found no supported GPU here (needs GeForce RTX 30xx or newer)", flush=True)
        sys.exit(3)
    for d in devs:
        try:
            desc = d.device.metadata.get("Description", "") or getattr(d, "ep_vendor", "NVIDIA")
        except Exception:
            desc = getattr(d, "ep_vendor", "NVIDIA")
        print(f"TensorRT RTX device: {desc}", flush=True)
    orig = ort.InferenceSession
    confirmed = [False]

    def patched(*args, **kw):
        # The raw export is partition-hostile (20k shape/scatter glue nodes
        # shattered the TensorRT partition; the transfers at the seams made
        # the GPU slower than the CPU) — the pack ships a pre-simplified
        # sibling for TensorRT-RTX sessions only. CPU sessions never come
        # through here and keep the original.
        if args and isinstance(args[0], str) and args[0].endswith(".onnx"):
            trt_model = args[0][:-5] + "_trt.onnx"
            if os.path.isfile(trt_model):
                args = (trt_model,) + args[1:]
                print("TensorRT RTX: using the pre-simplified graph", flush=True)
        # (detailed build log stays off: one session's spew was 457 KB and
        # evicted the whole start of the field log from the ring)
        opts = {}
        if args and isinstance(args[0], str):
            # compiled-engine cache beside the model: the first split paid
            # ~31 s of JIT on the field 3060; cached engines skip it.
            cache_dir = os.path.join(os.path.dirname(args[0]), "trtrtx-cache")
            try:
                os.makedirs(cache_dir, exist_ok=True)
                opts["nv_runtime_cache_path"] = cache_dir
            except OSError:
                pass
        # setup only runs for trtrtx attempts, so every session this process
        # creates belongs on the TensorRT-RTX devices — argv was rewritten to
        # a value demucs's argparse accepts, so providers can't signal it.
        if kw.get("providers"):
            so = kw.get("sess_options") or ort.SessionOptions()
            so.add_provider_for_devices(devs, opts)
            kw["sess_options"] = so
            kw.pop("providers", None)
            kw.pop("provider_options", None)
        sess = orig(*args, **kw)
        if not confirmed[0]:
            confirmed[0] = True
            print("TensorRT RTX session created", flush=True)
        return sess

    ort.InferenceSession = patched

    # The simplified one-engine graph still ran at 6.86 s/chunk — ~10 GFLOPS
    # achieved on ~10 TFLOPS hardware, slower than the same machine's CPU.
    # That smells like power management (unplugged laptop, whisper mode, dGPU
    # parked at idle clocks), not kernels. Sample the driver's own telemetry
    # during the split so the field log settles it.
    def _telemetry():
        import subprocess
        import time
        smi = os.path.join(os.environ.get("SystemRoot", r"C:\\Windows"), "System32", "nvidia-smi.exe")
        if not os.path.isfile(smi):
            smi = "nvidia-smi"
        q = ("--query-gpu=utilization.gpu,clocks.sm,clocks.max.sm,power.draw,"
             "power.limit,pstate,temperature.gpu")
        while True:
            try:
                r = subprocess.run([smi, q, "--format=csv,noheader"],
                                   capture_output=True, text=True, timeout=10)
                line = (r.stdout or "").strip().replace("\\n", " | ")
                if line:
                    print(f"gpu telemetry: {line}", flush=True)
            except Exception as err:
                print(f"gpu telemetry unavailable: {err}", flush=True)
                return
            time.sleep(15)

    import threading
    threading.Thread(target=_telemetry, daemon=True).start()


def main():
    if sys.platform == "win32" and "trtrtx" in sys.argv:
        setup_trtrtx()
        # demucs's --providers argparse has a literal choices list that
        # vetoes unknown values before its resolver runs (field-proven).
        # Hand it a legal value; the patch above owns session creation.
        sys.argv = ["cpu" if a == "trtrtx" else a for a in sys.argv]

    from demucs_onnx.cli import main as demucs_main
    return demucs_main()


if __name__ == "__main__":
    sys.exit(main())
`
