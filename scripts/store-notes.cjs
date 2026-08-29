#!/usr/bin/env node
/**
 * Play Store and App Store changelogs, generated from the release notes.
 *
 * The GitHub release notes and the store changelog say the same thing at very
 * different lengths — one is a page, the other is 500 (Play) or 4000 (App
 * Store) characters per language. Written separately they drift, and the
 * drift is invisible until someone reads the store page in a language they
 * do not speak.
 *
 * So the release-notes file carries both. Anything between
 *
 *     <!-- store:ru-RU -->
 *     ...
 *     <!-- /store -->
 *
 * is the store text for that language; everything else is the long form that
 * becomes the GitHub Release body. This writes each block to the changelog
 * file Play expects (named by versionCode) and, for whichever locales
 * mobile/ios/fastlane/metadata already has a directory for, to that store's
 * unversioned release_notes.txt.
 *
 * It does NOT summarise. The old fallback truncated the long notes at 500
 * characters, which put half a sentence on the storefront — a store blurb is
 * a thing you write, not a thing you cut. Missing blocks are an error with the
 * name of the file to add them to.
 *
 *   node scripts/store-notes.cjs           write the changelogs
 *   node scripts/store-notes.cjs --check   verify only, write nothing (CI)
 */
const fs = require('fs')
const path = require('path')

const ROOT = path.resolve(__dirname, '..')
const META = path.join(ROOT, 'mobile/android/fastlane/metadata/android')
const IOS_META = path.join(ROOT, 'mobile/ios/fastlane/metadata')
// Play's cap is per language, counted in characters — Cyrillic costs the same
// as Latin, so count code points rather than bytes.
const LIMIT = 500
// App Store's "What's New" field is 4000 characters — the same block that
// fits Play's 500 always fits here too, so there is no second length to
// police, only a second destination to write it to.
const IOS_LIMIT = 4000
// Android's locale directories are not always Apple's — ru-RU vs ru is the
// live case (App Store Connect has no "ru-RU", only "ru"). Adding a locale
// on one side is a directory; this map is the one place a mismatch has to be
// spelled out by hand.
const IOS_LOCALE = { 'ru-RU': 'ru' }
const check = process.argv.includes('--check')

const fail = (msg) => {
  console.error(`store-notes: ${msg}`)
  process.exit(1)
}

const { version } = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
const m = /^(\d+)\.(\d+)\.(\d+)/.exec(version)
if (!m) fail(`package.json version "${version}" is not major.minor.patch`)
// The same fold gradle and the Fastfile apply: 0.14.6 -> 1406.
const code = Number(m[1]) * 10_000 + Number(m[2]) * 100 + Number(m[3])

const notesPath = path.join(ROOT, 'docs/release-notes', `v${version}.md`)
if (!fs.existsSync(notesPath)) {
  fail(
    `no docs/release-notes/v${version}.md.\n` +
      '  The release notes are written before tagging — the tag build reads that\n' +
      '  file to title the GitHub Release, and this reads it for the store text.'
  )
}
const notes = fs.readFileSync(notesPath, 'utf8')

// Languages are whatever the metadata tree already has, so adding one is a
// directory and a block, never a change here.
const locales = fs
  .readdirSync(META, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => d.name)
  .sort()

const blocks = new Map()
for (const [, locale, body] of notes.matchAll(
  /<!--\s*store:([\w-]+)\s*-->\n([\s\S]*?)\n<!--\s*\/store\s*-->/g
)) {
  blocks.set(locale, body.trim())
}

const unknown = [...blocks.keys()].filter((l) => !locales.includes(l))
if (unknown.length) {
  fail(
    `v${version}.md has store blocks for ${unknown.join(', ')}, which is not a\n` +
      `  language under ${path.relative(ROOT, META)}. A block Play never reads is a\n` +
      '  block nobody proofreads.'
  )
}

const problems = []
const wrote = []
for (const locale of locales) {
  const body = blocks.get(locale)
  if (!body) {
    problems.push(`${locale}: no <!-- store:${locale} --> block in v${version}.md`)
    continue
  }
  const len = [...body].length
  if (len > LIMIT) {
    problems.push(`${locale}: ${len} characters, ${len - LIMIT} over Play's ${LIMIT}`)
    continue
  }

  const target = path.join(META, locale, 'changelogs', `${code}.txt`)
  const current = fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : null
  const next = body + '\n'
  if (check) {
    if (current !== next) {
      problems.push(
        `${locale}: changelogs/${code}.txt is ${current === null ? 'missing' : 'stale'} ` +
          '— run `node scripts/store-notes.cjs`'
      )
      continue
    }
  } else if (current !== next) {
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, next)
  }
  wrote.push(`  ${locale.padEnd(6)} ${String(len).padStart(3)} / ${LIMIT}  changelogs/${code}.txt`)

  // App Store's release_notes.txt is unversioned — it names "what's new in
  // the version currently being submitted", not a per-build history the way
  // Play's changelog directory is, so this overwrites the same file every
  // release rather than adding a new one per code.
  const iosLocale = IOS_LOCALE[locale] || locale
  const iosDir = path.join(IOS_META, iosLocale)
  if (!fs.existsSync(iosDir)) continue // that locale has no iOS listing yet
  if (len > IOS_LIMIT) {
    problems.push(`${iosLocale} (iOS): ${len} characters, ${len - IOS_LIMIT} over App Store's ${IOS_LIMIT}`)
    continue
  }
  const iosTarget = path.join(iosDir, 'release_notes.txt')
  const iosCurrent = fs.existsSync(iosTarget) ? fs.readFileSync(iosTarget, 'utf8') : null
  if (check) {
    if (iosCurrent !== next) {
      problems.push(
        `${iosLocale} (iOS): release_notes.txt is ${iosCurrent === null ? 'missing' : 'stale'} ` +
          '— run `node scripts/store-notes.cjs`'
      )
      continue
    }
  } else if (iosCurrent !== next) {
    fs.writeFileSync(iosTarget, next)
  }
  wrote.push(`  ${iosLocale.padEnd(6)} ${String(len).padStart(3)} / ${IOS_LIMIT}  ios/…/${iosLocale}/release_notes.txt`)
}

if (problems.length) {
  fail(`v${version} store notes are not ready:\n  ${problems.join('\n  ')}`)
}
console.log(`${check ? 'checked' : 'wrote'} store notes for v${version} (versionCode ${code}):`)
console.log(wrote.join('\n'))
