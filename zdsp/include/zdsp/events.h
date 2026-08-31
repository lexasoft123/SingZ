#pragma once

#include "zdsp/types.h"

namespace zdsp {

enum class ParameterCurve : uint32_t { Step = 0, Linear = 1 };
struct ParameterEvent {
  NodeId node;
  ParameterId parameter;
  FrameCount sampleOffset;
  float value;
  ParameterCurve curve;
  FrameCount rampFrames;
};

enum class MusicalEventKind : uint32_t { NoteOn = 0, NoteOff, AllNotesOff };
struct MusicalEvent {
  FrameCount sampleOffset;
  MusicalEventKind kind;
  uint16_t channel;
  uint16_t key;
  float value;
};

enum class DiscontinuityReason : uint32_t {
  None = 0,
  StreamGenerationChanged,
  SequenceGap,
  SampleRateChanged,
  RouteGenerationChanged,
  TimestampQualityChanged,
  ClockReanchored,
  SourceSeek,
  SourceLoop,
  DeviceLost,
  SourceFrameOverflow,
};
enum DiscontinuityFlags : uint32_t {
  DiscontinuityFlagNone = 0,
  DiscontinuityFlagResetState = 1u << 0,
  DiscontinuityFlagTimeValid = 1u << 1,
};
struct Discontinuity { DiscontinuityReason reason; uint32_t flags; };

}  // namespace zdsp
