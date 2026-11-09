import { afterEach, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { BoxDiagnostics, BoxPlatformSnapshot } from '../../src/shared/box-contract'
import { setLocale } from '../../src/shared/i18n/core'
import { ConfirmationDialog } from '../../src/renderer/src/box/journeys/ConfirmationDialog'
import { DiagnosticsPage } from '../../src/renderer/src/box/journeys/DiagnosticsPage'
import { runJourneyConfirmation, type JourneyConfirmationServices } from '../../src/renderer/src/box/journeys/confirm'
import { acquireJourneyFocus } from '../../src/renderer/src/box/journeys/focus'
import { confirmationSafeChoice, wifiStartNeedsConfirmation, type Confirmation } from '../../src/renderer/src/box/journeys/model'
import { PageFrame } from '../../src/renderer/src/box/journeys/ui'

afterEach(() => setLocale('en'))

function platform(state: BoxPlatformSnapshot['network']['state']): BoxPlatformSnapshot {
  return {
    available: true,
    capabilities: { wifi: true, updates: true, reboot: true, reset: true },
    connectivity: { interfaces: [], internet: 'unknown' },
    network: { state },
    update: { state: 'idle', currentVersion: '1.2.3' }
  }
}

function services(reset: boolean) {
  const calls: string[] = []
  const value: JourneyConfirmationServices = {
    removeCache: vi.fn(async () => true),
    revokePhone: vi.fn(async () => true),
    revokeAllPhones: vi.fn(async () => true),
    signOut: vi.fn(async () => true),
    runPlatform: vi.fn(async command => { calls.push(command); return command === 'reset' ? reset : true }),
    refreshAfterReset: vi.fn(async () => { calls.push('refresh') }),
    onLibraryChanged: vi.fn(() => { calls.push('library') }),
    onAccountChanged: vi.fn(() => { calls.push('account') })
  }
  return { value, calls }
}

const dialog = (confirmation: Confirmation): string =>
  renderToStaticMarkup(createElement(ConfirmationDialog, { confirmation: { ...confirmation, pending: false }, onCancel: vi.fn(), onConfirm: vi.fn() }))

describe('Factory reset invalidates the collection owner', () => {
  it('tells the collection that downloads and Drive authorization changed after a successful reset', async () => {
    const { value, calls } = services(true)
    await runJourneyConfirmation({ kind: 'factory-reset' }, value)
    expect(calls).toEqual(['reset', 'library', 'account', 'refresh'])
  })

  it('leaves the collection alone when the reset was refused', async () => {
    const { value, calls } = services(false)
    await runJourneyConfirmation({ kind: 'factory-reset' }, value)
    expect(calls).toEqual(['reset'])
  })
})

describe('S18 disruptive Wi-Fi switch', () => {
  it('requires confirmation only while a network is connected', () => {
    expect(wifiStartNeedsConfirmation(platform('connected'))).toBe(true)
    for (const state of ['disconnected', 'connecting', 'error', 'unavailable'] as const) {
      expect(wifiStartNeedsConfirmation(platform(state))).toBe(false)
    }
    expect(wifiStartNeedsConfirmation(null)).toBe(false)
  })

  it('starts Wi-Fi setup only after confirmation, with Cancel as the first safe choice', async () => {
    const confirmation: Confirmation = { kind: 'wifi-switch' }
    expect(confirmationSafeChoice(confirmation)).toBe('cancel')
    const markup = dialog(confirmation)
    expect(markup).toContain('Switch Wi-Fi?')
    expect(markup.indexOf('Cancel')).toBeLessThan(markup.indexOf('Set up new Wi-Fi'))
    expect(markup).not.toContain('Cloud projects are never deleted')
    const { value, calls } = services(true)
    await runJourneyConfirmation(confirmation, value)
    expect(calls).toEqual(['wifi-start'])
  })
})

describe('Confirmation copy states scope', () => {
  it('names the space freed by removing a downloaded copy', () => {
    const markup = dialog({ kind: 'remove-cache', dir: '/cache/song', name: 'Song', bytes: 5 * 1024 * 1024, requireIdle: false })
    expect(markup).toContain('Frees 5.00 MB')
    setLocale('ru')
    expect(dialog({ kind: 'remove-cache', dir: '/cache/song', name: 'Song', bytes: 2048, requireIdle: false })).toContain('2.00 KB')
  })

  it('says what a factory reset erases in every Box language', () => {
    expect(dialog({ kind: 'factory-reset' })).toMatch(/preferences and all downloaded songs/)
    setLocale('ru')
    expect(dialog({ kind: 'factory-reset' })).toMatch(/настройки этого Box и все загруженные песни/)
    setLocale('zh-CN')
    expect(dialog({ kind: 'factory-reset' })).toMatch(/偏好设置和所有已下载歌曲/)
  })
})

describe('Journey chrome follows the Box locale', () => {
  it('localizes the footer remote keycaps', () => {
    setLocale('ru')
    const markup = renderToStaticMarkup(createElement(PageFrame, { title: 'T', subtitle: 'S', onBack: vi.fn(), children: null }))
    expect(markup).toContain('<span class="box-key">Назад</span>')
    expect(markup).not.toContain('>Back<')
  })

  it('formats the last CEC input time in the Box locale', () => {
    const at = Date.UTC(2026, 0, 1, 15, 4, 5)
    const diagnostics = {
      appVersion: '1', platform: 'linux', arch: 'arm64', audio: null,
      cec: { state: 'ready', lastInputAt: at }
    } as unknown as BoxDiagnostics
    setLocale('zh-CN')
    const markup = renderToStaticMarkup(createElement(DiagnosticsPage, {
      diagnostics, loading: false, error: null, onRefresh: vi.fn(), onAudio: vi.fn(), onSetup: vi.fn(), onBack: vi.fn()
    }))
    const expected = new Date(at).toLocaleTimeString('zh-CN')
    expect(expected).not.toBe(new Date(at).toLocaleTimeString())
    expect(markup).toContain(expected)
  })
})

describe('Focus returns to the confirmation opener', () => {
  function fixture(opts: { dialog?: boolean; openerUsable?: boolean } = {}) {
    const body = {} as HTMLElement
    const control = (usable = true) => ({
      focus: vi.fn(), scrollIntoView: vi.fn(), isConnected: usable,
      getClientRects: () => [{}], closest: () => null, matches: () => false
    }) as unknown as HTMLElement
    const primary = control()
    const cancel = control()
    const opener = control(opts.openerUsable !== false)
    const scope = {
      contains: (node: unknown) => node === opener || node === primary,
      querySelector: (selector: string) => {
        if (selector === '[role="dialog"]') return opts.dialog ? { querySelector: () => cancel } : null
        if (selector.includes('data-journey-primary')) return primary
        return null
      }
    } as unknown as HTMLElement
    return { body, primary, cancel, opener, scope }
  }

  it('focuses the Remove/Revoke control that opened the closed dialog instead of the page primary', () => {
    const f = fixture()
    expect(acquireJourneyFocus(f.scope, f.body, f.body, 2, 1, f.opener)).toBe(2)
    expect(f.opener.focus).toHaveBeenCalledWith({ preventScroll: true })
    expect(f.primary.focus).not.toHaveBeenCalled()
  })

  it('falls back to the page primary when the opener has disappeared', () => {
    const f = fixture({ openerUsable: false })
    acquireJourneyFocus(f.scope, f.body, f.body, 2, 1, f.opener)
    expect(f.opener.focus).not.toHaveBeenCalled()
    expect(f.primary.focus).toHaveBeenCalled()
  })

  it('keeps focus inside an open dialog on Cancel', () => {
    const f = fixture({ dialog: true })
    acquireJourneyFocus(f.scope, f.body, f.body, 2, 1, f.opener)
    expect(f.cancel.focus).toHaveBeenCalled()
    expect(f.opener.focus).not.toHaveBeenCalled()
  })
})
