import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { Settings } from '../../src/renderer/src/box/Settings'
import { prepareBoxLocale } from '../../src/renderer/src/box/i18n'
const noop = vi.fn()
function render(mode: 'song' | 'off' | null, busy = false, error: string | null = null) {
  return renderToStaticMarkup(createElement(Settings, { inventory: null, loading: false, error: null,
    currentOutputUid: null, playbackActive: false, onRefresh: noop, onApplyOutput: async () => {}, onBack: noop,
    metronomeOverride: mode, metronomeBusy: busy, metronomeError: error, onMetronomeOverride: async () => {} }))
}
function radio(html: string, mode: string): string {
  const tag = html.match(new RegExp(`<button(?=[^>]*data-metronome-override="${mode}")[^>]*>`))?.[0]
  if (!tag) throw new Error('Missing metronome control')
  return tag
}
beforeEach(async () => { await prepareBoxLocale('en') })
describe('Box global metronome settings', () => {
  it('shows only acknowledged mode, including a failed save staying Off', () => {
    const html = render('off', false, 'Preference not saved')
    expect(radio(html, 'off')).toContain('aria-checked="true"')
    expect(radio(html, 'song')).toContain('aria-checked="false"')
    expect(html).toContain('Preference not saved')
    expect(html).toContain('Changing this setting pauses playback')
  })
  it('claims neither mode before native confirmation and disables edits while applying', () => {
    const html = render(null, true)
    for (const mode of ['off', 'song']) {
      expect(radio(html, mode)).toContain('aria-checked="false"')
      expect(radio(html, mode)).toContain('disabled')
    }
    expect(html.match(/<button(?=[^>]*data-settings-back)[^>]*>/)?.[0]).toContain('disabled')
  })
  it('localizes the global preference in Russian and Chinese', async () => {
    await prepareBoxLocale('ru'); expect(render('song')).toContain('Всегда выключен')
    await prepareBoxLocale('zh-CN'); expect(render('off')).toContain('始终关闭')
  })
})
