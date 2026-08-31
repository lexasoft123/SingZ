# ADR 0006: Plug-in execution modes

Status: accepted design; plug-in hosting remains Phase 6<br>
Date: 2026-08-26

## Decision

Built-in processors run in process. Unknown desktop plug-ins are scanned and
validated in a helper, then default to bridged safe mode. A user may choose
low-latency in-process mode for a successfully scanned instance after SingZ
shows that a crash can terminate the app. Projects persist the chosen mode.

In-process adapters translate the plug-in SDK into the internal processor
interface, prepare all SDK
state off RT and contain non-finite output. Bridged mode uses preallocated
shared audio/control slots, fixed sequence counters and one-block-or-greater
declared latency; no socket, semaphore or process wait occurs in render. Missed
deadlines select a prepared dry/silent policy and increment diagnostics.
Scanner and bridge crashes quarantine the instance without corrupting graph
state. Plug-in state capture/restoration is control-domain work.

VST3 is first for Windows/macOS. Pin the upstream commit named `VST SDK 3.8.0`
`9fad9770f2ae8542ab1a548a68c1ad1ac690abe0` and its recorded submodule SHAs.
There is no upstream GitHub release/tag for this pin; the commit and its gitlinks
are the reproducible identity. That official commit changes the root SDK license to MIT. Retain root and
submodule license files plus `VST3_Usage_Guidelines.pdf` in the eventual
wrapper notices. No SDK is vendored in Phase 0B. AU and CLAP remain later
adapters. Mobile supports built-ins only unless separately approved.

ASIO is unrelated to VST3 licensing and remains fail-loud disabled. SingZ does
not vendor or enable ASIO until a compatible distribution decision/agreement
and a separately reviewed backend exist.

## Consequences

Neither VST3, JUCE nor plug-in IPC defines the internal node interface or the
future C bridge ABI. Bridged latency
is visible and compensated like other deterministic graph latency.
