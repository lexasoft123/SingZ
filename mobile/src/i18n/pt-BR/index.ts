import { app } from './app'
import { library } from './library'
import { player } from './player'
import { training } from './training'

export const ptBR = { ...app, ...library, ...player, ...training }
