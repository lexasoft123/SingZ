#pragma once

// Included from exactly one TU (BaseAudioContextHostObject.cpp), so the
// JSI_HOST_FUNCTION_IMPL bodies can live here without ODR trouble.

#include <audioapi/HostObjects/AudioNodeHostObject.h>
#include <audioapi/core/BaseAudioContext.h>
#include <audioapi/core/singz/SingzStretchNode.h>

#include <memory>

namespace audioapi {
using namespace facebook;

class SingzStretchNodeHostObject : public AudioNodeHostObject {
 public:
  explicit SingzStretchNodeHostObject(
      const std::shared_ptr<BaseAudioContext> &context,
      const AudioNodeOptions &options)
      : AudioNodeHostObject(context->createSingzStretch(options), options) {
    addFunctions(
        JSI_EXPORT_FUNCTION(SingzStretchNodeHostObject, setSemitones),
        JSI_EXPORT_FUNCTION(SingzStretchNodeHostObject, getLatencySeconds));
  }

  JSI_HOST_FUNCTION_DECL(setSemitones);
  JSI_HOST_FUNCTION_DECL(getLatencySeconds);
};

JSI_HOST_FUNCTION_IMPL(SingzStretchNodeHostObject, setSemitones) {
  auto node = std::static_pointer_cast<SingzStretchNode>(node_);
  node->setSemitones(static_cast<float>(args[0].asNumber()));
  return jsi::Value::undefined();
}

JSI_HOST_FUNCTION_IMPL(SingzStretchNodeHostObject, getLatencySeconds) {
  auto node = std::static_pointer_cast<SingzStretchNode>(node_);
  return {static_cast<double>(node->getLatencySeconds())};
}

} // namespace audioapi
