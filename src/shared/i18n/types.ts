/**
 * What a translation of one English namespace must hold: every key, and —
 * for the `_one`/`_other` plurals — optionally the `_few`/`_many` forms its
 * language needs (Russian). Anything else is a compile error.
 */
type Stem<T> = { [K in keyof T]: K extends `${infer B}_one` ? B : never }[keyof T]
export type Translation<T> = Record<keyof T, string> &
  Partial<Record<`${Stem<T>}_few` | `${Stem<T>}_many`, string>>
