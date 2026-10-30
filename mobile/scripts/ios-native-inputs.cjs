#!/usr/bin/env node
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const os = require('node:os')
const { execFileSync } = require('node:child_process')
function nativeInputs(repo, cacheRoot = process.env.SINGZ_IOS_NATIVE_CACHE || path.join(os.homedir(), 'Library/Caches/SingZ/ios-native-archives'), toolchain = '', options = {}) {
  const cacheFile = path.join(cacheRoot, 'input-digests.json')
  const extensions = /\.(?:h|hpp|inc|inl|def|c|cpp|cc|m|mm|swift|a|dylib|xcconfig|pbxproj|plist|entitlements|xcprivacy|xcworkspacedata|xcscheme|podspec|rb|sh|js|json|yaml|yml|ts|tsx|bin|onnx|modulemap|tbd|png|jpg|jpeg|pdf|strings|txt|cmake|storyboard|xib)$/i
  const eligibleFile = relative => extensions.test(relative) || /\.framework\//.test(relative) ||
    (relative.startsWith('mobile/ios/') && relative.includes('/compliance/'))
  // Android builds must not invalidate an iOS archive. Match only known
  // generated trees and platform-specific downloads; published build/native
  // sources and iOS framework binaries remain inputs.
  const dependencyBuildOutput = relative => relative.startsWith('mobile/node_modules/') && (
    /\/(?:\.gradle|\.cxx|\.externalNativeBuild)(?:\/|$)/.test(relative) ||
    /\/android\/build(?:\/|$)/.test(relative) ||
    /^mobile\/node_modules\/@react-native\/gradle-plugin\/(?:[^/]+\/)?build(?:\/|$)/.test(relative) ||
    /^mobile\/node_modules\/react-native-audio-api\/common\/cpp\/audioapi\/external\/(?:android|macosx)(?:\/|$)/.test(relative))
  // An interrupted pod install can leave unused Local Podspecs behind. The
  // installed manifest, when fully recognized, owns that metadata's membership.
  // Unknown/missing manifests retain all files rather than trusting a guess.
  let installedPods
  try {
    const manifest = fs.readFileSync(path.join(repo, 'mobile/ios/Pods/Manifest.lock'), 'utf8')
    const lines = manifest.split(/\r?\n/)
    const starts = lines.flatMap((line, index) => line === 'SPEC CHECKSUMS:' ? [index] : [])
    if (starts.length === 1) {
      const names = new Set()
      let recognized = false
      for (const line of lines.slice(starts[0] + 1)) {
        if (!line.trim()) continue
        if (/^[^\s]/.test(line)) {
          recognized = /^(?:PODFILE CHECKSUM: [a-fA-F0-9]{40}|COCOAPODS: [0-9]+(?:\.[0-9]+){1,2})$/.test(line)
          break
        }
        const entry = line.match(/^  ([a-zA-Z0-9_.+-]+): [a-fA-F0-9]{40}$/)
        if (!entry || names.has(entry[1])) { recognized = false; break }
        names.add(entry[1])
      }
      if (recognized && names.size) installedPods = names
    }
  } catch {}
  const stalePodMetadata = relative => {
    const pod = relative.match(/^mobile\/ios\/Pods\/Local Podspecs\/([^/]+)\.podspec\.json$/)?.[1]
    return pod && installedPods && !installedPods.has(pod)
  }
  const roots = ['mobile/ios', 'mobile/node_modules', 'mobile/native', 'zcore', 'zdsp', 'third_party', 'assets/pitch']
  const gitmodules = path.join(repo, '.gitmodules')
  const verifier = path.join(repo, 'scripts/verify-zcore-submodule.py')
  let zcoreRevision = 'no-zcore-submodule'
  if (fs.existsSync(gitmodules)) {
    zcoreRevision = options.zcoreRevision ?? execFileSync('python3', [
      verifier,
      '--root', repo,
      '--path', 'third_party/zcore',
      '--print-revision',
    ], { cwd: repo, encoding: 'utf8' }).trim()
    if (!/^[0-9a-f]{40,64}$/i.test(zcoreRevision)) {
      throw new Error(`zCore submodule verifier returned an invalid revision: ${zcoreRevision}`)
    }
  }
  let previous = {}
  try { previous = JSON.parse(fs.readFileSync(cacheFile, 'utf8')) } catch {}
  const next = {}
  const files = []
  const visited = new Set()
  function walk(relative) {
    if (relative.split(/[\\/]/).includes('.git')) return
    const file = path.join(repo, relative)
    if (dependencyBuildOutput(relative) || stalePodMetadata(relative) || !fs.existsSync(file)) return
    const stat = fs.lstatSync(file)
    if (stat.isSymbolicLink()) {
      const real = fs.realpathSync(file)
      if (fs.statSync(real).isFile()) {
        if (eligibleFile(relative)) files.push(relative)
      } else if (!visited.has(real)) {
        visited.add(real)
        for (const entry of fs.readdirSync(file).sort()) walk(relative + '/' + entry)
      }
      return
    }
    if (stat.isDirectory()) {
      const real = fs.realpathSync(file)
      if (visited.has(real)) return
      visited.add(real)
      if (['mobile/ios/build', 'mobile/ios/DerivedData', 'mobile/ios/.build'].includes(relative)) return
      if (relative === 'mobile/ios/fastlane' || /(?:^|\/)\.cache(?:\/|$)/.test(relative)) return
      for (const entry of fs.readdirSync(file).sort()) walk(relative + '/' + entry)
    } else if (eligibleFile(relative)) files.push(relative)
  }
  for (const root of roots) walk(root)
  for (const file of ['.gitmodules', 'scripts/verify-zcore-submodule.py', 'scripts/zcore-gitlink.cjs', 'package.json', 'package-lock.json', 'mobile/package.json', 'mobile/package-lock.json', 'mobile/react-native.config.js', 'mobile/ios/Podfile', 'mobile/ios/Podfile.lock', 'mobile/ios/.xcode.env', 'mobile/ios/.xcode.env.local']) {
    if (fs.existsSync(path.join(repo, file))) files.push(file)
  }
  const hash = crypto.createHash('sha256').update('singz-native-archive-v7\n').update(toolchain).update('\n')
    .update('verified-zcore-gitlink\0').update(zcoreRevision).update('\n')
  for (const relative of [...new Set(files)].sort()) {
    const file = path.join(repo, relative)
    const stat = fs.lstatSync(file)
    const resolved = fs.realpathSync(file)
    const contentStat = fs.statSync(file)
    const signature = `${contentStat.dev}:${contentStat.size}:${contentStat.mtimeMs}:${contentStat.ctimeMs}:${contentStat.ino}`
    const cacheKey = repo + ':' + resolved
    let digest
    if (previous[cacheKey]?.signature === signature) digest = previous[cacheKey].digest
    else {
      let bytes = fs.readFileSync(file)
      if (/\.(?:json|yaml|yml|xcconfig|pbxproj|modulemap|sh|rb)$/.test(relative)) {
        bytes = Buffer.from(bytes.toString().split(repo).join('$CHECKOUT'))
      }
      // App version stamping changes metadata, not the native executable.
      if (relative === 'mobile/ios/SingZPlayer.xcodeproj/project.pbxproj') bytes = Buffer.from(bytes.toString().replace(/CURRENT_PROJECT_VERSION = \d+;/g, 'CURRENT_PROJECT_VERSION = APP_BUILD_NUMBER;'))
      digest = crypto.createHash('sha256').update(bytes).digest('hex')
    }
    next[cacheKey] = { signature, digest }
    hash.update(relative).update('\0').update(digest).update('\n')
  }
  fs.mkdirSync(path.dirname(cacheFile), { recursive: true })
  const temporary = cacheFile + '.' + process.pid + '.tmp'
  fs.writeFileSync(temporary, JSON.stringify({ ...previous, ...next }))
  fs.renameSync(temporary, cacheFile)
  return hash.digest('hex')
}
module.exports = { nativeInputs }
if (require.main === module) {
  const toolchain = execFileSync('xcodebuild', ['-version'], { encoding: 'utf8' }).trim() + '\n' +
    execFileSync('xcrun', ['--sdk', 'iphoneos', '--show-sdk-build-version'], { encoding: 'utf8' }).trim()
  process.stdout.write(nativeInputs(path.resolve(__dirname, '../..'), undefined, toolchain) + '\n')
}
