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
const SHARE = `// SingZ patch (scripts/patch-audio-api.js): share instead of deep-copying.
      copiedBuffer = buffer;`;

const src = fs.readFileSync(file, 'utf8');
if (src.includes('SingZ patch')) {
  console.log('audio-api patch: already applied');
} else if (src.includes(COPY)) {
  fs.writeFileSync(file, src.replace(COPY, SHARE));
  console.log('audio-api patch: applied (shared AudioBuffer on setBuffer)');
} else {
  console.error(
    'audio-api patch: target code not found — upstream changed ' +
      'AudioBufferSourceNodeHostObject.cpp; re-check the copy-per-setBuffer ' +
      'behavior before shipping.'
  );
  process.exit(1);
}
