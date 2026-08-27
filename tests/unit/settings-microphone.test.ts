import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import SettingsModal, { inputChannelOptions } from '../../src/renderer/src/components/SettingsModal'

describe('settings microphone input strip', () => {
  it('only offers channel choices for a multichannel capture', () => {
    expect(inputChannelOptions(1)).toEqual([])
    expect(inputChannelOptions(2)).toEqual([0, 1])
    expect(inputChannelOptions(8)).toEqual([0, 1, 2, 3, 4, 5, 6, 7])
  })

  it('renders a clear mono state and an accessible live level meter initially', () => {
    const html = renderToStaticMarkup(createElement(SettingsModal, {
      audio: { inputChannel: 0 },
      onChangeOutput: vi.fn(),
      onChangeInput: vi.fn(),
      onMigrateNativeInput: vi.fn(),
      onChangeInputChannel: vi.fn(),
      outputStatus: null,
      micDevice: null,
      onClose: vi.fn()
    }))
    expect(html).toContain('Mono input · channel 1')
    expect(html).not.toContain('id="settings-input-channel"')
    expect(html).toContain('role="meter"')
    expect(html).toContain('aria-label="Selected microphone channel level"')
    expect(html).toContain('Starting microphone preview…')
  })
})
