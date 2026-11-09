import type { RendererSurface } from './launch-surface'

export function shouldDeferBoxApplicationQuit(surface: RendererSurface, cleanupFinished: boolean): boolean {
  return surface === 'box' && !cleanupFinished
}
