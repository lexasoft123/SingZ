import { describe, expect, it, vi } from 'vitest'

const { showCaptureWindow } = require('../e2e/mac/capture-visibility.cjs') as {
  showCaptureWindow(app: object, quiet: (app: object) => Promise<void>): Promise<void>
}

describe('visible Settings capture driver', () => {
  it('binds the non-activating native show before quiet launch replaces it', async () => {
    const calls: string[] = []
    const window = { visible: false, showInactive() { this.visible = true; calls.push('showInactive') } }
    const dispose = vi.fn(async () => {})
    const app = { evaluateHandle: async (fn: (electron: object) => () => void) => {
      const show = fn({ BrowserWindow: { getAllWindows: () => [window] } })
      return { evaluate: async (run: (show: () => void) => void) => run(show), dispose }
    } }
    await showCaptureWindow(app, async () => {
      calls.push('quietLaunch')
      window.visible = false
      window.showInactive = () => {}
    })
    expect(calls).toEqual(['quietLaunch', 'showInactive'])
    expect(window.visible).toBe(true)
    expect(dispose).toHaveBeenCalledOnce()
  })
})
