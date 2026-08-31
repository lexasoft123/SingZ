#include "SingzDspRuntimeCapability.h"

#include <zdsp/audio_host_graph_adapter.h>
#include <zdsp/builtin_nodes.h>
#include <zdsp/decoded_buffer_source.h>
#include <zdsp/graph.h>
#include <zdsp/graph_runner.h>
#include <zdsp/realtime_arena.h>

#include "native_playback_callback.h"

namespace {

// The capability object is the product's one inert reference into this static
// component. Retaining exact typed references makes the linker pull every
// missing runtime translation unit into the app even before Phase iOS-B owns
// playback. This turns a status probe into real packaging evidence instead of
// a literal that could survive beside an empty archive.
// `used` preserves the compiler references; `retain` gives their Mach-O
// sections S_ATTR_NO_DEAD_STRIP so Release linking cannot reduce this to a
// capability literal beside an otherwise unused runtime archive.
[[gnu::used, gnu::retain]] auto kArenaSymbol = &zdsp::initializeArena;
[[gnu::used, gnu::retain]] auto kBuiltinSymbol = &zdsp::createBuiltinProcessor;
[[gnu::used, gnu::retain]] auto kDecodedSourceSymbol =
    &zdsp::createDecodedBufferSource;
[[gnu::used, gnu::retain]] auto kCompilerSymbol = &zdsp::compileGraph;
[[gnu::used, gnu::retain]] auto kRunnerSymbol = &zdsp::renderGraphBlock;
[[gnu::used, gnu::retain]] auto kHostAdapterSymbol =
    &zdsp::renderAudioHostGraph;
[[gnu::used, gnu::retain]] auto kPlaybackCallbackSymbol =
    &singz::nativePlaybackRender;

constexpr SingzDspRuntimeLinkStatus kStatus{
    1,
    SingzDspRuntimeCapabilityGraph | SingzDspRuntimeCapabilityAudioHostAdapter |
        SingzDspRuntimeCapabilityPlaybackCallback |
        SingzDspRuntimeCapabilityPlaybackCleanupProof |
        SingzDspRuntimeCapabilityPlaybackHandoffLease,
    "singz.ios.zdsp_runtime.phase-ios-b1-ready-inert",
};

} // namespace

extern "C" const SingzDspRuntimeLinkStatus *SingzDspRuntimeGetLinkStatus(void) {
  return &kStatus;
}
