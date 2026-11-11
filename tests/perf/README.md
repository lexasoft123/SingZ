# Performance harness (in progress)

The common runner can communicate with the Electron and GPUI ui-test drivers
through a fresh `--control-dir`. It sends one action at a time and requires a
matching JSON completion receipt. `stage_fixture.cjs` copies the bundled sample
into a fresh, isolated two-project library; it prints paths and source details.
All automated launches must be muted and hidden.

Both real apps have been exercised in a shortened hidden Mac smoke run. Windows
sampling and DWM accounting have unit coverage but still require a real Windows
run. Catalog navigation retains a project until another open in both apps; this
is recorded as an unavailable close/unload in the cycle receipt.
The current native helper does not expose `starvedBlocks`; unavailable lane
values are null with a reason. The presented-frame slots (`fps`,
`frameTimeMs`, `dropped`) are deliberately null until C-07 adds frame capture.
The bundled sample lasts 40.8 seconds and has
six stems and lyrics, but does not have a stored pitch line. It is a smoke
fixture, not the five-minute baseline song.
Do not promote a smoke run to a Q-01/Q-02 baseline.

Run local checks with:

```
python3.13 -m unittest discover -s tests/perf -p 'test_*.py'
node --check tests/perf/electron_driver.cjs
```

For baseline runs, generate the reference library with
`node tests/perf/make_reference.cjs <fresh-dir>`: two synthesized six-stem
projects (300 s and 720 s) with timed lyrics, a pitch line, and analysis stamps
read from the current zCore detector versions, so no run re-analyses. Its JSON
has the same shape as `stage_fixture.cjs`. `python3 -m unittest
tests/perf/test_reference_fixture.py` checks it (needs `ffprobe`).

Stage a fresh library with `node tests/perf/stage_fixture.cjs <fresh-dir>`;
the JSON it prints contains the two project paths, their names, and the sample
description. Point `--reference-json` at a file containing that JSON. Each run
also needs a fresh `--control-dir`, an actual installer or archive in
`--package`, and the four identity fields `--profile`, `--display hidden`,
`--machine`, and `--commit`.

For Electron, set `SINGZ_USERDATA_DIR` to the staged `prefs` directory and
`SINGZ_PERF_SONGS` to the JSON array of staged project names; run the common
runner with `--app electron --command 'node tests/perf/electron_driver.cjs'`.
For native, set `SINGZ_GPUI_CONFIG_DIR`, `SINGZ_GPUI_PROJECTS_ROOT`,
`SINGZ_GPUI_TEST_PROJECT`, and `SINGZ_GPUI_PERF_SECOND_PROJECT` to isolated
staged paths, and point `--command` at the release `ui-tests` executable and
`SINGZ_GPUI_AUDIO_HELPER` and `SINGZ_GPUI_ANALYZER` at the matching native helpers. Use
`--profile release+ui-tests`. Both apps use `--play`, `--burst`, `--pause`,
`--cycles`, and `--cycle-duration` to configure the scenario. `--run-kind
smoke` marks development smoke results with the coordinator's requested owner
and non-baseline reservation note.
