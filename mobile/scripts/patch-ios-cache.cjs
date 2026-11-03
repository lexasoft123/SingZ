#!/usr/bin/env node
const fs = require('node:fs')
const path = require('node:path')

const upstreamPrepare = String.raw`  s.prepare_command = <<-CMD
    chmod +x scripts/download-prebuilt-binaries.sh
    #{prepare_command_prefix}scripts/download-prebuilt-binaries.sh ios #{skip_ffmpeg_argument}
  CMD`
const cachedPrepare = String.raw`  # SingZ: CocoaPods runs prepare_command from this package's root. Keep this
  # command checkout-independent so rendered podspec checksums do not churn.
  s.prepare_command = <<-CMD
    test -f '../../../scripts/restore-audio-api-prebuilts.cjs' || { echo 'SingZ audio-api cache helper is missing; restore scripts/restore-audio-api-prebuilts.cjs' >&2; exit 1; }
    #{prepare_command_prefix}node '../../../scripts/restore-audio-api-prebuilts.cjs' ios #{skip_ffmpeg_argument}
  CMD`

function patchIosCache(mobileRoot) {
  const filename = path.join(mobileRoot, 'node_modules/react-native-audio-api/RNAudioAPI.podspec')
  const helper = path.resolve(mobileRoot, '../scripts/restore-audio-api-prebuilts.cjs')
  if (!fs.existsSync(helper)) throw new Error('iOS cache patch: cache helper scripts/restore-audio-api-prebuilts.cjs is missing')
  const original = fs.readFileSync(filename, 'utf8')
  const source = original.replace(/\r\n/g, '\n')
  if ((source.match(/^\s*s\.prepare_command\s*=/gm) || []).length !== 1)
    throw new Error('iOS cache patch: RNAudioAPI.podspec prepare_command changed upstream; expected one assignment')
  const before = source.split(upstreamPrepare).length - 1
  const after = source.split(cachedPrepare).length - 1
  if (before === 0 && after === 1) return false
  if (before !== 1 || after !== 0)
    throw new Error('iOS cache patch: RNAudioAPI.podspec prepare_command changed upstream; update the exact cache integration before installing Pods')
  fs.writeFileSync(filename, source.replace(upstreamPrepare, cachedPrepare))
  return true
}

module.exports = { patchIosCache }
if (require.main === module) {
  try {
    console.log(`iOS cache patch: ${patchIosCache(path.resolve(__dirname, '..')) ? 'updated RNAudioAPI prepare command' : 'already applied'}`)
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}
