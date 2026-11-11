import { afterEach, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { RetainedPlayback } from '../../src/renderer/src/box/RetainedPlayback'
import { RetainedPlaybackController, type RetainedPlaybackState } from '../../src/renderer/src/box/retained-playback'
import { prepareBoxLocale, t } from '../../src/renderer/src/box/i18n'
import { retainedRecovery, retainedStatus } from '../shared/box-retained-native-fixture'
import { catalogFocusTarget, moveSpatialFocus } from '../../src/renderer/src/box/focus'

const capture = vi.hoisted(() => ({ state: {} as RetainedPlaybackState, stop: undefined as undefined | (() => void) }))
vi.mock('react', async original => ({
  ...await original<typeof import('react')>(),
  useSyncExternalStore: () => capture.state
}))
vi.mock('@singz/ui', async () => {
  const { createElement } = await import('react')
  return {
    Modal: ({ children }: { children: React.ReactNode }) => createElement('div', { role: 'dialog' }, children),
    ModalActions: ({ children }: { children: React.ReactNode }) => createElement('div', {}, children),
    Button: (props: Record<string, unknown>) => {
      if ('data-retained-stop' in props) capture.stop = props.onClick as () => void
      return createElement('button', props)
    }
  }
})

afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllGlobals(); await prepareBoxLocale('en') })
const state = (): RetainedPlaybackState => ({ epoch: 'e', generation: '7', playing: false, busy: false, restoring: false, error: '' })

describe('retained dialog copy and Stop handoff', () => {
  it.each(['en', 'ru', 'zh-CN'] as const)('shows localized recovery copy and logs the technical reason in %s', async locale => {
    await prepareBoxLocale(locale)
    const reason = 'Retained native playback is not a commandable opened transport; use explicit Stop.'
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const controller = new RetainedPlaybackController({ boxAudioPersistent: true, box: {
      retainedPlaybackSnapshot: async () => ({ ok: true, value: { epoch: 'e', playback: { generation: '7', state: 'running', transportState: 'stopped' }, recovery: retainedRecovery(retainedStatus('7', 'stopped')) } })
    } } as never, async () => { throw new Error(reason) })
    await controller.refresh()
    capture.state = controller.getSnapshot()
    expect(capture.state.error).toBe(t('box.retained.restoreFailed'))
    expect(capture.state.error).not.toContain('commandable')
    expect(warn).toHaveBeenCalledWith('Retained playback restore failed', expect.objectContaining({ message: reason }))
    vi.stubGlobal('window', { singz: {} })
    const html = renderToStaticMarkup(createElement(RetainedPlayback))
    expect(html).toContain(t('box.retained.restoreFailed'))
    expect(html).not.toContain(reason)
    expect(html).toContain('data-remote-horizontal="ordered"')
    controller.dispose()
  })

  it.each([true, false])('requests catalog focus only after confirmed Stop (confirmed=%s)', async confirmed => {
    capture.state = state()
    vi.stubGlobal('window', { singz: {} })
    const returned = vi.fn()
    vi.spyOn(RetainedPlaybackController.prototype, 'stop').mockImplementation(async function (this: RetainedPlaybackController) {
      vi.spyOn(this, 'getSnapshot').mockImplementation(() => capture.state)
      capture.state = confirmed ? { ...state(), generation: null } : { ...state(), error: 'Unconfirmed' }
    })
    renderToStaticMarkup(createElement(RetainedPlayback, { onStopped: returned }))
    capture.stop!()
    await Promise.resolve(); await Promise.resolve()
    expect(returned).toHaveBeenCalledTimes(confirmed ? 1 : 0)
  })
})

class Target {
  dataset: Record<string, string> = {}
  disabled = false
  constructor(readonly left: number, readonly top: number) {}
  matches(selector: string): boolean { return selector === ':disabled' && this.disabled }
  closest(): null { return null }
  getClientRects(): object[] { return [{}] }
  getBoundingClientRect() { return { left: this.left, top: this.top, width: 200, height: 60 } }
  focus(): void { focused = this }
  scrollIntoView(): void {}
}
let focused: Target | null = null

describe('retained dialog remote focus', () => {
  it('moves Right to Stop and Left to Refresh even when the actions wrap vertically', () => {
    const refresh = new Target(100, 100), stop = new Target(100, 180)
    vi.stubGlobal('HTMLElement', Target)
    vi.stubGlobal('document', { get activeElement() { return focused } })
    const scope = { dataset: { surface: 'retained-playback', remoteHorizontal: 'ordered' }, querySelectorAll: () => [refresh, stop] } as unknown as HTMLElement
    focused = refresh
    expect(moveSpatialFocus(scope, 'ArrowRight')).toBe(true)
    expect(focused).toBe(stop)
    expect(moveSpatialFocus(scope, 'ArrowLeft')).toBe(true)
    expect(focused).toBe(refresh)
    stop.disabled = true
    scope.querySelectorAll = (() => [refresh]) as never
    expect(moveSpatialFocus(scope, 'ArrowRight')).toBe(false)
    expect(focused).toBe(refresh)
  })

  it('returns to the catalog row, or its enabled primary action when no rows exist', () => {
    const row = new Target(0, 100), retry = new Target(0, 200), catalog = new Target(0, 0)
    let rows = [row]
    const root = { querySelectorAll: (selector: string) => selector.includes('data-catalog-index') ? rows : selector.includes('catalog-retry') ? [retry] : [catalog] } as unknown as HTMLElement
    expect(catalogFocusTarget(root, 0)).toBe(row)
    rows = []
    expect(catalogFocusTarget(root, 0)).toBe(retry)
    retry.disabled = true
    expect(catalogFocusTarget(root, 0)).toBe(catalog)
  })
})
