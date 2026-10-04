#!/usr/bin/env node
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const os = require('node:os')
const { execFileSync } = require('node:child_process')
function nativeInputs(repo, cacheRoot = process.env.SINGZ_IOS_NATIVE_CACHE || path.join(os.homedir(), 'Library/Caches/SingZ/ios-native-archives'), toolchain = '') {
  const cacheFile = path.join(cacheRoot, 'input-digests.json')
  const extensions = /\.(?:h|hpp|inc|inl|def|c|cpp|cc|m|mm|swift|a|dylib|xcconfig|pbxproj|plist|entitlements|xcprivacy|xcworkspacedata|xcscheme|podspec|rb|sh|js|json|yaml|yml|ts|tsx|bin|onnx|modulemap|tbd|png|jpg|jpeg|pdf|strings|txt|cmake|storyboard|xib)$/i
  const roots = ['mobile/ios', 'mobile/node_modules', 'mobile/native', 'zcore', 'zdsp', 'third_party', 'assets/pitch']
  let previous = {}
  try { previous = JSON.parse(fs.readFileSync(cacheFile, 'utf8')) } catch {}
  const next = {}
  const files = []
  const visited = new Set()
  function walk(relative) {
    const file = path.join(repo, relative)
    if (!fs.existsSync(file)) return
    const stat = fs.lstatSync(file)
    if (stat.isSymbolicLink()) {
      const real = fs.realpathSync(file)
      if (fs.statSync(real).isFile()) files.push(relative)
      else if (!visited.has(real)) {
        visited.add(real)
        for (const entry of fs.readdirSync(file).sort()) walk(relative + '/' + entry)
      }
      return
    }
    if (stat.isDirectory()) {
      const real = fs.realpathSync(file)
      if (visited.has(real)) return
      visited.add(real)
      if (relative === 'mobile/ios/fastlane' || /(?:^|\/)\.cache(?:\/|$)/.test(relative)) return
      for (const entry of fs.readdirSync(file).sort()) walk(relative + '/' + entry)
    } else if (extensions.test(relative) || /\.framework\//.test(relative) ||
      (relative.startsWith('mobile/ios/') && relative.includes('/compliance/'))) files.push(relative)
  }
  for (const root of roots) walk(root)
  for (const file of ['package.json', 'package-lock.json', 'mobile/package.json', 'mobile/package-lock.json', 'mobile/react-native.config.js', 'mobile/ios/Podfile', 'mobile/ios/Podfile.lock', 'mobile/ios/.xcode.env', 'mobile/ios/.xcode.env.local']) {
    if (fs.existsSync(path.join(repo, file))) files.push(file)
  }
  const hash = crypto.createHash('sha256').update('singz-native-archive-v3\n').update(toolchain).update('\n')
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
