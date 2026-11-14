import { afterEach, describe, expect, it, vi } from 'vitest'

const { selectNativeOutputBeforeOpen } = require('../e2e/mac/native-output.cjs') as {
  selectNativeOutputBeforeOpen(page: object, uid: string): Promise<{ uid: string }>
}

afterEach(() => vi.unstubAllGlobals())

describe('native output driver setup', () => {
  const uid = 'AppleUSBAudioEngine:Antelope Audio:Zen Quadro SC:4912524000285:1,2'
  it('restores the exact opaque UID through the product preference before song open', async () => {
    let saved = JSON.stringify({ outputId: 'legacy-browser', inputChannel: 4 })
    vi.stubGlobal('localStorage', { getItem: () => saved, setItem: (_key: string, value: string) => { saved = value } })
    const page = { evaluate: vi.fn<(...args: unknown[]) => Promise<unknown>>(), reload: vi.fn(async () => {}), waitForFunction: vi.fn(async () => {}) }
    page.evaluate.mockResolvedValueOnce({ ok: true, devices: [{ uid, outputChannels: 16 }] })
      .mockImplementationOnce(async (fn, value) => (fn as (uid: string) => void)(value as string))
    expect(await selectNativeOutputBeforeOpen(page, uid)).toEqual({ uid, outputChannels: 16 })
    expect(JSON.parse(saved)).toEqual({ nativeOutputUid: uid, inputChannel: 4 })
    expect(page.reload).toHaveBeenCalledOnce()
    expect(page.waitForFunction).toHaveBeenCalledWith(expect.any(Function), uid, { timeout: 20000 })
  })

  it.each([`native:${uid}`, 'missing-output'])('rejects an unsupported or unknown UID immediately: %s', async requested => {
    const page = { evaluate: vi.fn(async () => ({ ok: true, devices: [{ uid, outputChannels: 16 }] })), reload: vi.fn() }
    await expect(selectNativeOutputBeforeOpen(page, requested)).rejects.toThrow('exact audioHostDevices UID')
    expect(page.reload).not.toHaveBeenCalled()
  })
})
