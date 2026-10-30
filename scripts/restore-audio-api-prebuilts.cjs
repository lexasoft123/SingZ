#!/usr/bin/env node
// Reuse upstream ZIP bytes across npm ci/worktrees; extracted libraries stay local.
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const crypto = require('node:crypto')
const { spawnSync } = require('node:child_process')
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex')
const defaultCacheRoot = () => process.env.SINGZ_AUDIO_API_CACHE || path.join(
  process.platform === 'darwin' ? path.join(os.homedir(), 'Library/Caches') :
    (process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache')), 'SingZ/audio-api-prebuilts')

async function download(url, destination, redirects = 0) {
  if (redirects > 5) throw new Error('Too many audio-api download redirects')
  if (!url.startsWith('https://')) throw new Error('Audio-api downloads require HTTPS')
  await new Promise((resolve, reject) => {
    const req = require('node:https').get(url, response => {
      clearTimeout(headersTimer)
      if ([301, 302, 303, 307, 308].includes(response.statusCode)) {
        response.resume()
        download(new URL(response.headers.location, url).href, destination, redirects + 1).then(resolve, reject)
        return
      }
      if (response.statusCode !== 200) { response.resume(); reject(new Error(`Audio-api download HTTP ${response.statusCode}`)); return }
      const output = fs.createWriteStream(destination, { flags: 'wx' })
      output.on('error', reject)
      response.on('error', error => output.destroy(error))
      response.on('aborted', () => output.destroy(new Error('Audio-api download was truncated')))
      output.on('finish', () => output.close(resolve))
      response.pipe(output)
    })
    const headersTimer = setTimeout(() => req.destroy(new Error('Audio-api response timed out')), 30_000)
    req.on('close', () => clearTimeout(headersTimer))
    req.setTimeout(30_000, () => req.destroy(new Error('Audio-api download timed out')))
    req.on('error', reject)
  })
}
function run(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })
  if (result.error || result.status !== 0) throw new Error(result.error?.message || `${command}: ${result.stderr || result.stdout}`)
  return result.stdout
}
function validateZip(file, name) {
  run('unzip', ['-tq', file])
  const entries = run('unzip', ['-Z1', file]).trim().split(/\r?\n/)
  if (!entries.length || entries.some(entry => entry.includes('\\') || entry.startsWith('/') ||
      entry.split('/').includes('..') || !(entry.startsWith(`${name}/`) || entry.startsWith('__MACOSX/'))))
    throw new Error(`Unexpected paths in audio-api ${name} archive`)
  // Check link destinations before unzip can follow a directory link while
  // extracting a later entry. Metadata is never extracted or installed.
  const links = new Map()
  const canonical = entries.map(entry => entry.replace(/\/$/, ''))
  if (new Set(canonical).size !== canonical.length || entries.some(entry => entry.split('/').some((part, index, parts) => part === '.' || (!part && index < parts.length - 1))))
    throw new Error('Ambiguous audio-api archive paths')
  const details = run('unzip', ['-Z', '-l', file]).split(/\r?\n/)
  for (const line of details.filter(line => /^l\S*\s/.test(line))) {
    const entry = [...entries].sort((a, b) => b.length - a.length).find(entry => line.endsWith(' ' + entry))
    if (!entry || !entry.startsWith(`${name}/`)) throw new Error('Unexpected audio-api archive symlink')
    const target = run('unzip', ['-p', file, entry])
    if (/[\r\n\\:]/.test(target) || path.posix.isAbsolute(target))
      throw new Error('Audio-api archive symlink escapes extraction root')
    links.set(entry, target)
  }
  // Resolve components in filesystem order: normalize(a/../) is unsafe when
  // a itself is a symlink. Check the whole map before giving bytes to unzip.
  for (const entry of entries.filter(entry => entry.startsWith(`${name}/`))) {
    const pending = entry.split('/'), resolved = []; let hops = 0
    while (pending.length) {
      const component = pending.shift()
      if (!component || component === '.') continue
      if (component === '..') {
        if (resolved.length <= 1) throw new Error('Audio-api archive symlink escapes extraction root')
        resolved.pop(); continue
      }
      resolved.push(component)
      const target = links.get(resolved.join('/'))
      if (target !== undefined) {
        if (++hops > 40) throw new Error('Audio-api archive symlink cycle')
        resolved.pop()
        pending.unshift(...target.split('/'))
      }
      if (resolved.length && resolved[0] !== name) throw new Error('Audio-api archive symlink escapes extraction root')
    }
  }
}
function checkExtracted(directory, root = directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name)
    if (entry.isSymbolicLink()) {
      const target = path.resolve(path.dirname(file), fs.readlinkSync(file))
      if (!target.startsWith(root + path.sep)) throw new Error('Audio-api archive symlink escapes extraction root')
    } else if (entry.isDirectory()) checkExtracted(file, root)
  }
}
function frameworkLinks(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const file = path.join(directory, entry.name)
    if (entry.name.endsWith('.framework')) {
      const name = entry.name.slice(0, -10), version = path.join(file, 'Versions/A')
      if (fs.existsSync(path.join(version, name))) {
        for (const [link, target] of [['Versions/Current', 'A'], [name, `Versions/Current/${name}`],
          ['Resources', 'Versions/Current/Resources'], ['Headers', 'Versions/Current/Headers']]) {
          if (!fs.existsSync(path.resolve(path.dirname(path.join(file, link)), target))) continue
          try { fs.lstatSync(path.join(file, link)); continue } catch (error) { if (error.code !== 'ENOENT') throw error }
          fs.symlinkSync(target, path.join(file, link))
        }
      }
    }
    frameworkLinks(file)
  }
}
async function restore({ repoRoot = path.resolve(__dirname, '..'), platform, cacheRoot = defaultCacheRoot(), fetch = download,
  skipFFmpeg = false, skipStatic = process.env.DISABLE_AUDIOAPI_STATIC_EXTERNAL_LIBS === '1' }) {
  if (!['ios', 'android'].includes(platform)) throw new Error('Choose audio-api platform ios or android')
  const pkg = path.join(repoRoot, 'mobile/node_modules/react-native-audio-api')
  const script = fs.readFileSync(path.join(pkg, 'scripts/download-prebuilt-binaries.sh'), 'utf8')
  const url = script.match(/^MAIN_DOWNLOAD_URL="(https:\/\/[^"\r\n]+)"/m)?.[1]
  const tag = script.match(/^TAG="([^"\r\n]+)"/m)?.[1]
  if (!url || !tag || !/^[a-zA-Z0-9._-]+$/.test(tag)) throw new Error('Unrecognized upstream audio-api download contract')
  const version = JSON.parse(fs.readFileSync(path.join(pkg, 'package.json'))).version
  const names = (platform === 'ios' ? ['ffmpeg_ios', 'iphoneos', 'iphonesimulator'] : ['android', 'jniLibs'])
    .filter(name => ['ffmpeg_ios', 'jniLibs'].includes(name) ? !skipFFmpeg : !skipStatic)
  for (const name of names) {
    const parent = name === 'jniLibs' ? path.join(pkg, 'android/src/main') : path.join(pkg, 'common/cpp/audioapi/external')
    const output = path.join(parent, name)
    if (fs.existsSync(output) && fs.lstatSync(output).isDirectory()) continue
    const address = `${url}/${tag}/${name}.zip`
    const key = sha(JSON.stringify([address, version, sha(script)]))
    const entry = path.join(cacheRoot, key), zip = path.join(entry, 'archive.zip'), receipt = path.join(entry, 'receipt.json')
    fs.mkdirSync(entry, { recursive: true })
    const lock = path.join(entry, 'lock')
    let acquired = false
    for (let attempt = 0; attempt < 120; attempt++) {
      try { fs.mkdirSync(lock); acquired = true; break } catch (error) { if (error.code !== 'EEXIST') throw error }
      await new Promise(resolve => setTimeout(resolve, 250))
    }
    if (!acquired) throw new Error(`Audio-api cache busy or interrupted: ${lock}`)
    const stage = fs.mkdtempSync(path.join(entry, 'extract-'))
    try {
      let valid = false
      try {
        const info = JSON.parse(fs.readFileSync(receipt, 'utf8'))
        valid = info.format === 1 && info.url === address && info.sha256 === sha(fs.readFileSync(zip))
      } catch {}
      if (!valid) {
        const partial = path.join(entry, `download-${process.pid}-${crypto.randomBytes(6).toString('hex')}.zip`)
        try {
          await fetch(address, partial)
          validateZip(partial, name)
          fs.renameSync(partial, zip)
          const record = JSON.stringify({ format: 1, url: address, sha256: sha(fs.readFileSync(zip)) })
          fs.writeFileSync(receipt + '.tmp', record)
          fs.renameSync(receipt + '.tmp', receipt)
        } finally { fs.rmSync(partial, { force: true }) }
      }
      validateZip(zip, name)
      run('unzip', ['-qo', zip, `${name}/*`, '-d', stage])
      checkExtracted(stage)
      const extracted = path.join(stage, name)
      if (!fs.statSync(extracted).isDirectory() || !fs.readdirSync(extracted).length)
        throw new Error(`Empty audio-api ${name} archive`)
      checkExtracted(extracted)
      if (name === 'ffmpeg_ios') frameworkLinks(extracted)
      checkExtracted(extracted)
      fs.mkdirSync(parent, { recursive: true })
      // Same-filesystem staging allows atomic rename without writing through
      // old output symlinks. The shared download cache may be another volume.
      const local = fs.mkdtempSync(path.join(parent, '.singz-prebuilt-'))
      try {
        fs.cpSync(extracted, path.join(local, name), { recursive: true, verbatimSymlinks: true })
        try { if (fs.lstatSync(output).isSymbolicLink()) fs.unlinkSync(output) } catch (error) { if (error.code !== 'ENOENT') throw error }
        fs.renameSync(path.join(local, name), output)
      } finally { fs.rmSync(local, { recursive: true, force: true }) }
      console.log(`audio-api prebuilts: ${name} restored from verified shared cache`)
    } finally {
      fs.rmSync(stage, { recursive: true, force: true })
      fs.rmdirSync(lock)
    }
  }
}
module.exports = { restore, validateZip, defaultCacheRoot }
if (require.main === module) restore({ platform: process.argv[2], skipFFmpeg: process.argv[3] === 'skipffmpeg' }).catch(error => { console.error(error.message); process.exitCode = 1 })
