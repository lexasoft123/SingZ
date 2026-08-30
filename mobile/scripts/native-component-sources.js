'use strict'

// Product component packaging has one explicit source manifest. The checker
// compares each target-membership array against CMake before either iOS copy
// is materialized, so an add/remove on either side fails instead of silently
// producing different callback/runtime products.
const zdspRuntimeFiles = [
  'src/api/contracts.cpp',
  'src/runtime/realtime_arena.cpp',
  'src/runtime/builtin_nodes.cpp',
  'src/runtime/decoded_buffer_source.cpp',
  'src/runtime/graph_compiler.cpp',
  'src/runtime/graph_runner.cpp',
  'include/zdsp/types.h',
  'include/zdsp/events.h',
  'include/zdsp/clock.h',
  'include/zdsp/audio_bus.h',
  'include/zdsp/process_context.h',
  'include/zdsp/processor.h',
  'include/zdsp/latency.h',
  'include/zdsp/realtime_arena.h',
  'include/zdsp/queues.h',
  'include/zdsp/builtin_nodes.h',
  'include/zdsp/decoded_buffer_source.h',
  'include/zdsp/graph.h',
  'include/zdsp/graph_runner.h',
  'src/runtime/graph_internal.h',
]

const zdspHostAdapterFiles = [
  'src/runtime/audio_host_graph_adapter.cpp',
  'include/zdsp/audio_host_graph_adapter.h',
]

const zdspSupportZcoreFiles = [
  'include/zcore/device/audio_host_render.h',
]

const zcoreDeviceCallbackFiles = [
  'src/audio/audio_input_convert.cpp',
  'src/audio/audio_input_timestamp.cpp',
  'src/audio/audio_input_transport_callback.cpp',
  'src/device/audio_input_callback.cpp',
  'src/device/audio_input_callback_gate.cpp',
  'src/device/audio_host_callback.cpp',
  'src/device/audio_host_fifo_hot.cpp',
  'include/zcore/audio/audio_input_convert.h',
  'include/zcore/audio/audio_input_producer.h',
  'include/zcore/audio/audio_input_timestamp.h',
  'include/zcore/device/audio_input_callback_gate.h',
  'include/zcore/device/audio_host_callback.h',
  'include/zcore/device/audio_host_render.h',
  'src/audio/audio_input_transport_internal.h',
  'src/device/audio_input_callback.h',
]

const iosAudioHostCallbackFiles = [
  'platform/ios/audio_host_ios_callback.cpp',
  'platform/ios/audio_host_ios_callback.h',
]

// Required quoted/transitive headers which are not currently target_sources
// members in CMake. They remain explicit packaging inputs and are forbidden
// from growing without review.
const zcoreDeviceCallbackSupportFiles = [
  'include/zcore/audio/capture_block.h',
  'src/device/audio_host_fifo.h',
]

module.exports = {
  iosAudioHostCallbackFiles,
  zcoreDeviceCallbackFiles,
  zcoreDeviceCallbackSupportFiles,
  zdspHostAdapterFiles,
  zdspRuntimeFiles,
  zdspSupportZcoreFiles,
}
