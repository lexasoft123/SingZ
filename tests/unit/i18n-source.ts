/*
 * For the suites that read a component's SOURCE rather than rendering it:
 * since localization the words live in the dictionaries, and the source says
 * `t('player.split.resplitStems')`. This writes each call's English right after
 * it, in place — `t('player.split.resplitStems' /* Re-split instrument stems *\/`
 * — so a check that the words are there, or a regex over the order of code and
 * copy, still reads the source the way it did before.
 */
import { readFileSync } from 'node:fs'
import { en } from '../../src/shared/i18n/en'

const dict = en as Record<string, string>

export function withEnglish(source: string): string {
  return source.replace(/\b(tn?)\(\s*(['"])([\w.-]+)\2/g, (call, _fn, _q, key: string) => {
    const text = dict[key] ?? dict[`${key}_other`]
    return text === undefined ? call : `${call} /* ${text} */`
  })
}

export function readSourceWithEnglish(path: string | URL): string {
  return withEnglish(readFileSync(path, 'utf8'))
}
