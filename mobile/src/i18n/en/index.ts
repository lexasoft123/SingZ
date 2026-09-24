/*
 * The phone's English strings — the source every translation is typed
 * against (src/shared/i18n/types.ts). Keys are `phone.<area>.<name>`, so they
 * can never collide with the desktop's training strings registered beside them.
 */
import { app } from './app'
import { player } from './player'
import { library } from './library'
import { training } from './training'

export const en = { ...app, ...player, ...library, ...training }
