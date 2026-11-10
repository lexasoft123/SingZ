/** Availability is observable here; whether native scanned or reused a seed is not. */
export function waveformReadyMessage(
  source: 'project' | 'native',
  ready: number,
  total: number,
  elapsedMs?: number,
): string {
  const prefix = source === 'project' ? 'project envelope ready' : 'envelope ready'
  const elapsed = elapsedMs === undefined ? '' : ` · available after ${Math.max(0, Math.round(elapsedMs))} ms`
  return `${prefix} · ${ready}/${total} lanes${elapsed}`
}
