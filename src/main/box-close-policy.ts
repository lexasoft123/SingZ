import type { RendererSurface } from './launch-surface'

export function shouldDeferBoxApplicationQuit(surface: RendererSurface, cleanupFinished: boolean): boolean {
  return surface === 'box' && !cleanupFinished
}

export function shouldResumeBoxApplicationQuit(
  applicationQuitRequested: boolean,
  completedWindows: number,
  requiredWindows: number
): boolean {
  return applicationQuitRequested && completedWindows >= requiredWindows
}
