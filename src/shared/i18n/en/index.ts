import { common } from './common'
import { app } from './app'
import { settings } from './settings'
import { training } from './training'
import { lyrics } from './lyrics'
import { player } from './player'
import { library } from './library'
import { main } from './main'

export const en = { ...common, ...app, ...settings, ...training, ...lyrics, ...player, ...library, ...main }
