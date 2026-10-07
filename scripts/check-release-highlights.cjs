const fs = require('node:fs')
const path = require('node:path')
const root = path.resolve(__dirname, '..')
const data = JSON.parse(fs.readFileSync(path.join(root, 'src/shared/release-highlights.json'), 'utf8'))
const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version
const assert = (condition, message) => { if (!condition) throw new Error(`release-highlights: ${message}`) }
assert(data.version === version, 'content version must match package.json')
assert(Array.isArray(data.releases) && data.releases.length > 0, 'releases must be nonempty')
assert(data.releases.some(release => release.version === version), 'current version needs highlights')
const versions = new Set()
for (const release of data.releases) {
  assert(/^\d+\.\d+\.\d+$/.test(release.version) && !versions.has(release.version), 'release versions must be valid and unique')
  versions.add(release.version)
  assert(Array.isArray(release.highlights) && release.highlights.length > 0, 'release needs highlights')
  const ids = new Set()
  for (const item of release.highlights) {
    assert(typeof item.id === 'string' && item.id.length && !ids.has(item.id), 'highlight ids must be unique and nonempty')
    ids.add(item.id)
    assert(['news','export','mic','controls'].includes(item.icon), `unknown icon: ${item.icon}`)
    assert(Array.isArray(item.platforms) && item.platforms.length > 0 && new Set(item.platforms).size === item.platforms.length && item.platforms.every(p => ['desktop','ios','android'].includes(p)), `invalid platforms: ${item.id}`)
    for (const locale of ['en','ru','zh-CN']) {
      for (const field of ['title','description']) {
        const value = item.text?.[locale]?.[field]
        assert(typeof value === 'string' && value.trim().length > 0, `missing ${locale}.${field}: ${item.id}`)
        assert(value.length <= (field === 'title' ? 100 : 600), `copy too long: ${item.id}.${locale}.${field}`)
      }
    }
  }
}
console.log(`Release highlights valid for v${version}`)
