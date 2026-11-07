export type ProductIdentity = 'desktop' | 'box'

export interface ProductIdentitySpec {
  appId: string
  name: string
  profileDir: string
  executable: string
  desktopName: string
}

export const PRODUCT_IDENTITIES: Readonly<Record<ProductIdentity, ProductIdentitySpec>> = {
  desktop: {
    appId: 'com.lexasoft.singz',
    name: 'SingZ',
    profileDir: 'SingZ',
    executable: 'singz',
    desktopName: 'singz.desktop'
  },
  box: {
    appId: 'com.lexasoft.singz.box',
    name: 'SingZ Box',
    profileDir: 'SingZ Box',
    executable: 'singz-box',
    desktopName: 'singz-box.desktop'
  }
}

export function productIdentityFromPackage(metadata: unknown): ProductIdentity {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return 'desktop'
  return (metadata as { singzProduct?: unknown }).singzProduct === 'box' ? 'box' : 'desktop'
}

export function productIdentityFromSurface(surface: string | undefined): ProductIdentity {
  return surface === 'box' ? 'box' : 'desktop'
}

export function productProfileDir(surface: string | undefined): string {
  return PRODUCT_IDENTITIES[productIdentityFromSurface(surface)].profileDir
}
