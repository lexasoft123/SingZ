# zcore ownership

`zcore` is SingZ's reusable native foundation. It owns portable audio data and
timestamp utilities, device/session providers, media I/O, and the existing
analysis implementation while that implementation is split into later `zdsp`
targets. Product bindings do not live here.

The root `CMakeLists.txt` is authoritative. Host and Android builds consume the
same narrow targets:

- `SingZ::zcore_base` — dependency-free native contracts and utilities;
- `SingZ::zcore_audio` — ownership and ordinary-thread consumption for the
  preallocated SPSC transport. The CMake target links the callback target
  transitively for compatibility; their static archives remain separate;
- `SingZ::zcore_device_callback` — the callback-only sample conversion,
  timestamp, SPSC producer and notification leaf. It is C++20, hidden by
  default, built without exceptions/RTTI and scanned from its actual CMake
  source membership for blocking, allocation and unbounded facilities;
- `SingZ::zcore_device` — lifecycle, delivery and per-OS providers. It owns
  threads, OS frameworks and driver setup, and composes the strict callback
  leaf without inheriting those facilities into it;
- `SingZ::zcore_media` — WAV/FLAC I/O, excluded from live device dependencies;
- `SingZ::zcore_live_analysis_compat` — temporary ordinary-thread YIN and
  fixed-ratio resampler implementation shared by the legacy facade and
  `zdsp_analysis`; it is outside `zcore_base` and callback reachability;
- `SingZ::zcore_legacy` — the remaining temporary ORT-free compatibility
  facade, linking `zcore_live_analysis_compat` rather than compiling a second
  YIN/resampler implementation;
- `SingZ::zcore_ml` — optional ONNX adapter, the only target that opts into
  exceptions and RTTI on Android.

Android JNI remains in `mobile/native/bindings/android`. The iOS pod wrappers
remain in `mobile/ios/SingzCore`; its `core/` directory is a read-only,
gitignored packaging copy created by `mobile/scripts/sync-singzcore.js`.
That pod is a temporary Phase 0A compatibility exception: it still combines
device, media, analysis and ORT. Component pods or a CMake-built XCFramework
must isolate dependencies and flags before native graph rendering.

Public lifecycle APIs live under `zcore/device`, callback transport under
`zcore/audio`, and delivery-thread analysis under `zcore/legacy`. Consumers
use rooted `<zcore/...>` includes; only `zcore/include` is exported.

`zcore` must never include or link `zdsp`. The product host composes both
packages so the device layer does not acquire a graph dependency.
