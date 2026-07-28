/*
 * react-native-audio-api deep-copies every AudioBuffer per source creation
 * (AudioBufferSourceNodeHostObject::setBuffer). For a six-stem player that
 * doubles resident memory while playing and stacks a full stem-set per seek
 * — measured +1 GB per 3-seek burst, jetsam-killing the app on device at
 * ~1.5 GB. We never mutate PCM after decode, so sharing is safe.
 * Runs from postinstall; idempotent; fails loudly if upstream changes shape
 * (then re-evaluate — maybe they fixed their TODO and this can go).
 * Regression test: mobile/tests/seek-memory.cjs (sim, host-side RSS).
 */
const fs = require('fs');
const path = require('path');

const file = path.join(
  __dirname,
  '..',
  'node_modules/react-native-audio-api/common/cpp/audioapi/HostObjects/sources/AudioBufferSourceNodeHostObject.cpp'
);
const COPY = 'copiedBuffer = std::make_shared<AudioBuffer>(*buffer);';
const SHARE = `// SingZ patch 1 (scripts/patch-audio-api.js): share instead of deep-copying.
      copiedBuffer = buffer;`;
// With sharing, a source owns no PCM — declaring the full buffer size as
// external pressure per source stacks per seek until Hermes GC hits its heap
// ceiling and hard-OOMs (hermes::vm::GCBase::oom, seen on device). The
// AudioBuffer host object still accounts the real memory once.
const PRESSURE =
  'thisValue.asObject(runtime).setExternalMemoryPressure(\n' +
  '        runtime, bufferHostObject->getSizeInBytes());';
const PRESSURE_FIXED =
  '/* SingZ patch 2: shared buffer — the source owns no PCM copy. */\n' +
  '    thisValue.asObject(runtime).setExternalMemoryPressure(runtime, 1024);';

let src = fs.readFileSync(file, 'utf8');
let applied = 0;
if (src.includes(COPY)) {
  src = src.replace(COPY, SHARE);
  applied++;
}
if (src.includes(PRESSURE)) {
  src = src.replace(PRESSURE, PRESSURE_FIXED);
  applied++;
}
if (applied > 0) {
  fs.writeFileSync(file, src);
  console.log(`audio-api patch: applied ${applied} change(s)`);
} else if (src.includes('SingZ patch') && src.includes('SingZ patch 2')) {
  console.log('audio-api patch: already applied');
} else {
  console.error(
    'audio-api patch: target code not found — upstream changed ' +
      'AudioBufferSourceNodeHostObject.cpp; re-check copy-per-setBuffer and ' +
      'external-pressure behavior before shipping.'
  );
  process.exit(1);
}

/*
 * Patch 3: SingzStretchNode — a master-bus pitch shifter (Signalsmith
 * Stretch, vendored in mobile/patches-src/singz) grafted into the library's
 * node graph. New self-contained files are copied in (both platforms glob
 * common/cpp recursively); creation plumbing is four anchored insertions.
 * iOS: run `pod install` after this changes (the podspec glob is evaluated
 * at install time).
 */
const root = path.join(__dirname, '..', 'node_modules/react-native-audio-api/common/cpp/audioapi');
const srcDir = path.join(__dirname, '..', 'patches-src', 'singz');
const nodeDir = path.join(root, 'core', 'singz');

fs.mkdirSync(path.join(nodeDir, 'signalsmith-linear'), { recursive: true });
for (const f of ['SingzStretchNode.h', 'SingzStretchNode.cpp', 'SingzStretchNodeHostObject.h', 'signalsmith-stretch.h', 'VENDORED.txt']) {
  fs.copyFileSync(path.join(srcDir, f), path.join(nodeDir, f));
}
for (const f of fs.readdirSync(path.join(srcDir, 'signalsmith-linear'))) {
  fs.copyFileSync(path.join(srcDir, 'signalsmith-linear', f), path.join(nodeDir, 'signalsmith-linear', f));
}

function insertOnce(rel, anchor, addition, label) {
  const p = path.join(root, rel);
  let s = fs.readFileSync(p, 'utf8');
  if (s.includes(addition)) return false;
  if (!s.includes(anchor)) {
    console.error(`audio-api patch 3: anchor missing in ${rel} (${label}) — upstream changed shape.`);
    process.exit(1);
  }
  fs.writeFileSync(p, s.replace(anchor, anchor + addition));
  return true;
}

let p3 = 0;
p3 += insertOnce(
  'core/BaseAudioContext.h',
  'class GainNode;',
  '\nclass SingzStretchNode; // SingZ patch 3\nstruct AudioNodeOptions; // SingZ patch 3',
  'forward decl'
);
p3 += insertOnce(
  'core/BaseAudioContext.h',
  'std::shared_ptr<GainNode> createGain(const GainOptions &options);',
  '\n  std::shared_ptr<SingzStretchNode> createSingzStretch(const AudioNodeOptions &options); // SingZ patch 3',
  'create decl'
);
p3 += insertOnce(
  'core/BaseAudioContext.cpp',
  '#include <audioapi/core/effects/GainNode.h>',
  '\n#include <audioapi/core/singz/SingzStretchNode.h> // SingZ patch 3',
  'include'
);
p3 += insertOnce(
  'core/BaseAudioContext.cpp',
  `std::shared_ptr<GainNode> BaseAudioContext::createGain(const GainOptions &options) {
  auto gain = std::make_shared<GainNode>(shared_from_this(), options);
  graphManager_->addProcessingNode(gain);
  return gain;
}`,
  `

// SingZ patch 3
std::shared_ptr<SingzStretchNode> BaseAudioContext::createSingzStretch(
    const AudioNodeOptions &options) {
  auto stretch = std::make_shared<SingzStretchNode>(shared_from_this(), options);
  graphManager_->addProcessingNode(stretch);
  return stretch;
}`,
  'create impl'
);
p3 += insertOnce(
  'HostObjects/BaseAudioContextHostObject.h',
  'JSI_HOST_FUNCTION_DECL(createGain);',
  '\n  JSI_HOST_FUNCTION_DECL(createSingzStretch); // SingZ patch 3',
  'host decl'
);
p3 += insertOnce(
  'HostObjects/BaseAudioContextHostObject.cpp',
  '#include <audioapi/HostObjects/effects/GainNodeHostObject.h>',
  '\n#include <audioapi/core/singz/SingzStretchNodeHostObject.h> // SingZ patch 3',
  'host include'
);
p3 += insertOnce(
  'HostObjects/BaseAudioContextHostObject.cpp',
  'JSI_EXPORT_FUNCTION(BaseAudioContextHostObject, createGain),',
  '\n      JSI_EXPORT_FUNCTION(BaseAudioContextHostObject, createSingzStretch), // SingZ patch 3',
  'host export'
);
p3 += insertOnce(
  'HostObjects/BaseAudioContextHostObject.cpp',
  `JSI_HOST_FUNCTION_IMPL(BaseAudioContextHostObject, createGain) {
  const auto options = args[0].asObject(runtime);
  const auto gainOptions = audioapi::option_parser::parseGainOptions(runtime, options);
  auto gainHostObject = std::make_shared<GainNodeHostObject>(context_, gainOptions);
  return jsi::Object::createFromHostObject(runtime, gainHostObject);
}`,
  `

// SingZ patch 3
JSI_HOST_FUNCTION_IMPL(BaseAudioContextHostObject, createSingzStretch) {
  auto hostObject = std::make_shared<SingzStretchNodeHostObject>(context_, AudioNodeOptions());
  return jsi::Object::createFromHostObject(runtime, hostObject);
}`,
  'host impl'
);
console.log(p3 > 0 ? `audio-api patch 3: applied ${p3} insertion(s) + files` : 'audio-api patch 3: already applied (files refreshed)');

/*
 * Patch 4: AudioBuffer.release() — hand back decoded PCM on command.
 * Nothing in the library frees a decoded buffer before its host object is
 * GC-finalized, and a six-stem song is 630-845 MB. Hermes sees only the tiny
 * wrapper (external pressure notwithstanding) and collects whenever it likes,
 * so closing songs back to back stacks whole songs: measured 850-1260 MB
 * still resident after close, and on device a per-process-limit jetsam kill
 * on the fifth song. Clearing channels_ keeps the size/rate metadata valid,
 * so the getters stay safe; only sample access (getChannelData) is invalid
 * afterwards, and callers release exactly when they are done.
 * Regression test: mobile/tests/open-close-memory.cjs.
 */
let p4 = 0;
p4 += insertOnce(
  'utils/AudioBuffer.hpp',
  '  explicit AlignedAudioBuffer() = default;',
  `

  /// SingZ patch 4: free the PCM now instead of at GC finalization.
  /// Metadata (size, rate, channel count) stays valid; samples do not.
  void releaseChannels() {
    channels_.clear();
  }`,
  'releaseChannels'
);
p4 += insertOnce(
  'HostObjects/sources/AudioBufferHostObject.h',
  'JSI_HOST_FUNCTION_DECL(getChannelData);',
  '\n  JSI_HOST_FUNCTION_DECL(release); // SingZ patch 4',
  'release decl'
);
p4 += insertOnce(
  'HostObjects/sources/AudioBufferHostObject.cpp',
  'JSI_EXPORT_FUNCTION(AudioBufferHostObject, getChannelData),',
  '\n      JSI_EXPORT_FUNCTION(AudioBufferHostObject, release), // SingZ patch 4',
  'release export'
);
p4 += insertOnce(
  'HostObjects/sources/AudioBufferHostObject.cpp',
  `JSI_PROPERTY_GETTER_IMPL(AudioBufferHostObject, numberOfChannels) {
  return {static_cast<int>(audioBuffer_->getNumberOfChannels())};
}`,
  `

// SingZ patch 4
JSI_HOST_FUNCTION_IMPL(AudioBufferHostObject, release) {
  if (audioBuffer_ != nullptr) {
    audioBuffer_->releaseChannels();
  }
  return jsi::Value::undefined();
}`,
  'release impl'
);
console.log(p4 > 0 ? `audio-api patch 4: applied ${p4} insertion(s)` : 'audio-api patch 4: already applied');
