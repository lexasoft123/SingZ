# player-session — one singer's session, both backends, both phones

Every other suite in `mobile/tests/` asks whether one mechanism works.
This one asks the question the singer asks: **is the experimental native
graph, end to end, across an evening's worth of ordinary things, no worse
than the legacy RNAudioAPI path it replaces?**

It replays one compressed session against **both** playback backends on the
same device, minutes apart, then prints them side by side and applies one
rule. Nothing is compared across devices, across days or against a phone —
only legacy against native, on the rig in front of you.

```bash
node mobile/tests/player-session.cjs                     # every device that is up
node mobile/tests/player-session.cjs --platform ios
node mobile/tests/player-session.cjs --platform android
node mobile/tests/player-session.cjs --platform ios --backend native   # half a run, no verdict

SIM_UDID=… SIM_DEVICE_NAME=… METRO_PORT=8082 node mobile/tests/player-session.cjs --platform ios
ANDROID_SERIAL=… ANDROID_PKG=com.lexasoft.singz.debug node mobile/tests/player-session.cjs --platform android

# A REAL iPhone. Opt-in, never part of a bare run — see below.
IOS_DEVICE=<name|udid|identifier> node mobile/tests/player-session.cjs --platform ios-device
```

Exit code is 0 only when every rule passes. One run is roughly 6-8 minutes
per backend, so ~15 minutes for a platform.

```bash
node mobile/tests/player-session.cjs --platform android --wait-quiet   # block until the host is quiet
QUIET_LOAD=3 ALLOW_BUSY_HOST=1 node mobile/tests/player-session.cjs    # run anyway; the host-quiet rule fails
```

## Preconditions

**Both platforms**

- **The host must be quiet.** A simulator is a process on this Mac and an
  emulator is a VM on it, so the CPU and memory columns carry whatever else
  the Mac is doing. One afternoon of runs was thrown away for this: the
  1-minute load at 8-11 from the user's own apps, legacy's playing CPU
  reading 40% where the morning had read 29%, both backends' pitch-change
  CPU at 126%, and the table judging them anyway. The suite samples the
  1-minute load at start and **beside every CPU phase**: it refuses to start
  above `QUIET_LOAD` (default 4, a third of a twelve-core rig) when a
  simulator or emulator is in the run, `--wait-quiet` blocks until three
  consecutive 30 s samples are quiet (bounded by `QUIET_WAIT_MIN`, default
  45), and `ALLOW_BUSY_HOST=1` runs regardless — the load then prints in the
  CPU table with a `!` on every busy row, and the *host was quiet through
  every CPU/memory phase* rule fails, so a polluted run cannot pass as a
  result. A physical phone's numbers are its own; the rule and the refusal
  do not apply to it.
- Metro is running **from this worktree** and the app was built from it. A
  neighbour's Metro on 8081 will happily serve its bundle to your app —
  pass `METRO_PORT`.
- `ffmpeg`/`ffprobe` on PATH: the two songs are looped from the bundled
  sample (see *The songs* below). Cached in the OS temp dir; delete
  `$TMPDIR/singz-player-session` to force a rebuild.
- **Nothing may edit anything under `mobile/` while a run is in flight** —
  and that includes another session working in the same worktree, which is
  how it actually happened. Metro
  reloads the app's JS on any change there — the test files included — and
  a reload unmounts the player, unloads the song and re-runs the bundle in
  the *same process*. Every measurement after it belongs to a different
  session. This was seen twice while the suite was being written (once as a
  promise that never settled, once as a transport that "stopped" for no
  reason, each costing an hour), so every measurement window now carries a
  run id back out and a mismatch is a hard stop with that sentence in it.
- Runs are **silent**: the legacy engine's master bus and the backend's
  master gain are both zeroed, and the metronome — whose clicks bypass both
  — starts with its click off and has its volume turned to 0 by the
  scenario's first touch, before the touch that switches the click on.

**iOS**

- A booted simulator with the Debug app installed (`SIM_UDID`, or the first
  booted device).
- **The Mac's default output device must run at 48 kHz.** At 44.1 kHz the
  simulator's RemoteIO finalizes a callback size above the prepared bound
  and the native host refuses the handoff, so the "native" pass silently
  measures legacy. The suite probes CoreAudio's default output first and
  refuses to run with that sentence rather than producing a confusing red.

**Android**

- An emulator booted through `~/Dev/emu/run-patched-emulator.sh` with
  `-no-audio` — never the SDK's `emulator` binary, whose macOS CoreAudio
  backend garbles guest audio while the host's default output has more than
  two channels.
- **The AVD needs 6 GB, not the 2 GB an AVD is created with.** A six-lane
  two-minute song is ~141 MB decoded plus the native graph's own arena, on
  top of a dev bundle; at 2 GB the lowmemorykiller works through every app
  on the device and then kills SingZ mid-session — the driver sees the app
  simply vanish, with no crash report to explain it. `SingZ_API36` was raised
  to `hw.ramSize=6144` for this suite (2026-09-03).
- The installed APK must be **debuggable** and must be **this tree's build**:
  the suite hashes the local `app-debug.apk` against the installed one and
  refuses a mismatch (`ALLOW_STALE_APK=1` to override, deliberately).
- The Android bundle is pre-built with a plain HTTP request before the app
  is launched, because a Metro warm for iOS still builds Android from cold
  and the app gives up first — surfacing as "no debugger target" from a dev
  server answering `packager-status:running` perfectly.
- Songs are pushed into `…/files/SingZ projects` and, on an emulator,
  chowned back to the app (`android-lib.cjs`): a folder pushed there belongs
  to `shell`, external-storage FUSE will not hand it over, and `listProjects`
  skips it in a `continue` — no throw, no `listError`, the song simply is
  not there.

## The songs

Two projects, staged on the host from the bundled sample's six FLAC stems
looped with ffmpeg: **2:02** (3 loops) and **1:22** (2). A 40 s song
exercises none of the sizes that matter — a real six-lane song is minutes
long and both the native materialization and the legacy decode scale with
it.

The beat grid is **hand-made** (`source: 'manual'`), which is the one thing
the phone's re-detect will not overwrite, so the same project opens the same
way every run. The count-in starts at zero so "Play → advancing" measures a
transport rather than a metronome; the scenario's third metronome touch asks
for one bar and an unmeasured fourth touch puts it back.

Key and melody are not seeded, so the **first** open of a freshly seeded
project runs those detectors (seconds) and writes them into `project.json`;
every later open plans none. The suite waits for three consecutive idle
reads of the Song sheet before timing anything — one idle read lands in the
gap between an open and the detector it planned.

## The session

Open the long song → Play → three metronome touches (volume, click,
count-in bars) → wait for the music to come back → four seeks → three lane ramps (two faders and a mute) →
transpose +2 → training on, by time → pause → resume → background →
foreground → seek to five seconds from the end and let it run out → Play
again → back to the catalog → open the second song → back → **restart the
app** → open the first song again.

Every fine-grained timing is measured **inside the app**: an expression sets
up a `setInterval` sampler, runs the action, and resolves with the whole
trace. A host-side poll over CDP costs 5-20 ms a round trip and would put
its own latency inside every number.

## What each metric means

| metric | measured from → to |
| --- | --- |
| open → player screen | `openProject()` → `__test.screen === 'player'` |
| open → ready to play | … → the backend reports a duration |
| Play → position advancing | `backend.play()` → the transport has moved |
| Play → first audible | native: the app log's `first audible callback`. **Legacy has no such line** and the transport moving is the best it can say, so its column repeats "advancing" — the two columns are not the same measurement, and a legacy win here means nothing. **Not compared** — printed only |
| metronome touches → advancing again | after the three touches and the count-in restore, how long until the transport moves again. A metronome touch is a **cue rebuild** under the native graph, and the transport is not Running while it is in flight |
| seek → position reads target | worst of four seeks: from wanting to seek to the transport reading within \[t−0.5, t+1.5\]. The seek is issued the moment `capabilities.seek` goes true — the screen greys the scrub rail out while a structural graph swap owns the transport, so a driver that seeks through that window measures something no singer can do, and the wait is inside the number because it is inside the singer's second |
| lane ramp → applied | worst of three: `setVolume`/`setMuted` → `getTrackStates()` agrees |
| metronome save → accepted | worst of three: `__test.changeMet(…)` (the SCREEN's handler, the one that persists) → `__test.met` shows it. A save that throws is the field bug this exists for |
| pitch +2 → advancing again | the **longest stall** in the 16 s after the transpose: the silence the singer hears. **Not compared** — see below |
| training on → advancing again | the longest stall in the 12 s after arming |
| pause → stopped | `pause()` → `playing === false` |
| resume → advancing | `play()` → the transport has moved |
| foreground → Play advancing | after coming back from the background |
| end of song → Play restart | at the end: `seek(0); play()` → moving again near the top |
| back → catalog | `__test.back()` → the catalog is on screen |
| second song → player screen | a different song's open |
| app restart → app ready | from relaunch to the app's own boot mark: `CatalogScreen` writes `singz.boot` on mount and the driver polls it at 100 ms — Android through `run-as` on the pref store, iOS off the app container's plist (`plutil`; the simulator's cfprefsd denies the key exists). Nothing is evaluated over the inspector while the app boots: a 100 ms `typeof __test` poll there preceded a Fabric first-commit crash on the POCO, once. The previous host-side timing (Metro's target poll, 1 s) flipped this rule by 1.3 s on both backends across runs and could not resolve its own tolerance; the iPhone driver still uses it |
| reopen after restart | the first song again, on the restarted app |

Alongside the timings, three boolean families:

- **seek pull-back**: within 300 ms of first reading its target, the
  transport must never fall more than 50 ms below the high-water mark it
  reached. That is the "re-anchor echo" the field build shows — the UI
  lands, then jumps back to where the old graph thought it was.
- **the log**: zero `graph build refused`, zero `cue rebuild failed`, zero
  `durable save failed` across the whole session, and exactly **one**
  `preparing graph` per open under native (none at all under legacy).
- **lifecycle**: the app really went to the background (its `AppState`
  says so), pause holds the position, playback stops at the end of the
  song, and leaving the player logs `unloaded generation` under native.
- **nothing is torn down that should not be**: backgrounding no longer
  releases the graph (iOS keeps playing, Android pauses in place) and the
  end of a song parks it rather than unloading, so across either window
  there must be **zero** `graph released` and **zero** `preparing graph` —
  the Play that comes back is not allowed to cost a six-lane rebuild.

Log matching here is deliberately by **substring**, never by whole line: dsp
lines carry elapsed times and their tails change (`graph ready` gained
`· song N s · prepared in N ms`; a generation that never rendered now logs
`prepared graph discarded` rather than `rendering stopped`). A matcher pinned
to a whole line goes quietly false the day one of them is reworded.

## The rule

Every compared timing: **native ≤ legacy + max(50 ms, 10%)**.
CPU and PSS/RSS: **native ≤ legacy in every sampled phase** — except a phase
the two backends did not spend doing the same thing. Backgrounding is the
case that forced that clause: iOS native now keeps playing there by choice
while the legacy engine suspends, and "still rendering six lanes" against
"stopped" is two different jobs, not a regression. When the two disagree
about whether the transport was running, the backgrounded row is printed as
NOT compared, with each side's transport state named.

Two METRICS are exempt as well. The first is **first audible**, which is
printed and never gated: legacy times it from its own position clock and
native from the core's first audible callback, so the columns measure
different events and a legacy win means nothing.

The second is the **pitch change**. Under the native graph a
transpose is a full rebuild today and is expected to lose badly to legacy's
varispeed sources; a comparison nobody can pass teaches nothing. It is held
to an absolute ceiling (12 s) instead, and both numbers are printed side by
side, marked "not compared", so the gap stays visible rather than hiding
behind a PASS.

## CPU and memory

Sampled in five phases — idle in the player, playing, during the pitch
change, backgrounded, and after leaving the song.

- **iOS**: `top -l 2 -pid <pid> -stats pid,cpu,mem` (the second sample; the
  first is a since-boot average and is garbage) plus `ps -o rss=`. The pid
  is the one `simctl launch` printed — never `pgrep`, which with two
  simulators up returns two SingZPlayer processes and answers about the
  wrong one.
- **Android**: `utime+stime` from `/proc/<pid>/stat` across a 2 s wall
  window (5 s for the backgrounded phase, from one second into the hold —
  a 2 s window three seconds in compared two different seconds of a
  seven-second hold and flipped the rule by a point or two run after run
  while exact per-thread ticks showed both backends on the same threads at
  the same cost), and `TOTAL PSS` from `dumpsys meminfo`.

The CPU rule is `native ≤ legacy + 2 ticks`: two of the sampler's own
quanta over its window (1.0 point at 2 s and 0.4 at 5 s on Android, where a
tick is 10 ms; 0.2 on iOS, where `top` prints tenths). Two utime+stime
windows taken at different moments cannot resolve less than that, and a
rule that asks them to is decided by which second it lands on. It is
deliberately NOT wider: a residual outside two ticks is reported, and a
longer window makes it more visible, not less. A backgrounded row where the
two backends were doing different things (one still rendering, one not) is
printed "not compared" and counted as such in the summary — apart from
"never reached", which means a pass stopped early.
- **A physical iPhone**: nothing. The columns are **blank**, on purpose.
  There is no `top` and no `ps` for a process on the phone, and `devicectl
  device info processes` returns a pid and an executable path and nothing
  else — checked, not assumed. A number taken from this Mac would describe
  this Mac while looking exactly like a measurement of the phone, so the
  suite prints nothing rather than something false. Instruments is the tool
  that answers this; it is not driveable from a script this cheap.

> **These are HOST numbers.** A simulator runs arm64 code on a Mac with a
> laptop's memory system and no thermal or scheduler pressure of any kind;
> an emulator is a virtual machine. They are only ever a **legacy-vs-native
> comparison on one rig**, and must never be quoted as a phone's CPU or a
> phone's memory. If you want a phone number, measure a phone.

Every phase row also carries the host's 1-minute load at the moment each
side's sample was taken (`load@legacy`, `load@native`), with a `!` where it
was above `QUIET_LOAD` — see *Preconditions*. And the table's first line
names the **callback size** each backend ran with: native's is the
negotiated buffer read from its own `zcore AudioHost open · … · N frame
nominal buffer` log line after Play (960 frames on the Android emulator);
legacy's is react-native-audio-api's 128-frame render quantum — a constant,
labelled as one, because on Android its engine asks Oboe for exactly that
many frames per callback while on iOS the OS picks a callback size the app
never sees. It is the first number to want when one backend costs more CPU
than the other, and until this line nothing could answer it.

## Running against a real iPhone (`--platform ios-device`)

It is **opt-in and never part of a bare run**: it is somebody's own handset,
the run writes into its library, and adopting it because it happened to be
plugged in is exactly the surprise a test must not be. Two attached devices
is an error naming both, because picking for you is how a run measures the
wrong phone.

The app must be a **development or ad-hoc signed Debug build** — Metro serves
its bundle over the network (there is no `adb reverse` here), so the phone
has to reach this Mac on the Metro port, and the preflight says so rather
than letting an unreachable packager look like a cold one.

Three things a simulator never does, all handled, all learned the hard way:

- **The container is not a directory on this Mac.** Seeding is a `devicectl
  device copy to --domain-type appDataContainer` per project, and it is the
  slowest step of a device run by a distance. **`--remove-existing-content` is
  never passed, and `Documents` is never cleared** — on iOS that folder IS the
  phone library, the one a singer drops songs into over Finder, under the same
  bundle id as the app they use. The flag clears the destination's PARENT even
  when the destination names a single project (measured twice on a real
  iPhone; Apple's help text reads the other way and the device does not agree
  with it), so passing it destroys the previous song and the app reports the
  first one "never listed". Plain copies overwrite what they need to, and the
  host staging directory is rebuilt every run.
- **iOS suspends a backgrounded app that is not playing audio.** Its JS
  thread stops, so a CDP evaluate never returns and the driver hangs on the
  one step whose answer IS "it was suspended". Those reads are
  deadline-bounded and `AppState=suspended` counts as having gone to the
  background. This is also a real backend difference, not noise: native keeps
  rendering there by choice, legacy does not.
- **Suspending closes the inspector socket**, with no notice. Everything
  after it fails as "WebSocket is not open", which describes the driver and
  not the app. The device layer reattaches after foregrounding; the JS
  context survives the nap, so the hooks and the run id are still there.

## Background and foreground, as measured (2026-09-02)

There was no precedent for either in this repo, so both were measured on
iPhone 17 Pro / iOS 26.5 before being relied on:

- `xcrun simctl launch <udid> com.apple.Preferences` **does** background
  SingZ — its `AppState` goes `active` → `background` and its pid is
  unchanged.
- `xcrun simctl launch <udid> io.s-dev.singz` on an **already running** app
  foregrounds it **without restarting**: the same pid, printed back by
  `simctl`, and `AppState` returns to `active`.

So a `singz://` URL scheme is **not** needed for this suite. The pid is
asserted on both edges anyway; the day that stops being true the suite says
so instead of quietly measuring a fresh process.

On Android the pair is `input keyevent 3` and a LAUNCHER intent, and the
same pid assertion applies.

Note what backgrounding actually does to playback, because it is NOT the
same on both backends and that difference is the whole reason the
backgrounded phase is uncompared: `App.tsx` parks the native graph and
suspends the legacy engine on `background`. Legacy stops on both platforms.
Native pauses in place on Android and **keeps playing on iOS**, by choice —
`parkForBackground` only logs and returns there. That is the product's
behaviour, recorded rather than asserted.

## Files

- `player-session.cjs` — entry point: picks devices, runs both passes per
  device, prints the tables, exits non-zero on any failed rule.
- `player-session/scenario.cjs` — the session, the metric table, the rules
  and the printing. Backend- and platform-agnostic.
- `player-session/cdp.cjs` — Metro target selection (by `deviceName`,
  always) and the `__p<n>` promise-parking evaluator, because RN's Promise
  polyfill defeats the inspector's `awaitPromise`.
- `player-session/seed.cjs` — the two staged songs.
- `player-session/host-load.cjs` — the host-quiet rule: the 1-minute load,
  the threshold, and the bounded three-consecutive-samples wait. Pure, and
  unit-tested in `mobile/__tests__/player-session-host-load.test.ts`.
- `player-session/ios.cjs`, `player-session/android.cjs` — device plumbing.
  Each says whether it is `hostBound` (simulator, emulator) — the load rule
  applies only then.
- `player-session/ios-device.cjs` — the same for a PHYSICAL iPhone, over
  `devicectl` instead of `simctl`. Opt-in, blank CPU/memory columns, and the
  three device-only traps documented above.
