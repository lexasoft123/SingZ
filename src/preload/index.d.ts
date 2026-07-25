import type { SingzApi } from '../shared/types'

declare global {
  interface Window {
    singz: SingzApi
  }
}

export {}
