# ADR 0001: Processor interface and lifecycle

Status: accepted for Phase 0B prototype<br>
Date: 2026-08-26

## Decision

`zdsp_api` is a same-toolchain, statically linked C++20 interface. Its POD
`ProcessorVTable`, opaque state and caller-owned prepared storage reduce
coupling, but they are not a stable C ABI and must not cross a compiler, shared
library, user plug-in, process bridge, JNI or Swift boundary directly. The
current `interfaceVersion` and immutable V1 prefix sizes protect append-only
compatibility inside one product build; readers validate the named prefix and
gate appended fields instead of requiring `sizeof(current)`.

The DSP-facing strong units, clock/render time, bus descriptors/views and
`ProcessContext` are owned by `zdsp_api`. Their meaning and versioning are part
of the processor contract. `zcore_base` remains the dependency root for truly
general units/utilities, while `zcore_audio` owns device capture transport and
must not depend on `zdsp`. A product or future host adapter links both sides
and explicitly maps device buffers/timestamps into the DSP contract; it does
not duplicate graph types in `zcore_audio` or reverse the dependency.

Concrete zdsp object targets use hidden symbol visibility when linked into a
shared product. Only explicit product bindings such as JNI entry points remain
exported; internal C++ validators and compile-smoke anchors are not a shared
library surface.

A future shared/plug-in/bridge adapter is a separate true C interface. It needs
an exported `extern "C"` factory, explicit calling and symbol-export
conventions, fixed-width C POD only (no `size_t`, C++ enums, references or
`noexcept` function types), opaque handles and output `Status` values. That
adapter translates to this internal interface; it does not publish the current
C++ vtable as its ABI.

The canonical format is native-endian planar float32. `PrepareSpec` freezes
input/output bus descriptor arrays before state sizing: channel count, format,
and mono/stereo/discrete layout are explicit; discrete layouts carry channel
roles. Descriptor and role arrays are borrowed for the prepare call only.
Prepared processors and runners copy or derive the scalar topology they need;
they never retain those pointers or rescan prepare topology on the render
thread. The first compiler caps
a bus at 64 channels and a processor at 16 input and 16 output buses; those are
validation limits, not array extents embedded in an interface struct. Views carry frames
and capacity. One graph has a positive rate and maximum block size. `process`
accepts 1..maximum frames and a zero-frame parameter/event flush. Events are
ordered and lie inside the block; zero-frame events have offset zero.

Lifecycle is create state off RT → prepare exactly once off RT → reset at typed
discontinuities → process repeatedly → deactivate → destroy off RT. Prepare owns
all durable allocation and reports status; repeated prepare attempts are
rejected. Reset retains parameter values but
clears transitional/history state. Process is `noexcept`, allocation-free,
lock-free and cannot log, perform I/O, call product bridges or release owners.
Latency and tail are query functions. The runner, not each processor, invokes
reset exactly once before the marked block. Processors must not self-reset from
the context flag. Corresponding-channel exact in-place buffers are supported;
partial, cross-channel and output-output overlaps are invalid. Bypass remains
latency-preserving.

The Phase 0B gain→meter implementation and fake host are explicitly prototype
code. They test this contract without claiming to be the Phase 1 DAG runner.

## Consequences

Adding a field appends it behind the immutable V1 prefix; changing meaning
requires an interface version. Plug-in SDK and framework types stop at
adapters. Float64 and
new layouts require explicit capability additions, not reinterpretation.
