const fs = require('node:fs')
const path = require('node:path')

// CocoaPods needs real files inside each pod. Keep unchanged files in place:
// replacing identical headers makes Xcode rebuild every translation unit.
function copyFileIfChanged(source, destination, readOnly = true) {
  if (fs.existsSync(destination) && fs.readFileSync(source).equals(fs.readFileSync(destination))) return false
  fs.mkdirSync(path.dirname(destination), { recursive: true })
  if (fs.existsSync(destination)) fs.chmodSync(destination, 0o644)
  fs.copyFileSync(source, destination)
  if (readOnly) fs.chmodSync(destination, 0o444)
  return true
}

function pruneMirror(root, wanted) {
  if (!fs.existsSync(root)) return
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const file = path.join(root, entry.name)
    if (entry.isDirectory()) {
      pruneMirror(file, wanted)
      if (fs.readdirSync(file).length === 0) fs.rmdirSync(file)
    } else if (!wanted.has(file)) {
      fs.chmodSync(file, 0o644)
      fs.unlinkSync(file)
    }
  }
}

function createMirror(root) {
  const wanted = new Set()
  return {
    copy(source, destination) {
      wanted.add(destination)
      return copyFileIfChanged(source, destination)
    },
    finish() { pruneMirror(root, wanted) },
  }
}
module.exports = { copyFileIfChanged, createMirror }
