/**
 * What every Android driver in this directory needs and must not each get
 * slightly wrong: which app to drive, and how to be quiet about it.
 *
 * Both answers used to be copied into five files. They diverged the moment a
 * real phone entered the picture, which is the case they were both wrong for.
 */

/**
 * The package under test. Defaults to the release/plain-debug id; a
 * SIDE-BY-SIDE debug build (`-PdebugAppIdSuffix=.debug`, the only kind that
 * may go on somebody's own phone — see CLAUDE.md) is a DIFFERENT package, so
 * every path and every `run-as` has to come from here rather than a literal.
 */
const PKG = process.env.ANDROID_PKG || 'com.lexasoft.singz'

/** That package's PRIVATE data dir (`/data/data/<pkg>`, what Kotlin calls
 *  `ctx.filesDir`'s parent) and its EXTERNAL files dir. Named apart on
 *  purpose: "filesDir" means the internal one everywhere else in this repo,
 *  so the external one says so. */
const dataDir = (pkg = PKG) => `/data/data/${pkg}`
const extFilesDir = (pkg = PKG) => `/sdcard/Android/data/${pkg}/files`

/**
 * Is this an emulator? `ro.build.characteristics` carries "emulator" on every
 * AVD image; a phone says "default", "nosdcard" or a vendor string.
 */
function isEmulator(adb) {
  try {
    const ch = adb('shell', 'getprop', 'ro.build.characteristics').toString().trim()
    if (/emulator/i.test(ch)) return true
    // Belt and braces for images that leave it blank.
    return /^(sdk_|generic|emulator)/i.test(adb('shell', 'getprop', 'ro.product.model').toString().trim())
  } catch {
    return false // cannot tell → treat it as a real device, the careful side
  }
}

/**
 * Automated runs are silent — but ONLY the emulator's volume is ours to
 * change. Measured, and it is not a hypothetical:
 *
 *  - On an API-36 AVD, twenty VOLUME_DOWN keyevents do mute STREAM_MUSIC
 *    (dumpsys audio: `Muted: true`, speaker at 0), while the documented
 *    `cmd media_session volume --stream 3 --set 0` prints, connects, exits
 *    and changes nothing. So the keyevents are what work there.
 *  - On a real phone (POCO X6 Pro, HyperOS) the SAME twenty presses left
 *    STREAM_MUSIC at `Muted: false`. Android's volume keys follow the ACTIVE
 *    stream and these suites play nothing, so on a device with no audio in
 *    flight they move the ringer instead — turning down something that is
 *    the owner's, that the suite never restores, and that has nothing to do
 *    with the test.
 *
 * So: keyevents on an emulator only. Everywhere else silence comes from the
 * APP — `__test.engine.master.gain.value = 0`, which every suite can do over
 * CDP and which is what the iOS suites have always done. It is also the
 * better rule: it silences OUR audio without touching the device's settings
 * at all. Suites that assert on the metronome pass `volume: 0` instead
 * (clicks bypass master).
 *
 * Returns what it did, so a driver can say so.
 */
function silenceDevice(adb) {
  if (!isEmulator(adb)) return 'device volume left alone (not an emulator) — mute the app instead'
  try {
    adb('shell', 'cmd', 'media_session', 'volume', '--stream', '3', '--set', '0')
    for (let i = 0; i < 20; i++) adb('shell', 'input', 'keyevent', '25')
    return 'emulator media volume muted'
  } catch {
    return 'emulator refused the mute — not a reason to skip the test'
  }
}

/**
 * Hand a path under the app's EXTERNAL files dir back to the app.
 *
 * Two rules collide here and both are load-bearing:
 *  - `run-as` cannot touch /sdcard at all. It gives you the app's uid but not
 *    its storage sandbox, so it reports "Permission denied" even for
 *    directories the app itself created (CLAUDE.md says so; this is the
 *    second suite to rediscover it).
 *  - `adb push` CAN write there, but on an EMULATOR the result is owned by
 *    `shell` and the app cannot open it. A real phone's FUSE grants by path
 *    and needs nothing.
 *
 * So: push, then on a rooted emulator chown the tree to the app. Best-effort
 * — where root is refused the run fails later with the app's own "cannot
 * open", which is the honest symptom, and the phone path never needs it.
 */
function grantExternal(adb, remoteDir, pkg = PKG) {
  if (!isEmulator(adb)) return false
  try {
    const uid = adb('shell', 'stat', '-c', '%U', dataDir(pkg)).toString().trim()
    if (!uid || /Permission|No such/i.test(uid)) return false
    // /data/media/0 is the same tree as /sdcard, but writable by root.
    // Quoted: these paths contain spaces ("SingZ projects") and adb shell
    // hands its arguments to the device's sh, which word-splits them.
    adb('shell', `chown -R ${uid} ${JSON.stringify(remoteDir.replace('/sdcard/', '/data/media/0/'))}`)
    return true
  } catch {
    return false
  }
}

/*
 * NOT YET USED BY split-android.cjs / split-refused-android.cjs. Both still
 * hardcode `com.lexasoft.singz` and still mute unconditionally. The sweep was
 * written and then reverted: on the side-by-side debug app those two suites
 * fail four checks that all reduce to "the split never started" (B's log
 * assertion, B's card, B's resume, C1's FGS-timeout verdict), and since they
 * had never been run against a suffixed app before, there was no green
 * baseline to say whether the sweep caused it. Editing a permanent suite
 * that cannot be shown green is the thing this repo does not do. Whoever
 * picks it up: seed the 136 MB split model into the target app first
 * (files/models), get the suites green as they stand, THEN sweep them onto
 * this module and show them green again.
 */

module.exports = { PKG, dataDir, extFilesDir, isEmulator, silenceDevice, grantExternal }
