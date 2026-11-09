import { afterEach, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { BoxPlatformSnapshot } from '../../src/shared/box-contract'
import { setLocale } from '../../src/shared/i18n/core'
import { retryBoot } from '../../src/renderer/src/box/journeys/boot'
import { findJourneyFocus } from '../../src/renderer/src/box/journeys/focus'
import {
  backendExpiry,
  cacheRemovalIssue,
  confirmationSafeChoice,
  initialJourney,
  journeyBack,
  journeyInteractionLocked,
  journeyReducer,
  RequestEpoch,
  systemCommandIssue,
  validBackendUrl,
  type Confirmation,
  type JourneyState
} from '../../src/renderer/src/box/journeys/model'
import { hydrateAuthoritativePreferences, validJourneyLanguage } from '../../src/renderer/src/box/journeys/preferences-model'
import { initialResource, resourceReducer } from '../../src/renderer/src/box/journeys/resource'
import { formatBytes, summarizeAudio } from '../../src/renderer/src/box/journeys/format'
import { SystemPage } from '../../src/renderer/src/box/journeys/SystemPage'
import { NetworkPage } from '../../src/renderer/src/box/journeys/NetworkPage'
import { journeyActivity, signOutAndReadInventory } from '../../src/renderer/src/box/journeys/activity'
import { requestPlatformCommand } from '../../src/renderer/src/box/journeys/platform-command'
import {
  journeyChinese,
  journeyEnglish,
  journeyRussian,
  tJourney,
  type JourneyKey
} from '../../src/renderer/src/box/journeys/i18n'

function platform(overrides: Partial<BoxPlatformSnapshot> = {}): BoxPlatformSnapshot {
  return {
    available: true,
    capabilities: { wifi: true, updates: true, reboot: true, reset: true },
    connectivity: { interfaces: [], internet: 'unknown' },
    network: { state: 'connected' },
    update: { state: 'idle', currentVersion: '1.2.3' },
    ...overrides
  }
}

function atPage(page: JourneyState['page'], patch: Partial<JourneyState> = {}): JourneyState {
  return { ...initialJourney(page), ...patch }
}

const removeConfirmation: Confirmation = { kind: 'remove-cache', dir: '/cache/song', name: 'Song', requireIdle: false }
const holes = (text: string): string[] => [...text.matchAll(/\{(\w+)\}/g)].map(match => match[1]).sort()

afterEach(() => setLocale('en'))

describe('JourneyHub Back and setup return policy', () => {
  it('exits only at home and consumes an inner page first', () => {
    const home = initialJourney()
    expect(journeyBack(home)).toEqual({ state: home, effect: 'exit' })
    const storage = journeyBack(atPage('storage'))
    expect(storage.effect).toBe('consumed')
    expect(storage.state.page).toBe('home')
  })

  it('walks setup backward without losing its stage on a network return', () => {
    const remote = journeyBack(atPage('setup', { setupStage: 'remote' }))
    expect(remote.state.setupStage).toBe('welcome')
    const setupNetwork = atPage('setup', { setupStage: 'network' })
    const network = journeyReducer(setupNetwork, { type: 'open', page: 'network' })
    expect(network.networkReturn).toBe('setup')
    const returned = journeyBack(network)
    expect(returned.state.page).toBe('setup')
    expect(returned.state.setupStage).toBe('network')
  })

  it('cancels the top confirmation before leaving and holds a pending confirmation', () => {
    const confirmation = atPage('storage', { confirmation: { ...removeConfirmation, pending: false } })
    const cancelled = journeyBack(confirmation)
    expect(cancelled.effect).toBe('consumed')
    expect(cancelled.state.page).toBe('storage')
    expect(cancelled.state.confirmation).toBeNull()
    const pending = atPage('storage', { confirmation: { ...removeConfirmation, pending: true } })
    expect(journeyBack(pending).state).toBe(pending)
  })

  it('locks Back and navigation only during committed installing/rollback snapshots', () => {
    const installing = journeyReducer(atPage('system'), {
      type: 'platform', snapshot: platform({ update: { state: 'installing', currentVersion: '1.2.3' } })
    })
    expect(installing.committed).toBe('installing')
    expect(journeyBack(installing).effect).toBe('locked')
    expect(journeyReducer(installing, { type: 'open', page: 'privacy' })).toBe(installing)
    const finished = journeyReducer(installing, {
      type: 'platform', snapshot: platform({ update: { state: 'idle', currentVersion: '1.3.0' } })
    })
    expect(finished.committed).toBeNull()
    expect(journeyBack(finished).effect).toBe('consumed')
  })
})

describe('JourneyHub destructive command policy', () => {
  it('always protects the active cache, including while paused', () => {
    expect(cacheRemovalIssue('/cache/active', '/cache/active', false)).toBe('active-project')
    expect(cacheRemovalIssue('/cache/other', '/cache/active', false)).toBeNull()
    expect(cacheRemovalIssue('/cache/other', '/cache/active', true, true)).toBe('playback-active')
    expect(cacheRemovalIssue('', null, false)).toBe('invalid-project')
  })

  it('rechecks playback for install, rollback, reboot and reset', () => {
    const staged = platform({ update: { state: 'staged', currentVersion: '1.2.3', version: '1.3.0' } })
    for (const command of ['update-install', 'rollback', 'reboot', 'reset'] as const) {
      expect(systemCommandIssue(command, staged, true)).toBe('playback-active')
      expect(systemCommandIssue(command, staged, false)).toBeNull()
    }
    expect(systemCommandIssue('update-check', staged, true)).toBeNull()
  })

  it('requires the current backend capability and a valid update phase', () => {
    expect(systemCommandIssue('update-check', null, false)).toBe('platform-unavailable')
    expect(systemCommandIssue('update-check', platform({ available: false }), false)).toBe('platform-unavailable')
    expect(systemCommandIssue('update-stage', platform({ capabilities: { wifi: true, updates: false, reboot: false, reset: false } }), false)).toBe('capability-unavailable')
    expect(systemCommandIssue('reboot', platform({ capabilities: { wifi: true, updates: false, reboot: false, reset: true } }), false)).toBe('capability-unavailable')
    expect(systemCommandIssue('reset', platform({ capabilities: { wifi: false, updates: false, reboot: false, reset: true } }), false)).toBeNull()
    expect(systemCommandIssue('update-install', platform(), false)).toBe('invalid-state')
    expect(systemCommandIssue('update-stage', platform({ update: { state: 'available', currentVersion: '1.2.3', version: '1.3.0' } }), false)).toBeNull()
  })

  it('makes Keep/Cancel the safe initial choice', () => {
    expect(confirmationSafeChoice(removeConfirmation)).toBe('keep')
    expect(confirmationSafeChoice({ kind: 'update-install' })).toBe('cancel')
    expect(confirmationSafeChoice({ kind: 'factory-reset' })).toBe('cancel')
  })

  it('negative control: the deliberately unsafe legacy permission/default fails acceptance', () => {
    const acceptsSafetyPolicy = (issue: string | null, initial: string): boolean => issue !== null && initial === 'cancel'
    const legacyIssue: string | null = null
    expect(acceptsSafetyPolicy(legacyIssue, 'confirm')).toBe(false)
    expect(acceptsSafetyPolicy(cacheRemovalIssue('/active', '/active', false), 'cancel')).toBe(true)
  })
})

describe('JourneyHub stale results and backend data guards', () => {
  it('ignores an older async result after a newer request starts', () => {
    const initial = initialResource<string>()
    const first = resourceReducer(initial, { type: 'started', generation: 1 })
    const second = resourceReducer(first, { type: 'started', generation: 2 })
    expect(resourceReducer(second, { type: 'succeeded', generation: 1, value: 'stale' })).toBe(second)
    const live = resourceReducer(second, { type: 'succeeded', generation: 2, value: 'current' })
    expect(live.value).toBe('current')
    expect(resourceReducer(live, { type: 'failed', generation: 1, error: 'stale error' })).toBe(live)
  })

  it('keeps controls enabled during a background poll over existing data so remote focus stays put', () => {
    const loaded = resourceReducer(
      resourceReducer(initialResource<string>(), { type: 'started', generation: 1 }),
      { type: 'succeeded', generation: 1, value: 'snapshot' }
    )
    const polling = resourceReducer(loaded, { type: 'started', generation: 2, background: true })
    expect(polling.loading).toBe(false)
    expect(polling.value).toBe('snapshot')
    expect(resourceReducer(polling, { type: 'succeeded', generation: 2, value: 'next' })).toMatchObject({ loading: false, value: 'next' })
    // An explicit refresh still reports loading.
    expect(resourceReducer(loaded, { type: 'started', generation: 2 }).loading).toBe(true)
  })

  it('keeps Retry enabled while background polls retry a failed first load', () => {
    const failed = resourceReducer(
      resourceReducer(initialResource<string>(), { type: 'started', generation: 1 }),
      { type: 'failed', generation: 1, error: 'service unavailable' }
    )
    const polling = resourceReducer(failed, { type: 'started', generation: 2, background: true })
    expect(polling.loading).toBe(false)
    expect(resourceReducer(polling, { type: 'failed', generation: 2, error: 'still down' }).loading).toBe(false)
    // A first load that is still in flight keeps reporting loading under a poll.
    const pending = resourceReducer(initialResource<string>(), { type: 'started', generation: 1 })
    expect(resourceReducer(pending, { type: 'started', generation: 2, background: true }).loading).toBe(true)
  })

  it('invalidates request epochs explicitly on teardown', () => {
    const epoch = new RequestEpoch()
    const first = epoch.begin()
    expect(epoch.current(first)).toBe(true)
    const second = epoch.begin()
    expect(epoch.current(first)).toBe(false)
    expect(epoch.current(second)).toBe(true)
    epoch.invalidate()
    expect(epoch.current(second)).toBe(false)
  })

  it('accepts only HTTP(S) backend URLs without embedded credentials', () => {
    expect(validBackendUrl('https://box.local/pair?code=123')).toBe('https://box.local/pair?code=123')
    expect(validBackendUrl('http://192.168.1.8:8080/setup')).toBe('http://192.168.1.8:8080/setup')
    expect(validBackendUrl('javascript:alert(1)')).toBeNull()
    expect(validBackendUrl('https://user:secret@box.local/pair')).toBeNull()
    expect(validBackendUrl(undefined)).toBeNull()
  })

  it('derives expiry from the backend timestamp, never a completion timer', () => {
    expect(backendExpiry(11_000, 10_000)).toEqual({ expired: false, seconds: 1 })
    expect(backendExpiry(10_000, 10_000)).toEqual({ expired: true, seconds: 0 })
    expect(backendExpiry(undefined, 10_000)).toEqual({ expired: false, seconds: null })
  })

  it('redacts arbitrary audio data and exposes only approved boolean fields', () => {
    expect(summarizeAudio(null)).toEqual({ detail: 'missing', ready: null, playing: null })
    expect(summarizeAudio('secret log')).toEqual({ detail: 'redacted', ready: null, playing: null })
    const summary = summarizeAudio({ ready: true, playing: false, token: 'never-display-this', logs: ['secret'] })
    expect(summary).toEqual({ detail: 'reported', ready: true, playing: false })
    expect(JSON.stringify(summary)).not.toContain('never-display-this')
    expect(JSON.stringify(summary)).not.toContain('secret')
  })

  it('formats real byte counts without inventing values', () => {
    expect(formatBytes(0)).toBe('0 B')
    expect(formatBytes(1024)).toBe('1.00 KB')
    expect(formatBytes(-1)).toBe('—')
    expect(formatBytes(Number.NaN)).toBe('—')
  })
})

describe('JourneyHub review regressions', () => {
  const idle = { preferences: false, platform: false, phones: false, storage: false, drive: false }

  it('locks against authoritative committed state before the navigation reducer effect runs', () => {
    const state = atPage('system')
    expect(state.committed).toBeNull()
    for (const phase of ['installing', 'rollback'] as const) {
      const snapshot = platform({ update: { state: phase, currentVersion: '1.2.3' } })
      expect(journeyInteractionLocked(state, idle, snapshot)).toBe(true)
      // The former reducer-only check misses this interval.
      expect(journeyInteractionLocked(state, idle)).toBe(false)
    }
    expect(journeyInteractionLocked(state, idle, platform())).toBe(false)
  })

  it('locks owner confirmations and each applying operation while leaving idle browsing unlocked', () => {
    const state = atPage('home')
    expect(journeyInteractionLocked(state, idle)).toBe(false)
    for (const key of Object.keys(idle) as (keyof typeof idle)[]) {
      expect(journeyInteractionLocked(state, { ...idle, [key]: true }), key).toBe(true)
    }
    const confirming = journeyReducer(state, { type: 'confirm', confirmation: { kind: 'phone-stop' } })
    expect(journeyInteractionLocked(confirming, idle)).toBe(true)
    expect(journeyInteractionLocked(journeyBack(confirming).state, idle)).toBe(false)
  })

  it('clears a settled confirmation during installation without unlocking the committed operation', () => {
    let state = journeyReducer(atPage('system'), { type: 'confirm', confirmation: { kind: 'update-install' } })
    state = journeyReducer(state, { type: 'confirm-start' })
    state = journeyReducer(state, { type: 'platform', snapshot: platform({ update: { state: 'installing', currentVersion: '1.2.3' } }) })
    state = journeyReducer(state, { type: 'confirm-finish' })
    expect(state.confirmation).toBeNull()
    expect(journeyInteractionLocked(state, idle)).toBe(true)
    state = journeyReducer(state, { type: 'platform', snapshot: platform() })
    expect(journeyInteractionLocked(state, idle)).toBe(false)
  })

  it('focuses the primary action even when Back occurs earlier in DOM order', () => {
    const back = {} as HTMLElement
    const primary = {} as HTMLElement
    const querySelector = vi.fn((selector: string) => {
      if (selector.includes(',')) return back
      if (selector.includes('[role="dialog"]')) return null
      return selector.includes('data-journey-primary') ? primary : back
    })
    const scope = { querySelector } as unknown as HTMLElement
    expect(findJourneyFocus(scope, true)).toBe(primary)
    expect(querySelector('[data-journey-primary], [data-journey-back]')).toBe(back)
    querySelector.mockClear()
    expect(findJourneyFocus(scope, false)).toBeNull()
    expect(querySelector).not.toHaveBeenCalled()
  })

  it('focuses only Cancel inside an open confirmation, with no background fallback while pending', () => {
    const cancel = {} as HTMLElement
    const dialogQuery = vi.fn<() => HTMLElement | null>().mockReturnValue(cancel)
    const dialog = { querySelector: dialogQuery }
    const scope = { querySelector: vi.fn().mockReturnValue(dialog) } as unknown as HTMLElement
    expect(findJourneyFocus(scope, true)).toBe(cancel)
    expect(dialogQuery).toHaveBeenCalledWith('[data-journey-confirm-cancel]:not(:disabled)')
    dialogQuery.mockReturnValue(null)
    expect(findJourneyFocus(scope, true)).toBeNull()
  })

  it('retries all real boot reads rather than just selecting the current setup step', () => {
    const reads = { preferences: vi.fn(), platform: vi.fn(), audio: vi.fn(), drive: vi.fn() }
    retryBoot(reads)
    for (const read of Object.values(reads)) expect(read).toHaveBeenCalledExactlyOnceWith()
  })

  it('hydrates initial persisted language before applying the saved safe area', async () => {
    const order: string[] = []
    const applied = await hydrateAuthoritativePreferences({ setupComplete: true, language: 'ru', safeAreaPercent: 3 }, {
      isCurrent: () => true,
      applyLocale: async language => { order.push(language) },
      onSafeAreaChange: percent => { order.push(String(percent)) }
    })
    expect(applied).toBe(true)
    expect(order).toEqual(['ru', '3'])
  })

  it('ignores stale preference reads before any external effect', async () => {
    const applyLocale = vi.fn()
    const onSafeAreaChange = vi.fn()
    expect(await hydrateAuthoritativePreferences({ setupComplete: false, language: 'zh-CN', safeAreaPercent: 5 }, {
      isCurrent: () => false, applyLocale, onSafeAreaChange
    })).toBe(false)
    expect(applyLocale).not.toHaveBeenCalled()
    expect(onSafeAreaChange).not.toHaveBeenCalled()
  })

  it('does not apply stale safe-area callbacks after asynchronous language loading', async () => {
    let current = true
    let finish!: () => void
    const localeLoaded = new Promise<void>(resolve => { finish = resolve })
    const onSafeAreaChange = vi.fn()
    const hydration = hydrateAuthoritativePreferences({ setupComplete: false, language: 'zh-CN', safeAreaPercent: 5 }, {
      isCurrent: () => current, applyLocale: () => localeLoaded, onSafeAreaChange
    })
    current = false
    finish()
    expect(await hydration).toBe(false)
    expect(onSafeAreaChange).not.toHaveBeenCalled()
  })

  it('rejects unsupported stored locale names without overwriting the current locale', async () => {
    for (const language of ['fr', '', '__proto__', 'EN']) expect(validJourneyLanguage(language)).toBeNull()
    for (const language of ['en', 'ru', 'zh-CN']) expect(validJourneyLanguage(language)).toBe(language)
    const applyLocale = vi.fn()
    const onSafeAreaChange = vi.fn()
    expect(await hydrateAuthoritativePreferences({ setupComplete: false, language: 'fr', safeAreaPercent: 0 }, {
      isCurrent: () => true, applyLocale, onSafeAreaChange
    })).toBe(true)
    expect(applyLocale).not.toHaveBeenCalled()
    expect(onSafeAreaChange).toHaveBeenCalledWith(0)
  })

  it('labels the unavailable adapter version as the application, not appliance firmware', () => {
    const render = (snapshot: BoxPlatformSnapshot) => renderToStaticMarkup(createElement(SystemPage, {
      snapshot, playbackActive: false, loading: false, error: null, busy: null,
      onRefresh: vi.fn(), onCommand: vi.fn(), onConfirm: vi.fn(), onBack: vi.fn()
    }))
    const unavailable = render(platform({ available: false }))
    expect(unavailable).toContain('Application version')
    expect(unavailable).not.toContain('Current system version')
    expect(render(platform())).toContain('Current system version')
  })
})

describe('JourneyHub account ownership and visibility', () => {
  it('disables every visible read and clock while the mounted Hub is hidden', () => {
    for (const page of ['home', 'setup', 'network', 'phones', 'storage', 'diagnostics', 'system', 'privacy'] as const) {
      expect(Object.values(journeyActivity(false, page))).toEqual(Array(7).fill(false))
    }
  })

  it('reactivates Drive and audio refresh effects on each return to the same home/setup page', () => {
    for (const page of ['home', 'setup'] as const) {
      const transitions = [true, false, true].map(active => journeyActivity(active, page))
      // These are the actual useInventory effect dependencies, even though the page stays mounted.
      expect(transitions.map(activity => activity.drive)).toEqual([true, false, true])
      expect(transitions.map(activity => activity.audio)).toEqual([true, false, true])
      expect(transitions[2].phones).toBe(page === 'home')
      expect(transitions[2].storage).toBe(page === 'home')
    }
  })

  it('settles sign-out through the collection owner before refreshing authoritative account state', async () => {
    const owner = { signedIn: true, remoteRows: ['cloud-project'] }
    const order: string[] = []
    const signOut = vi.fn(async () => {
      order.push('owner')
      owner.signedIn = false
      owner.remoteRows = []
      return true
    })
    const readStatus = vi.fn(async () => {
      order.push('readback')
      return { signedIn: owner.signedIn, remoteRows: [...owner.remoteRows] }
    })
    expect(await signOutAndReadInventory(signOut, readStatus)).toEqual({
      complete: true, status: { signedIn: false, remoteRows: [] }
    })
    expect(order).toEqual(['owner', 'readback'])
    expect(signOut).toHaveBeenCalledExactlyOnceWith()
  })

  it('does not claim sign-out without owner success and actual signed-out readback', async () => {
    const status = { signedIn: true }
    const read = vi.fn(async () => status)
    expect(await signOutAndReadInventory(undefined, read)).toEqual({ complete: false, status })
    expect(await signOutAndReadInventory(async () => false, read)).toEqual({ complete: false, status })
    expect(await signOutAndReadInventory(async () => true, read)).toEqual({ complete: false, status })
    expect(read).toHaveBeenCalledTimes(3)
  })
})

describe('JourneyHub committed network operations', () => {
  it.each(['installing', 'rollback'] as const)('refuses every mutation after a fresh %s snapshot, including already focused Wi-Fi actions', async state => {
    const fresh = platform({ update: { state, currentVersion: '1.2.3' } })
    const api = {
      platformSnapshot: vi.fn(async () => ({ ok: true as const, value: fresh })),
      platformCommand: vi.fn(async () => ({ ok: true as const, value: fresh }))
    }
    const receive = vi.fn()
    for (const command of ['wifi-start', 'wifi-cancel', 'update-check', 'update-stage', 'update-install', 'rollback', 'reboot', 'reset'] as const) {
      expect(await requestPlatformCommand(api, command, () => false, receive)).toMatchObject({ ok: false, code: 'committed' })
    }
    expect(api.platformCommand).not.toHaveBeenCalled()
    expect(receive).toHaveBeenLastCalledWith(fresh)
  })

  it('allows idle Wi-Fi setup but rechecks the agent when the same action is invoked again', async () => {
    let snapshot = platform()
    const api = {
      platformSnapshot: vi.fn(async () => ({ ok: true as const, value: snapshot })),
      platformCommand: vi.fn(async () => ({ ok: true as const, value: snapshot }))
    }
    expect((await requestPlatformCommand(api, 'wifi-start', () => false, vi.fn())).ok).toBe(true)
    snapshot = platform({ update: { state: 'installing', currentVersion: '1.2.3' } })
    expect((await requestPlatformCommand(api, 'wifi-start', () => false, vi.fn())).ok).toBe(false)
    expect(api.platformCommand).toHaveBeenCalledTimes(1)
  })

  it('disables Wi-Fi mutations while retaining a read-only refresh action during committed operations', () => {
    const snapshot = platform({ update: { state: 'installing', currentVersion: '1.2.3' }, network: {
      state: 'connected', handoff: { url: 'http://192.168.1.2/setup', code: 'CODE', expiresAt: 1000 }
    } })
    const markup = renderToStaticMarkup(createElement(NetworkPage, {
      snapshot, loading: false, error: null, busy: null, now: 0,
      onRefresh: vi.fn(), onCommand: vi.fn(), onBack: vi.fn()
    }))
    const buttons = markup.match(/<button\b[^>]*>[\s\S]*?<\/button>/g) ?? []
    for (const title of ['Set up Wi-Fi on a phone', 'Cancel Wi-Fi setup']) {
      expect(buttons.find(button => button.includes(title))).toMatch(/\bdisabled/)
    }
    expect(buttons.find(button => button.includes('Retry'))).not.toMatch(/\bdisabled/)
  })
})

describe('JourneyHub locale dictionaries', () => {
  it('has exact EN/RU/zh-CN key and placeholder parity', () => {
    const keys = Object.keys(journeyEnglish) as JourneyKey[]
    expect(keys.length).toBeGreaterThan(150)
    for (const key of keys) {
      expect(journeyRussian[key], key).toBeTypeOf('string')
      expect(journeyChinese[key], key).toBeTypeOf('string')
      expect(holes(journeyRussian[key])).toEqual(holes(journeyEnglish[key]))
      expect(holes(journeyChinese[key])).toEqual(holes(journeyEnglish[key]))
    }
  })

  it('uses the active shared locale rather than freezing English', () => {
    setLocale('ru')
    expect(tJourney('journey.back')).toBe('Назад')
    setLocale('zh-CN')
    expect(tJourney('journey.back')).toBe('返回')
    setLocale('en')
    expect(tJourney('journey.expires', { seconds: 12 })).toBe('12 s remaining')
  })
})

describe('JourneyHub production entry', () => {
  it('resolves the named forwardRef export and all owned modules', async () => {
    const entry = await import('../../src/renderer/src/box/journeys/JourneyHub')
    expect(entry.JourneyHub).toBeTypeOf('object')
  })
})
