'use strict'
// Electron's format-2 JSON.stringify encoding, used to inspect the actual
// bytes published by every native writer. Preserve additive future fields.
const fs = require('node:fs')
const doc = JSON.parse(fs.readFileSync(0, 'utf8'))
const append = (known, original) => Object.assign(known,
  Object.fromEntries(Object.entries(original).filter(([key]) => !(key in known))))
const projects = doc.projects.slice().sort((a, b) => a.dir < b.dir ? -1 : a.dir > b.dir ? 1 : 0)
const rank = name => name === 'project.json' ? 0 : name === 'lyrics.json' ? 1 : name === 'graph.json' ? 3 : 2
const rows = projects.map(row => append({ dir: row.dir, files: row.files.slice()
  .sort((a, b) => rank(a.name) - rank(b.name))
  .map(file => append({ id: file.id, name: file.name, size: String(file.size), md5Checksum: file.md5Checksum }, file)) }, row))
process.stdout.write(JSON.stringify(append({ format: 2, capabilities: { ...doc.capabilities, adopt: 1 }, projects: rows }, doc)))
