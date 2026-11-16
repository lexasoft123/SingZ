import { describe, expect, it } from 'vitest'
import { nativeOutputForBrowserLabel, outputLabelKey } from '../../src/shared/output-device-policy'
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

describe('outputLabelKey', () => {
  it.each([
    ['NoMachine Audio Adapter (Virtual)', 'nomachine audio adapter'],
    ['Zen Quadro SC Playback (23e5:a2f9)', 'zen quadro sc playback'],
    ['MacBook Pro Speakers (Built-in)', 'macbook pro speakers'],
    ['Default - MacBook  Pro Speakers', 'macbook pro speakers'],
    ['Speakers (Realtek High Definition Audio)', 'speakers']
  ])('%s', (label, key) => expect(outputLabelKey(label)).toBe(key))
  it('does not prefix-match and leaves undecorated names alone', () => {
    expect(outputLabelKey('USB Audio')).not.toBe(outputLabelKey('USB Audio CODEC'))
    expect(outputLabelKey('USB Audio')).toBe('usb audio')
  })
  it('matches decorated browser labels to bare native names, but not an ambiguous pair', () => {
    expect(nativeOutputForBrowserLabel('Zen Quadro SC Playback (23e5:a2f9)', [device('z', 'Zen Quadro SC Playback')]).uid).toBe('z')
    expect(() => nativeOutputForBrowserLabel('X', [device('a', 'X (Built-in)'), device('b', 'X (Virtual)')])).toThrow('uniquely')
  })
})
