/*
 * What shared code the PHONE bundles imports (see core.ts): the lookup and
 * the English training strings only. On the desktop, index.ts has already
 * registered every language, and registering English training again is a
 * no-op overwrite with the same strings.
 */
import { register } from './core'
import { training } from './en/training'

register('en', training)

export { t, tn } from './core'
