const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { test } = require('node:test')
const { spawnSync } = require('node:child_process')
const { crc32 } = require('node:zlib')
const { restore } = require('../../scripts/restore-audio-api-prebuilts.cjs')
const unzipAvailable = spawnSync('unzip', ['-v'], { stdio: 'ignore' }).status === 0
const zipOptions = { skip: unzipAvailable ? false : 'unzip is required for native audio library provisioning' }
function zip(files) {
  const local = [], central = []; let offset = 0
  for (const [name, text] of Object.entries(files)) {
    const filename = Buffer.from(name), body = Buffer.from(typeof text === 'string' ? text : text.symlink), crc = crc32(body)
    const header = Buffer.alloc(30)
    header.writeUInt32LE(0x04034b50); header.writeUInt16LE(20, 4)
    header.writeUInt32LE(crc, 14); header.writeUInt32LE(body.length, 18); header.writeUInt32LE(body.length, 22); header.writeUInt16LE(filename.length, 26)
    local.push(header, filename, body)
    const record = Buffer.alloc(46)
    record.writeUInt32LE(0x02014b50); record.writeUInt16LE(0x0314, 4);
    record.writeUInt32LE(((typeof text === 'string' ? 0o100644 : 0o120777) * 65536) >>> 0, 38); record.writeUInt16LE(20, 6)
    record.writeUInt32LE(crc, 16); record.writeUInt32LE(body.length, 20); record.writeUInt32LE(body.length, 24); record.writeUInt16LE(filename.length, 28); record.writeUInt32LE(offset, 42)
    central.push(record, filename); offset += header.length + filename.length + body.length
  }
  const directory = Buffer.concat(central), end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(central.length / 2, 8); end.writeUInt16LE(central.length / 2, 10); end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16)
  return Buffer.concat([...local, directory, end])
}
function fixture(t) {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'singz-audio-cache-'))
  t.after(() => fs.rmSync(scratch, { recursive: true, force: true }))
  const cacheRoot = path.join(scratch, 'shared-cache')
  const checkout = name => {
    const root = path.join(scratch, name), pkg = path.join(root, 'mobile/node_modules/react-native-audio-api')
    fs.mkdirSync(path.join(pkg, 'scripts'), { recursive: true })
    fs.writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({ version: 'fixture-1' }))
    fs.writeFileSync(path.join(pkg, 'scripts/download-prebuilt-binaries.sh'), 'MAIN_DOWNLOAD_URL="https://fixtures.invalid/releases"\nTAG="v1"\n')
    return { root, pkg }
  }
  return { scratch, cacheRoot, checkout }
}
const fetchFiles = counter => async (url, output) => {
  counter.count++
  const name = new URL(url).pathname.split('/').at(-1).replace('.zip', '')
  fs.writeFileSync(output, zip({ [`${name}/libfixture.a`]: 'native fixture bytes', [`__MACOSX/._${name}`]: 'upstream metadata' }))
}
test('fresh worktrees and npm reinstalls reuse checksum-verified upstream downloads offline', zipOptions, async t => {
  const f = fixture(t), first = f.checkout('first'), second = f.checkout('second'), count = { count: 0 }
  await restore({ repoRoot: first.root, platform: 'ios', cacheRoot: f.cacheRoot, fetch: fetchFiles(count) })
  assert.equal(count.count, 3)
  const offline = async () => { throw new Error('network unavailable') }
  await restore({ repoRoot: second.root, platform: 'ios', cacheRoot: f.cacheRoot, fetch: offline })
  const external = path.join(second.pkg, 'common/cpp/audioapi/external')
  assert.equal(fs.readFileSync(path.join(external, 'iphoneos/libfixture.a'), 'utf8'), 'native fixture bytes')
  fs.rmSync(external, { recursive: true })
  await restore({ repoRoot: second.root, platform: 'ios', cacheRoot: f.cacheRoot, fetch: offline })
  assert.equal(count.count, 3)
})
test('corrupt cached bytes and changed upstream pins require a validated download', zipOptions, async t => {
  const f = fixture(t), first = f.checkout('first'), second = f.checkout('second'), count = { count: 0 }
  await restore({ repoRoot: first.root, platform: 'android', cacheRoot: f.cacheRoot, fetch: fetchFiles(count) })
  const entry = fs.readdirSync(f.cacheRoot)[0]
  fs.writeFileSync(path.join(f.cacheRoot, entry, 'archive.zip'), 'corrupted')
  await restore({ repoRoot: second.root, platform: 'android', cacheRoot: f.cacheRoot, fetch: fetchFiles(count) })
  assert.equal(count.count, 3, 'only the corrupt archive should be fetched again')
  const third = f.checkout('changed-tag')
  fs.appendFileSync(path.join(third.pkg, 'scripts/download-prebuilt-binaries.sh'), '# changed upstream producer\n')
  await restore({ repoRoot: third.root, platform: 'android', cacheRoot: f.cacheRoot, fetch: fetchFiles(count) })
  assert.equal(count.count, 5)
})
test('unsafe or interrupted downloads never install partial libraries or leave a busy lock', zipOptions, async t => {
  const f = fixture(t), first = f.checkout('first')
  const unsafe = async (_, output) => fs.writeFileSync(output, zip({ '../escape': 'bad' }))
  await assert.rejects(restore({ repoRoot: first.root, platform: 'ios', cacheRoot: f.cacheRoot, fetch: unsafe }), /Unexpected paths/)
  const partial = async (_, output) => { fs.writeFileSync(output, 'partial'); throw new Error('interrupted') }
  await assert.rejects(restore({ repoRoot: first.root, platform: 'ios', cacheRoot: f.cacheRoot, fetch: partial }), /interrupted/)
  for (const entry of fs.readdirSync(f.cacheRoot)) {
    assert.equal(fs.existsSync(path.join(f.cacheRoot, entry, 'lock')), false)
    assert.equal(fs.readdirSync(path.join(f.cacheRoot, entry)).some(name => name.startsWith('download-')), false)
  }
  assert.equal(fs.existsSync(path.join(first.pkg, 'common/cpp/audioapi/external/ffmpeg_ios')), false)
})

test('archive links cannot reference metadata that is not installed', {
  skip: process.platform === 'win32' || !unzipAvailable ? 'POSIX ZIP symlinks require unzip' : false,
}, async t => {
  const f = fixture(t), first = f.checkout('first')
  const linked = async (_, output) => fs.writeFileSync(output, zip({
    'ffmpeg_ios/libfixture.a': 'native bytes',
    '__MACOSX/payload': 'not installed',
    'ffmpeg_ios/link': { symlink: '../__MACOSX/payload' },
  }))
  await assert.rejects(restore({ repoRoot: first.root, platform: 'ios', cacheRoot: f.cacheRoot, fetch: linked }), /symlink escapes extraction root/)
  assert.equal(fs.existsSync(path.join(first.pkg, 'common/cpp/audioapi/external/ffmpeg_ios')), false)
})

test('escaping directory links are rejected before a later ZIP entry can write through them', {
  skip: process.platform === 'win32' || !unzipAvailable ? 'POSIX ZIP symlinks require unzip' : false,
}, async t => {
  const f = fixture(t), first = f.checkout('first')
  const linked = async (_, output) => fs.writeFileSync(output, zip({
    'ffmpeg_ios/link': { symlink: '../../outside' },
    'ffmpeg_ios/link/injected': 'must never be extracted',
  }))
  await assert.rejects(restore({ repoRoot: first.root, platform: 'ios', cacheRoot: f.cacheRoot, fetch: linked }), /symlink escapes extraction root/)
  for (const entry of fs.readdirSync(f.cacheRoot))
    assert.equal(fs.existsSync(path.join(f.cacheRoot, entry, 'outside')), false)
})


test('disabled FFmpeg and static libraries never require unneeded archives', zipOptions, async t => {
  const f = fixture(t), count = { count: 0 }
  for (const platform of ['ios', 'android']) {
    const empty = f.checkout(platform + '-disabled')
    await restore({ repoRoot: empty.root, platform, cacheRoot: f.cacheRoot, skipFFmpeg: true, skipStatic: true,
      fetch: async () => { throw new Error('disabled libraries must stay offline') } })
    const statics = f.checkout(platform + '-static-only')
    await restore({ repoRoot: statics.root, platform, cacheRoot: f.cacheRoot, skipFFmpeg: true, skipStatic: false, fetch: fetchFiles(count) })
    const external = path.join(statics.pkg, 'common/cpp/audioapi/external')
    assert.equal(fs.existsSync(path.join(external, 'ffmpeg_ios')), false)
    assert.equal(fs.existsSync(path.join(statics.pkg, 'android/src/main/jniLibs')), false)
    const ffmpeg = f.checkout(platform + '-ffmpeg-only')
    await restore({ repoRoot: ffmpeg.root, platform, cacheRoot: f.cacheRoot, skipFFmpeg: false, skipStatic: true, fetch: fetchFiles(count) })
    for (const name of ['android', 'iphoneos', 'iphonesimulator'])
      assert.equal(fs.existsSync(path.join(ffmpeg.pkg, 'common/cpp/audioapi/external', name)), false)
  }
  assert.equal(count.count, 5)
})


test('chained links resolve components before parent traversal and reject cycles', {
  skip: process.platform === 'win32' || !unzipAvailable ? 'POSIX ZIP symlinks require unzip' : false,
}, async t => {
  const f = fixture(t)
  for (const cycle of [false, true]) {
    const checkout = f.checkout(cycle ? 'cycle' : 'chain')
    const linked = async (_, output) => fs.writeFileSync(output, zip({
      'ffmpeg_ios/shallow/keep': 'safe',
      'ffmpeg_ios/sub/a': { symlink: '../shallow' },
      'ffmpeg_ios/link': { symlink: cycle ? 'link' : 'sub/a/../../outside' },
    }))
    await assert.rejects(restore({ repoRoot: checkout.root, platform: 'ios', cacheRoot: f.cacheRoot, fetch: linked }), /symlink (escapes|cycle)/)
    assert.equal(fs.existsSync(path.join(checkout.pkg, 'common/cpp/audioapi/external/ffmpeg_ios')), false)
  }
})
