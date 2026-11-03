const path = require('node:path')
const feature = path.resolve(__dirname, '../src/features/torrent-feature.tsx')
const disabled = path.resolve(__dirname, '../src/features/torrent-feature.disabled.tsx')

// Unknown/non-development iOS configurations fail closed. The environment is
// set by Xcode, including cached-archive rebundling; it is not a runtime toggle.
function iosTorrentsEnabled(dev, env = process.env) {
  const configuration = env.CONFIGURATION
  if (configuration === 'Release') return false
  if (configuration === 'AdHoc') return env.SINGZ_ENABLE_TORRENTS === '1'
  if (configuration && configuration !== 'Debug') return false
  return dev && env.SINGZ_ENABLE_TORRENTS !== '0'
}
function resolveTorrentModule(context, moduleName, platform) {
  const result = context.resolveRequest(context, moduleName, platform)
  if (platform !== 'ios' || iosTorrentsEnabled(context.dev)) return result
  if (result.type !== 'sourceFile') return result
  if (result.filePath === feature) return { type: 'sourceFile', filePath: disabled }
  // An accidental new direct import must fail the store build, rather than
  // quietly putting the optional engine's provider code back into the bundle.
  if (/[\\/]src[\\/](?:torrent\.ts$|ui[\\/]Torrent[^\\/]*|shared[\\/]torrent[^\\/]*)/.test(result.filePath)) {
    throw new Error('Optional download source reached a disabled iOS build: ' + result.filePath)
  }
  return result
}
module.exports = { iosTorrentsEnabled, resolveTorrentModule }
