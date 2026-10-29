import { app } from './app'
import { library } from './library'
import { player } from './player'
import { training } from './training'

export const es419 = { ...app, ...library, ...player, ...training }
