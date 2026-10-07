/** Startup diagnostics only; reporting never blocks or changes playback. */
export function reportTrainingTiming(line: string): void {
  if (typeof window === 'undefined') return
  window.singz?.reportTrainingTiming?.(line)
}
