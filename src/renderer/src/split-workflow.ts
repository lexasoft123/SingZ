import type { SeparationProgress } from '../../shared/types'

export type SplitMode = 'stems' | 'stems-and-vocals' | 'vocals'
export interface SplitProgress {
  label: string
  percent: number
  cancellable: boolean
}

const STEM_STAGE: Record<SeparationProgress['stage'], string> = {
  preparing: 'Warming up',
  'downloading-model': 'Downloading model',
  separating: 'Splitting stems',
  'loading-stems': 'Loading stems'
}

/** One bar for the whole request. Each stage reserves its final 2% for
 * loading, so inference reaching 100% never means the new lanes are ready. */
export function splitProgress(
  mode: SplitMode,
  phase: 'stems' | 'vocals',
  percent: number,
  stage: SeparationProgress['stage'] = 'separating'
): SplitProgress {
  const combined = mode === 'stems-and-vocals'
  const step = phase === 'stems' ? 1 : 2
  const fraction = stage === 'loading-stems' ? 99 : Math.min(100, Math.max(0, percent)) * 0.98
  const label = phase === 'stems' ? STEM_STAGE[stage]
    : stage === 'loading-stems' ? 'Loading vocals' : 'Separating vocals'
  return {
    label: combined ? `${step}/2 · ${label}` : label,
    percent: combined ? ((step - 1) * 100 + fraction) / 2 : fraction,
    cancellable: true
  }
}

export class SplitCancelled extends Error {}

/** Opaque decode/render promises cannot be stopped, but their results can
 * be disowned before any following stage or lane mutation starts. */
export async function checkedSplit<T>(current: () => boolean, operation: Promise<T>): Promise<T> {
  const value = await operation
  if (!current()) throw new SplitCancelled()
  return value
}

export async function runSplitPlan(
  mode: SplitMode,
  operations: {
    current: () => boolean
    stems: () => Promise<boolean>
    vocals: () => Promise<void>
  }
): Promise<void> {
  if (!operations.current()) return
  if (mode !== 'vocals' && (!(await operations.stems()) || !operations.current())) return
  if (mode !== 'stems' && operations.current()) await operations.vocals()
}
