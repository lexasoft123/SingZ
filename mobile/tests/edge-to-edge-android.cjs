/**
 * Release-APK edge-to-edge/inset check, without Metro or debug JS hooks.
 * Install the APK first, then ANDROID_SERIAL=emulator-5582 node
 * mobile/tests/edge-to-edge-android.cjs. Requires an English emulator.
 * API 34 exposes a false edgeToEdgeEnabled control: its React content starts
 * below the status bar. The fixed app must fill the display while keeping
 * header actions and bottom tabs inside the native system-bar safe rectangle.
 * Exercises gesture/three-button navigation in portrait and landscape, plus
 * Settings, Log and Training. It never plays audio or touches the library.
 */
require('../../tests/shared/watchdog.cjs').arm('edge-to-edge-android')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { execFileSync } = require('node:child_process')
const { PKG, isEmulator, silenceDevice } = require('./android-lib.cjs')

const serial = process.env.ANDROID_SERIAL
assert.ok(serial, 'Set ANDROID_SERIAL explicitly; this driver changes emulator navigation/rotation')
const adbPath = process.env.ADB || path.join(os.homedir(), 'Library/Android/sdk/platform-tools/adb')
const out = process.env.E2E_ARTIFACTS || fs.mkdtempSync(path.join(os.tmpdir(), 'singz-edge-to-edge-'))
fs.mkdirSync(out, { recursive: true })
const adb = (...args) => execFileSync(adbPath, ['-s', serial, ...args], {
  encoding: 'utf8', timeout: 20_000, maxBuffer: 30e6
})
const shell = (...args) => adb('shell', ...args)
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const rect = values => values.map(Number)
const rectangle = /\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]/
let checks = 0
function check(condition, message) {
  assert.ok(condition, message)
  checks++
  console.log(`PASS ${message}`)
}

function nativeBounds(label) {
  const displays = shell('dumpsys', 'window', 'displays')
  const activity = shell('dumpsys', 'activity', 'top')
  fs.writeFileSync(path.join(out, `${label}-windows.txt`), displays)
  fs.writeFileSync(path.join(out, `${label}-activity.txt`), activity)
  assert.ok(displays.includes(`${PKG}/com.singzplayer.MainActivity`), 'SingZ must own the focused window')
  const displayMatch = displays.match(/mDisplayFrame=Rect\((\d+), (\d+) - (\d+), (\d+)\)/)
  assert.ok(displayMatch, 'native display frame must be available')
  const display = rect(displayMatch.slice(1))
  const safe = [...display]
  const width = display[2] - display[0], height = display[3] - display[1]
  for (const line of displays.split('\n')) {
    if (!/InsetsSource .*type=(statusBars|navigationBars|displayCutout) /.test(line) || !line.includes('visible=true')) continue
    const match = line.match(rectangle)
    if (!match) continue
    const [left, top, right, bottom] = rect(match.slice(1))
    if (right - left >= width / 2 && bottom - top < height / 2) {
      if (top === display[1]) safe[1] = Math.max(safe[1], bottom)
      if (bottom === display[3]) safe[3] = Math.min(safe[3], top)
    } else if (bottom - top >= height / 2 && right - left < width / 2) {
      if (left === display[0]) safe[0] = Math.max(safe[0], right)
      if (right === display[2]) safe[2] = Math.min(safe[2], left)
    }
  }
  assert.ok(safe.some((value, index) => value !== display[index]), 'visible native bars must create a nonempty inset')

  // View hierarchy coordinates are relative to their parents. Accumulate the
  // native ancestors rather than trusting content's local 0,0 as fullscreen.
  const section = activity.split(/\n\s*ACTIVITY /).find(value => value.split('\n')[0].startsWith(`${PKG}/com.singzplayer.MainActivity `))
  assert.ok(section, 'SingZ activity hierarchy must be available')
  const hierarchy = section.split('View Hierarchy:')[1]
  assert.ok(hierarchy, 'native activity must expose its view hierarchy')
  const parents = []
  let content
  for (const line of hierarchy.split('\n')) {
    const match = line.match(/^(\s*)\S+\{.*? (-?\d+),(-?\d+)-(-?\d+),(-?\d+)(?: |\})/)
    if (!match) continue
    const indent = match[1].length
    while (parents.length && parents.at(-1).indent >= indent) parents.pop()
    const parent = parents.at(-1)?.bounds || [0, 0, 0, 0]
    const local = rect(match.slice(2))
    const bounds = [parent[0] + local[0], parent[1] + local[1], parent[0] + local[2], parent[1] + local[3]]
    parents.push({ indent, bounds })
    if (/android:id\/content\}/.test(line)) { content = bounds; break }
  }
  assert.ok(content, 'native android:id/content bounds must be present')
  check(content.every((value, index) => Math.abs(value - display[index]) <= 1),
    `${label}: native app content fills display ${JSON.stringify(display)} (got ${JSON.stringify(content)})`)
  return { display, safe }
}

function nodes(label) {
  shell('uiautomator', 'dump', '/sdcard/singz-edge-to-edge.xml')
  const xml = shell('cat', '/sdcard/singz-edge-to-edge.xml')
  fs.writeFileSync(path.join(out, `${label}.xml`), xml)
  return [...xml.matchAll(/<node\s+([^>]+)>/g)].map(match => {
    const attrs = Object.fromEntries([...match[1].matchAll(/([\w-]+)="([^"]*)"/g)].map(item => [item[1], item[2]]))
    const bounds = attrs.bounds?.match(rectangle)
    return { ...attrs, bounds: bounds ? rect(bounds.slice(1)) : null }
  })
}
function find(items, name) {
  const actions = items.filter(node => node.clickable === 'true' && node.enabled === 'true' && node.bounds && node.bounds[2] > node.bounds[0])
  return actions.find(node => node['content-desc'] === name) || actions.find(node => node.text === name)
}
async function waitFor(name, label) {
  let items
  for (let attempt = 0; attempt < 6; attempt++) {
    items = nodes(label)
    if (find(items, name)) return items
    await sleep(500)
  }
  throw new Error(`${label}: missing English control '${name}'; artifacts ${out}`)
}
function within(items, name, safe, label) {
  const node = find(items, name)
  assert.ok(node, `${label}: required '${name}' control must be present`)
  const [left, top, right, bottom] = node.bounds
  check(left >= safe[0] - 1 && top >= safe[1] - 1 && right <= safe[2] + 1 && bottom <= safe[3] + 1,
    `${label}: '${name}' ${JSON.stringify(node.bounds)} is inside native safe bounds ${JSON.stringify(safe)}`)
  return node
}
function tap(node) {
  const [left, top, right, bottom] = node.bounds
  shell('input', 'tap', String(Math.round((left + right) / 2)), String(Math.round((top + bottom) / 2)))
}
function screenshot(label) {
  fs.writeFileSync(path.join(out, `${label}.png`), execFileSync(adbPath, ['-s', serial, 'exec-out', 'screencap', '-p'], { timeout: 20_000 }))
}
async function waitForOrientation(orientation, label) {
  for (let attempt = 0; attempt < 15; attempt++) {
    const match = shell('dumpsys', 'window', 'displays').match(/mDisplayFrame=Rect\((\d+), (\d+) - (\d+), (\d+)\)/)
    if (match) {
      const [left, top, right, bottom] = rect(match.slice(1))
      if ((right - left > bottom - top) === (orientation === 1)) return
    }
    await sleep(300)
  }
  throw new Error(`${label}: native display did not settle to the requested orientation`)
}

async function main() {
  assert.ok(isEmulator(adb), 'Use an isolated emulator; never change a singer’s device settings')
  console.log(silenceDevice(adb))
  const sdk = Number(shell('getprop', 'ro.build.version.sdk').trim())
  assert.ok(sdk >= 29, 'gesture-mode coverage requires API 29 or newer')
  const rotation = shell('settings', 'get', 'system', 'user_rotation').trim()
  const accelerometer = shell('settings', 'get', 'system', 'accelerometer_rotation').trim()
  const windowRotation = shell('wm', 'user-rotation').trim().split(/\s+/)
  const fixedRotation = shell('wm', 'fixed-to-user-rotation').trim()
  const previousOverlay = shell('cmd', 'overlay', 'list').split('\n').find(line => /^\[x\].*\.navbar\./.test(line.trim()))?.trim().split(/\s+/)[1]
  const launcher = shell('cmd', 'package', 'resolve-activity', '--brief', PKG).trim().split('\n').at(-1)
  assert.ok(launcher.includes('/'), 'installed app must have a launcher')
  try {
    // The emulator launcher requests NOSENSOR and can otherwise keep the
    // display portrait between activities despite a locked user rotation.
    shell('wm', 'fixed-to-user-rotation', 'enabled')
    shell('input', 'keyevent', '82')
    for (const navigation of ['gestural', 'threebutton']) {
      shell('cmd', 'overlay', 'enable-exclusive', '--category', `com.android.internal.systemui.navbar.${navigation}`)
      await sleep(500)
      check(Number(shell('settings', 'get', 'secure', 'navigation_mode').trim()) === (navigation === 'gestural' ? 2 : 0),
        `${navigation}: requested system navigation mode is active`)
      for (const orientation of [0, 1]) {
        const label = `api${sdk}-${navigation}-${orientation ? 'landscape' : 'portrait'}`
        shell('am', 'force-stop', PKG)
        // Use one WindowManager command as the rotation authority. Writing
        // Settings too queues a second asynchronous policy update that can
        // overwrite the requested orientation when the activity launches.
        shell('wm', 'user-rotation', 'lock', String(orientation))
        await waitForOrientation(orientation, label)
        shell('am', 'start', '-W', '-n', launcher)
        await sleep(1500)
        await waitForOrientation(orientation, label)
        let items = await waitFor('Songs', `${label}-launch`)
        // A new release can open its announcement before the library. Close
        // it through the real acknowledgement button rather than clearing data.
        if (find(items, 'Got it')) {
          tap(find(items, 'Got it'))
          await sleep(500)
        }
        screenshot(`${label}-native`)
        const { display, safe } = nativeBounds(label)
        check((display[2] - display[0] > display[3] - display[1]) === (orientation === 1),
          `${label}: native display has the requested orientation`)
        items = await waitFor('Open Settings', `${label}-library`)
        for (const name of ['Open Settings', 'Open the log', 'Songs', 'Train']) within(items, name, safe, label)
        screenshot(`${label}-library`)
        tap(find(items, 'Open Settings'))
        items = await waitFor('Close Settings', `${label}-settings`)
        within(items, 'Close Settings', safe, label)
        screenshot(`${label}-settings`)
        tap(find(items, 'Close Settings'))
        items = await waitFor('Open the log', `${label}-library-return`)
        tap(find(items, 'Open the log'))
        items = await waitFor('Close the log', `${label}-log`)
        for (const name of ['Close the log', 'Share the log']) within(items, name, safe, label)
        screenshot(`${label}-log`)
        tap(find(items, 'Close the log'))
        items = await waitFor('Train', `${label}-tabs`)
        tap(find(items, 'Train'))
        items = await waitFor('Open the log', `${label}-training`)
        for (const name of ['Open the log', 'Songs', 'Train']) within(items, name, safe, label)
        screenshot(`${label}-training`)
      }
    }
    console.log(`edge-to-edge Android: PASS ${checks} checks; artifacts ${out}`)
  } finally {
    shell('am', 'force-stop', PKG)
    shell('settings', 'put', 'system', 'user_rotation', rotation)
    shell('settings', 'put', 'system', 'accelerometer_rotation', accelerometer)
    shell('wm', 'user-rotation', ...windowRotation)
    shell('wm', 'fixed-to-user-rotation', fixedRotation)
    if (previousOverlay) shell('cmd', 'overlay', 'enable-exclusive', '--category', previousOverlay)
  }
}
main().catch(error => { console.error(error.stack || error); console.error(`artifacts ${out}`); process.exitCode = 1 })
