/**
 * Python source for the ONNX splitter runner, written into the split's cache
 * dir at spawn time (the installed pack stays untouched, so this works on
 * packs already in the field).
 *
 * Why it exists: ORT-DML runs on DXGI adapter 0 — EnumAdapters1 order,
 * i.e. whatever drives the display — unless given a device_id, and hybrid
 * laptops put the battery-saving iGPU there while the fast GPU idles (field
 * 5800H machine: Vega iGPU TDR'd on chunk 1, RTX 3060 never touched).
 * demucs-onnx's CLI has no device flag, so the runner probes adapters with
 * the same EnumAdapters1 call ORT maps device_id onto (verified in
 * dml_provider_factory.cc) and re-points DmlExecutionProvider at the best
 * hardware adapter via provider options. It also prints one line per
 * adapter, so every field log shows what the machine had and what we chose.
 *
 * SINGZ_DML_PROBE=1 prints the adapter table as JSON and exits — used by
 * unit tests (real DXGI on Windows CI) without touching demucs.
 */
export const ONNX_RUNNER_PY = `
import json, os, sys

DXGI_ADAPTER_FLAG_SOFTWARE = 2
MS_BASIC_RENDER_VENDOR = 0x1414


def probe_adapters():
    import ctypes
    from ctypes import wintypes

    class LUID(ctypes.Structure):
        _fields_ = [("LowPart", wintypes.DWORD), ("HighPart", wintypes.LONG)]

    class DXGI_ADAPTER_DESC1(ctypes.Structure):
        _fields_ = [
            ("Description", ctypes.c_wchar * 128),
            ("VendorId", wintypes.UINT),
            ("DeviceId", wintypes.UINT),
            ("SubSysId", wintypes.UINT),
            ("Revision", wintypes.UINT),
            ("DedicatedVideoMemory", ctypes.c_size_t),
            ("DedicatedSystemMemory", ctypes.c_size_t),
            ("SharedSystemMemory", ctypes.c_size_t),
            ("AdapterLuid", LUID),
            ("Flags", wintypes.UINT),
        ]

    class GUID(ctypes.Structure):
        _fields_ = [
            ("Data1", wintypes.DWORD),
            ("Data2", wintypes.WORD),
            ("Data3", wintypes.WORD),
            ("Data4", ctypes.c_ubyte * 8),
        ]

    iid_factory1 = GUID(
        0x770AAE78, 0xF26F, 0x4DBA,
        (ctypes.c_ubyte * 8)(0xA8, 0x29, 0x25, 0x3C, 0x83, 0xD1, 0xB3, 0x87),
    )

    def com_method(obj, index, restype, *argtypes):
        this = ctypes.c_void_p(obj)
        vtbl = ctypes.cast(this, ctypes.POINTER(ctypes.POINTER(ctypes.c_void_p))).contents
        fn = ctypes.WINFUNCTYPE(restype, ctypes.c_void_p, *argtypes)(vtbl[index])
        return lambda *args: fn(this, *args)

    factory = ctypes.c_void_p()
    hr = ctypes.windll.dxgi.CreateDXGIFactory1(ctypes.byref(iid_factory1), ctypes.byref(factory))
    if hr != 0:
        return []
    # IDXGIFactory1 vtable: IUnknown(0-2) IDXGIObject(3-6) IDXGIFactory(7-11)
    # then EnumAdapters1 = 12. IDXGIAdapter1: ...GetDesc1 = 10. Release = 2.
    # restype must be c_long, not HRESULT: ctypes auto-raises OSError on
    # failure HRESULTs, and end-of-list IS one (DXGI_ERROR_NOT_FOUND).
    enum_adapters1 = com_method(
        factory.value, 12, ctypes.c_long, wintypes.UINT, ctypes.POINTER(ctypes.c_void_p)
    )
    adapters = []
    i = 0
    while True:
        adapter = ctypes.c_void_p()
        if enum_adapters1(i, ctypes.byref(adapter)) != 0:
            break
        desc = DXGI_ADAPTER_DESC1()
        get_desc1 = com_method(adapter.value, 10, ctypes.c_long, ctypes.POINTER(DXGI_ADAPTER_DESC1))
        if get_desc1(ctypes.byref(desc)) == 0:
            adapters.append({
                "index": i,
                "description": desc.Description,
                "vendor": desc.VendorId,
                "device": desc.DeviceId,
                "dedicated_mb": int(desc.DedicatedVideoMemory // (1024 * 1024)),
                "software": bool(desc.Flags & DXGI_ADAPTER_FLAG_SOFTWARE)
                            or desc.VendorId == MS_BASIC_RENDER_VENDOR,
            })
        com_method(adapter.value, 2, ctypes.c_ulong)()
        i += 1
    com_method(factory.value, 2, ctypes.c_ulong)()
    return adapters


def pick_adapter(adapters):
    hw = [a for a in adapters if not a["software"]]
    if not hw:
        return None
    return max(hw, key=lambda a: a["dedicated_mb"])


def setup_trtrtx():
    """TensorRT-RTX plugin EP (Ampere+) on MAINLINE ort, shipped side by side
    with the pack's frozen onnxruntime-directml under python/rtx. Exits the
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
    # (add_dll_directory is NOT consulted for them — proven on a bench
    # machine: cudart64_12.dll beside the EP still reported missing).
    # Preload every shipped dll by absolute path instead; a module already
    # in the process satisfies dependency lookups by name. A few passes
    # because they depend on each other in no particular filename order.
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

    def patched(*args, **kw):
        provs = kw.get("providers")
        if provs and any("trtrtx" in str(p) for p in provs):
            so = kw.get("sess_options") or ort.SessionOptions()
            so.add_provider_for_devices(devs, {})
            kw["sess_options"] = so
            kw.pop("providers", None)
            kw.pop("provider_options", None)
        return orig(*args, **kw)

    ort.InferenceSession = patched


def main():
    if os.environ.get("SINGZ_DML_PROBE"):
        adapters = probe_adapters() if sys.platform == "win32" else []
        print(json.dumps({"adapters": adapters, "pick": pick_adapter(adapters)}))
        return 0

    if sys.platform == "win32" and "trtrtx" in sys.argv:
        setup_trtrtx()

    no_fusion = os.environ.get("SINGZ_DML_NO_FUSION") == "1"
    if sys.platform == "win32" and "dml" in sys.argv:
        try:
            adapters = probe_adapters()
            for a in adapters:
                kind = "software" if a["software"] else f"{a['dedicated_mb']} MB dedicated"
                print(f"gpu adapter {a['index']}: {a['description']} ({kind})", flush=True)
            pick = pick_adapter(adapters)
            dev = None
            if pick is None:
                print("no hardware GPU adapter — leaving DirectML on its default", flush=True)
            elif pick["index"] != 0:
                dev = pick["index"]
                print(f"steering DirectML to adapter {dev}: {pick['description']}", flush=True)
            if dev is not None or no_fusion:
                if no_fusion:
                    # One fused command list can outlive the 2 s GPU timeout
                    # (TDR) — every hardware adapter in the field died on the
                    # first chunk. Unfused, each op is its own small submission.
                    print("DirectML graph fusion off — submitting the model in small pieces", flush=True)
                import onnxruntime as ort
                orig = ort.InferenceSession

                def patched(*args, **kw):
                    provs = kw.get("providers")
                    if provs and dev is not None:
                        kw["providers"] = [
                            ("DmlExecutionProvider", {"device_id": dev})
                            if p == "DmlExecutionProvider" else p
                            for p in provs
                        ]
                    if provs and no_fusion:
                        so = kw.get("sess_options") or ort.SessionOptions()
                        so.add_session_config_entry("ep.dml.disable_graph_fusion", "1")
                        kw["sess_options"] = so
                    return orig(*args, **kw)

                ort.InferenceSession = patched
        except Exception as err:
            # The probe is an optimization — never lose the split to it.
            print(f"GPU probe failed ({err}) — leaving DirectML on its default", flush=True)

    from demucs_onnx.cli import main as demucs_main
    return demucs_main()


if __name__ == "__main__":
    sys.exit(main())
`
