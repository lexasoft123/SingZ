import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const { shouldDeferRuntimeSmoke } = require('../../scripts/dist.cjs') as {
  shouldDeferRuntimeSmoke(env: NodeJS.ProcessEnv, targets: string[], hostTarget: string): boolean
}

// The Linux CI build stage assembles packages inside a container that cannot
// open a desktop, so the capture-addon dlopen smoke defers to the
// installed-test stage. Both Linux architectures must defer there — the arm64
// leg added with the Orange Pi 5 port is the regression this pins: a Linux
// container stage that tried to smoke the addon in-build would fail every
// ARM64 run at the gate, and one that skipped deferral logic for arm64 would
// silently lose the check.
describe('shouldDeferRuntimeSmoke', () => {
  it('defers both Linux architectures during the CI build stage', () => {
    const env = { SINGZ_CI_STAGE: 'build' }
    expect(shouldDeferRuntimeSmoke(env, ['linux-x64'], 'linux-x64')).toBe(true)
    expect(shouldDeferRuntimeSmoke(env, ['linux-arm64'], 'linux-arm64')).toBe(true)
  })

  it('never defers the installed-test stage or an ordinary local build', () => {
    expect(shouldDeferRuntimeSmoke({ SINGZ_CI_STAGE: 'installed-test' }, ['linux-arm64'], 'linux-arm64')).toBe(false)
    expect(shouldDeferRuntimeSmoke({}, ['linux-arm64'], 'linux-arm64')).toBe(false)
  })

  it('never defers a non-Linux host or a multi-target build', () => {
    const env = { SINGZ_CI_STAGE: 'build' }
    expect(shouldDeferRuntimeSmoke(env, ['linux-x64'], 'darwin-arm64')).toBe(false)
    expect(shouldDeferRuntimeSmoke(env, ['darwin-arm64', 'darwin-x64'], 'darwin-arm64')).toBe(false)
    expect(shouldDeferRuntimeSmoke(env, ['linux-x64', 'linux-arm64'], 'linux-x64')).toBe(false)
    expect(shouldDeferRuntimeSmoke(env, ['win32-x64'], 'linux-x64')).toBe(false)
  })
})
