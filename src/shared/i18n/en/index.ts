import { common } from './common'
import { app } from './app'
import { settings } from './settings'
import { training } from './training'
import { lyrics } from './lyrics'
import { player } from './player'
import { library } from './library'
import { main } from './main'
import type { box } from './box'
import type { nativeOffer } from './native-offer'

const base = { ...common, ...app, ...settings, ...training, ...lyrics, ...player, ...library, ...main }

// Box keys and the native-offer keys are typed here but registered by their
// own consumers (Box/main, the lazy offer chunk), keeping Desktop's eager
// English dictionary small.
export const en = base as typeof base & typeof box & typeof nativeOffer
