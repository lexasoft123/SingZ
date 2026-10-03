/** Browser device IDs are origin-scoped; native UIDs are not. Match only a
 * unique endpoint name, never guess between identically named outputs. */
export function nativeOutputForBrowserLabel<T extends { uid: string; label: string; outputChannels: number }>(
  label: string, devices: readonly T[]
): T {
  const normalize = (value: string): string => value.trim().replace(/\s+\((?:[0-9a-f]{4}:[0-9a-f]{4}|Built-in|Virtual|Aggregate|Bluetooth)\)$/i, '').trim()
  const outputs = devices.filter(device => device.outputChannels > 0)
  const exact = outputs.filter(device => device.label === label)
  const matches = exact.length ? exact : outputs.filter(device => normalize(device.label) === normalize(label))
  if (!label || matches.length !== 1) throw new Error('The selected output could not be identified uniquely by the native audio provider.')
  return matches[0]
}
