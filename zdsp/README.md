# zdsp ownership

`zdsp` is the future real-time processing graph. Phase 0B freezes its first
same-toolchain static C++20 POD/vtable contracts and adds isolated deterministic
gain→meter test support without taking ownership of app playback:

- `SingZ::zdsp_api` exposes graph/processor contracts and depends only on
  `SingZ::zcore_base`. It intentionally owns DSP-facing clock, bus, process and
  strong-unit types; device/capture transport remains in `zcore_audio` and a
  higher host layer adapts between them;
- `SingZ::zdsp_runtime` contains contract validation only, without codecs,
  ONNX Runtime, prototype nodes or plug-in SDKs;
- `SingZ::zdsp_prototype` contains the gain→meter fake host for tests and
  benchmarks. It is excluded from default builds and forbidden from product
  linkage;
- `SingZ::zdsp_control` contains the deterministic graph contract fixture codec.

This test-only prototype exercises prepared storage, variable and zero-frame
behavior, automation, discontinuity and metering. It is not the Phase 1 DAG
runner; immutable graph compilation, arena planning and epoch retirement remain
next. Android and iOS product packages compile/link `zdsp_runtime` contracts
only; they do not copy or link the prototype.

Product UI, Electron/React Native marshalling, platform framework types and
codec/ML/plugin dependencies do not belong in `zdsp_api` or its callback path.
This C++ interface is not a shared-library or plug-in ABI; ADR 0001 reserves a
future explicit C adapter for those boundaries.
