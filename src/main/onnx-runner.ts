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

PROFILE_PATH = []


def setup_trtrtx():
    """TensorRT-RTX plugin EP (GeForce RTX 30xx+) on MAINLINE ort, shipped
    side by side with the pack's base wheel under python/rtx. Exits the
    process when the GPU or payload can't serve — the app's ladder moves on."""
    base = os.path.join(os.path.dirname(sys.executable), "rtx")
    ep_dll = os.path.join(base, "ep", "onnxruntime_providers_nv_tensorrt_rtx.dll")
    if not os.path.isfile(ep_dll):
        print("TensorRT RTX payload missing from this pack", flush=True)
        sys.exit(3)
    # v8 packs ship ONE onnxruntime — mainline, in site-packages, plugin-EP
    # capable (>=1.23). The v5-v7 side-load dance under rtx/ort is gone.
    import onnxruntime as ort
    print(f"TensorRT RTX: onnxruntime {ort.__version__}", flush=True)
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
        # v8 packs ship ONE model — the hub-cache file IS the simplified
        # OLA-ISTFT fp16-weights graph, for cpu and TensorRT alike — so the
        # v6/v7 _trt.onnx sibling substitution is gone.
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
                print(f"runtime cache before: {os.listdir(cache_dir) or 'empty'}", flush=True)
            except OSError:
                pass
            # Per-layer GPU timing (chrome-trace JSON), on request only: it
            # disables CUDA-graph replay AND invalidates the cached engine
            # (a profiling session rebuilt for 108 s in the field). It found
            # the ISTFT ConvTranspose pair eating 98% of all GPU time —
            # rewritten to MatMul + overlap-add in the pack's v7 model.
            if os.environ.get("SINGZ_TRTRTX_PROFILE") == "1":
                prof = os.path.join(os.path.dirname(args[0]), "trtrtx-profile.json")
                try:
                    if os.path.isfile(prof):
                        os.remove(prof)
                    opts["nv_enable_profiling"] = "1"
                    opts["nv_profiling_output_file"] = prof
                    PROFILE_PATH.append(prof)
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


def _print_trtrtx_profile():
    """Session teardown flushes the IProfiler's chrome-trace file — force it
    by draining demucs's session pool, then summarize per-layer GPU time."""
    if not PROFILE_PATH:
        return
    try:
        import gc

        from demucs_onnx import inference as _inf
        _inf._DEFAULT_POOL._sessions.clear()
        gc.collect()
    except Exception as err:
        print(f"gpu profile: could not flush sessions ({err})", flush=True)
    try:
        import json
        with open(PROFILE_PATH[0], "r", encoding="utf-8", errors="replace") as f:
            data = json.load(f)
        events = data.get("traceEvents", data) if isinstance(data, dict) else data
        totals = {}
        for e in events:
            if isinstance(e, dict) and "dur" in e and e.get("name"):
                t = totals.setdefault(e["name"], [0.0, 0])
                t[0] += float(e["dur"])
                t[1] += 1
        grand = sum(v[0] for v in totals.values()) / 1e6
        print(f"gpu profile: {len(totals)} layers, {grand:.1f}s total GPU time", flush=True)
        ranked = sorted(totals.items(), key=lambda kv: -kv[1][0])
        for name, (dur, cnt) in ranked[:15]:
            print(f"gpu profile: {dur / 1e6:7.2f}s  x{cnt:5d}  {name[:90]}", flush=True)
    except Exception as err:
        print(f"gpu profile unavailable ({err})", flush=True)


def main():
    if sys.platform == "win32" and "trtrtx" in sys.argv:
        setup_trtrtx()
        # demucs's --providers argparse has a literal choices list that
        # vetoes unknown values before its resolver runs (field-proven).
        # Hand it a legal value; the patch above owns session creation.
        sys.argv = ["cpu" if a == "trtrtx" else a for a in sys.argv]
        from demucs_onnx.cli import main as demucs_main
        ret = demucs_main()
        _print_trtrtx_profile()
        return ret

    from demucs_onnx.cli import main as demucs_main
    return demucs_main()


if __name__ == "__main__":
    sys.exit(main())
`
