import { common } from './common'
import { app } from './app'
import { settings } from './settings'
import { training } from './training'
import { lyrics } from './lyrics'
import { player } from './player'
import { library } from './library'
import { main } from './main'
import type { voice } from './voice'
import type { box } from './box'

const base = { ...common, ...app, ...settings, ...training, ...lyrics, ...player, ...library, ...main }

// Box keys are typed here but registered by the Box/main consumers, keeping
// Desktop's eager English dictionary unchanged.
// Voice keys are typed here but registered by the lazy Voice strip chunk
// (components/voice-strings.ts), keeping the eager English dictionary under the
// renderer entry budget (scripts/check-renderer-split.mjs).
export const en = base as typeof base & typeof box & typeof voice
