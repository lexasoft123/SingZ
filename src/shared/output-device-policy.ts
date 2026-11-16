/** Chromium and Core Audio/WASAPI name one endpoint differently ("NoMachine Audio Adapter (Virtual)" vs
 * "NoMachine Audio Adapter", "Default - X", "Zen Quadro SC Playback (23e5:a2f9)"): compare on the interface name
 * alone — case, spacing, a leading "Default - " and trailing "(...)" decorations are ignored. Callers must still
 * require ONE match on each side; there is no prefix or substring fallback. */
export function outputLabelKey(label: string): string {
  let key = label.trim().toLocaleLowerCase().replace(/^(?:default|communications)\s*-\s*/, '')
  for (let previous = ''; previous !== key;) {
    previous = key
    key = key.replace(/\s*\([^()]*\)\s*$/, '')
  }
  return key.replace(/\s+/g, ' ').trim()
}

/** Browser device IDs are origin-scoped; native UIDs are not. Match only a
 * unique endpoint name, never guess between identically named outputs. */
export function nativeOutputForBrowserLabel<T extends { uid: string; label: string; outputChannels: number }>(
  label: string, devices: readonly T[]
): T {
  const outputs = devices.filter(device => device.outputChannels > 0)
  const exact = outputs.filter(device => device.label === label)
  const matches = exact.length ? exact : outputs.filter(device => outputLabelKey(device.label) === outputLabelKey(label))
  if (!outputLabelKey(label) || matches.length !== 1) throw new Error('The selected output could not be identified uniquely by the native audio provider.')
  return matches[0]
}
