/*
 * Writes src/gdrive-config.ts (gitignored, never in the repo) from
 * mobile/gdrive.config.json (gitignored; CI writes it from a repo secret).
 * Metro resolves modules statically, so the config must be a module that
 * always exists — a require() of an optional json file breaks the bundle;
 * that is why this always writes, EMPTY when no json (Drive chip hides).
 */
const fs = require('fs');
const path = require('path');

const src = path.join(__dirname, '..', 'gdrive.config.json');
const dst = path.join(__dirname, '..', 'src', 'gdrive-config.ts');
let raw = {};
if (fs.existsSync(src)) {
  try {
    raw = JSON.parse(fs.readFileSync(src, 'utf8'));
  } catch (e) {
    console.error('gdrive config: gdrive.config.json is not valid JSON');
    process.exit(1);
  }
}
const val = (k) => JSON.stringify(String(raw[k] ?? ''));
fs.writeFileSync(
  dst,
  `// @generated — DO NOT EDIT, DO NOT COMMIT (gitignored). Written by
// scripts/apply-gdrive-config.js (postinstall) from mobile/gdrive.config.json
// when present, EMPTY otherwise. Empty clientId simply hides the Google
// Drive chip.
export default {
  clientId: ${val('clientId')},
  clientSecret: ${val('clientSecret')},
  authBase: ${val('authBase')},
  apiBase: ${val('apiBase')},
  uploadBase: ${val('uploadBase')}
}
`
);
console.log(
  raw.clientId
    ? 'gdrive config: applied to src/gdrive-config.ts'
    : 'gdrive config: none present — EMPTY module written, Drive stays hidden'
);
