# zcore ownership

`zcore` is SingZ's reusable native foundation. It owns portable audio data and
timestamp utilities, device/session providers, media I/O, and the existing
analysis implementation while that implementation is split into later `zdsp`
targets. Product bindings do not live here.

The root `CMakeLists.txt` is authoritative. Host and Android builds consume the
same narrow targets:

- `SingZ::zcore_base` — dependency-free native contracts and utilities;
- `SingZ::zcore_audio` — callback-safe sample conversion, timestamps and the
  preallocated SPSC transport; it is the current strict no-exceptions/no-RTTI
  leaf;
- `SingZ::zcore_device` — a Phase 0A compatibility target combining lifecycle,
  delivery and per-OS providers. Callback entry points keep their
  no-allocation/no-blocking contract, but lifecycle code intentionally catches
  thread-creation exceptions, so the whole target is not an RT leaf;
- `SingZ::zcore_media` — WAV/FLAC I/O, excluded from live device dependencies;
- `SingZ::zcore_legacy` — temporary ORT-free analysis implementation,
  including the allocating/offline resampler until `zdsp_analysis` owns it;
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
