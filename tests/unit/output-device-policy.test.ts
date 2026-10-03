import { describe, expect, it } from 'vitest'
import { nativeOutputForBrowserLabel } from '../../src/shared/output-device-policy'
const device = (uid: string, label: string, outputChannels = 2) => ({ uid, label, outputChannels })
describe('shared native output selection', () => {
  it.each(['Speakers (Realtek High Definition Audio)', 'USB Audio', 'MacBook Pro Speakers'])('matches native endpoint %s', label => {
    expect(nativeOutputForBrowserLabel(label, [device('one', label)])).toMatchObject({ uid: 'one' })
  })
  it.each(['MacBook Pro Speakers (Built-in)', 'MacBook Pro Speakers (123a:456b)', 'MacBook Pro Speakers (Aggregate)', 'MacBook Pro Speakers (Bluetooth)'])('recognizes Chromium suffix in %s', label => {
    expect(nativeOutputForBrowserLabel(label, [device('one', 'MacBook Pro Speakers')]).uid).toBe('one')
  })
  it('never routes to a random duplicate or an input-only device', () => {
    expect(() => nativeOutputForBrowserLabel('USB', [device('a', 'USB'), device('b', 'USB')])).toThrow('uniquely')
    expect(() => nativeOutputForBrowserLabel('USB', [device('input', 'USB', 0)])).toThrow('uniquely')
    expect(() => nativeOutputForBrowserLabel('', [device('one', '')])).toThrow('uniquely')
  })
})
