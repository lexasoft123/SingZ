import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'

export const safePackRelative = (path) =>
  typeof path === 'string' && path.length > 0 && !path.startsWith('/') &&
  !path.includes('\\') && !path.split('/').includes('..')

const isInside = (parent, child) => {
  const nested = relative(parent, child)
  return nested !== '' && safePackRelative(nested.replaceAll('\\', '/'))
}

/** Read the one product-selection receipt without consulting ambient install
 * state beyond the explicitly supplied dependency root. Both proof and
 * release callers therefore validate the same closed policy. */
export const readProductSelectionReceipt = ({ dependency, profile, proofStaging }) => {
  const path = join(
    dependency, 'common', 'cpp', 'audioapi', 'external',
    'singz-ffmpeg-selection.json',
  )
  if (!existsSync(path)) return { path, receipt: null }
  const receipt = JSON.parse(readFileSync(path, 'utf8'))
  if (receipt.format !== 1 || receipt.profile !== profile.profile ||
      JSON.stringify(receipt.source) !== JSON.stringify(profile.source) ||
      !Array.isArray(receipt.selections) || receipt.selections.length === 0)
    throw new Error('Malformed or wrong-profile FFmpeg product selection receipt')
  const expectedMode = proofStaging ? 'target-proof-staging' : 'release-proven'
  if (receipt.mode !== expectedMode)
    throw new Error(`FFmpeg product selection mode is ${receipt.mode || 'missing'}, expected ${expectedMode}`)
  const selectedTargets = receipt.selections.map((row) => row?.target)
  if (selectedTargets.some((target, index) =>
    typeof target !== 'string' || selectedTargets.indexOf(target) !== index))
    throw new Error('FFmpeg product selection has missing or duplicate targets')
  return { path, receipt }
}

/** Resolve one receipt-named pack under the physical vendor root. Lexical
 * containment rejects traversal; lstat rejects a symlink at the pack root;
 * realpath containment also closes escapes through a symlinked ancestor. */
export const resolveProductPackRoot = ({ repo, vendorRoot, selection }) => {
  if (!safePackRelative(selection?.pack))
    throw new Error(`Unsafe FFmpeg product pack path: ${selection?.pack}`)
  const pack = resolve(repo, selection.pack)
  if (!isInside(vendorRoot, pack))
    throw new Error(`FFmpeg selection escapes the product pack root: ${selection.pack}`)
  if (!existsSync(pack))
    throw new Error(`FFmpeg product pack is missing: ${selection.pack}`)
  const entry = lstatSync(pack)
  if (!entry.isDirectory() || entry.isSymbolicLink())
    throw new Error(`FFmpeg product pack root is not a real directory: ${selection.pack}`)
  const physicalVendorRoot = realpathSync(vendorRoot)
  const physicalPack = realpathSync(pack)
  if (!isInside(physicalVendorRoot, physicalPack))
    throw new Error(`FFmpeg selection escapes the physical product pack root: ${selection.pack}`)
  return pack
}

/** SINGZ_FFMPEG_CODECS decides what a build does when a target has no fully
 * proven product pack. `auto` (the default, and what CI runs) selects only
 * packs carrying target fixture evidence and otherwise keeps RNAudioAPI's
 * compatibility runtime while zcore compiles its base WAV/FLAC decoder, so the
 * native capability it reports is exactly what was proven. `required` fails
 * closed instead, for a release lane that must ship the full matrix. `off`
 * never selects a product pack, even a proven one. */
export const codecRuntimeMode = (env = process.env) => {
  const value = env.SINGZ_FFMPEG_CODECS ?? 'auto'
  if (value !== 'auto' && value !== 'required' && value !== 'off')
    throw new Error(`SINGZ_FFMPEG_CODECS must be auto, required or off (got ${JSON.stringify(value)})`)
  return value
}

/** Whether a product pack manifest carries full target fixture evidence for
 * every slice it ships. Configuration evidence alone never qualifies. */
export const packHasFullMatrixEvidence = (manifest) => {
  if (manifest?.target === 'ios-xcframeworks') {
    const slices = manifest.slices ?? {}
    return ['ios-arm64', 'ios-simulator-arm64', 'ios-simulator-x64']
      .every((name) => slices[name]?.fullMatrixFixtureEvidence === true)
  }
  return manifest?.fixtureEvidence?.fullMatrix === true
}
