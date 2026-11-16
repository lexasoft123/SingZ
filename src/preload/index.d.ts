import type { SingzApi } from '../shared/types'
import type { VoiceTakeApi } from './index'

declare global {
  interface Window {
    singz: SingzApi & { voiceTakes: VoiceTakeApi }
  }
}

export {}
