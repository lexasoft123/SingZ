import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { app } from './electron-stub'

// The stubbed userData belongs to the RUN (tests/unit/global-setup.ts). Were
// global setup dropped from the config, or its variable not to reach the
// workers, the stub would quietly fall back to a directory per test file —
// still apart from other runs, but no longer the run's own. (The stub answers
// every getPath name with that one directory, userData included.)
describe('the unit-test userData', () => {
  it('is the directory global setup made for this run', () => {
    const dir = process.env.SINGZ_UNIT_USERDATA
    expect(dir, 'SINGZ_UNIT_USERDATA never reached this worker').toBeTruthy()
    expect(app.getPath()).toBe(dir)
  })

  it('is not the fixed name every run on the machine used to share', () => {
    expect(app.getPath()).not.toBe(join(tmpdir(), 'singz-unit-userdata'))
  })
})
