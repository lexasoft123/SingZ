import { common } from './common'
import { app } from './app'
import { settings } from './settings'
import { training } from './training'
import { lyrics } from './lyrics'
import { player } from './player'
import { library } from './library'
import { main } from './main'
import { voice } from './voice'
import type { box } from './box'

const base = { ...common, ...app, ...settings, ...training, ...lyrics, ...player, ...library, ...main, ...voice }

// Box keys are typed here but registered by the Box/main consumers, keeping
// Desktop's eager English dictionary unchanged.
export const en = base as typeof base & typeof box
