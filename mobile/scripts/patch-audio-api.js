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
