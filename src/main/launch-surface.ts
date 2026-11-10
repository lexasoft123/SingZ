import type { ProductIdentity } from '../shared/product-identity'

export type RendererSurface = 'desktop' | 'box'

export function requestedRendererSurface(
  argv: readonly string[],
  env: { SINGZ_SURFACE?: string } = process.env,
  packagedProduct: ProductIdentity = 'desktop'
): RendererSurface {
  return packagedProduct === 'box' || argv.includes('--box') || env.SINGZ_SURFACE === 'box' ? 'box' : 'desktop'
}

export function developmentRendererUrl(base: string, surface: RendererSurface): string {
  if (surface === 'desktop') return base
  const url = new URL(base)
  url.pathname = `${url.pathname.replace(/\/$/, '')}/box.html`
  return url.toString()
}

export function desktopUpdaterEnabled(surface: RendererSurface): boolean {
  return surface === 'desktop'
}

export function boxKioskRequested(
  surface: RendererSurface,
  env: { developmentUrl?: string; hiddenTest?: boolean; windowed?: boolean } = {}
): boolean {
  return surface === 'box' && !env.developmentUrl && !env.hiddenTest && !env.windowed
}
