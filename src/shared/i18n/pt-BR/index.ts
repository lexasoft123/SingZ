import { app } from './app'
import { common } from './common'
import { library } from './library'
import { lyrics } from './lyrics'
import { main } from './main'
import { player } from './player'
import { settings } from './settings'
import { training } from './training'

export const ptBR = { ...app, ...common, ...library, ...lyrics, ...main, ...player, ...settings, ...training }
