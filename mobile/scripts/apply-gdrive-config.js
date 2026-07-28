/*
 * Injects the Google OAuth client from mobile/gdrive.config.json (gitignored;
 * CI writes it from a repo secret) into src/gdrive-config.ts, which is
 * committed EMPTY. Metro resolves modules statically, so the config must be
 * a module that always exists — a require() of an optional json file breaks
 * the bundle. Without a local json this is a no-op and the Drive chip hides.
 */
const fs = require('fs');
const path = require('path');

const src = path.join(__dirname, '..', 'gdrive.config.json');
const dst = path.join(__dirname, '..', 'src', 'gdrive-config.ts');
if (!fs.existsSync(src)) {
  console.log('gdrive config: none present — Drive stays hidden in this build');
  process.exit(0);
}
let raw;
try {
  raw = JSON.parse(fs.readFileSync(src, 'utf8'));
} catch (e) {
  console.error('gdrive config: gdrive.config.json is not valid JSON');
  process.exit(1);
}
const val = (k) => JSON.stringify(String(raw[k] ?? ''));
fs.writeFileSync(
  dst,
  `// @generated-local — filled from mobile/gdrive.config.json by
// scripts/apply-gdrive-config.js (postinstall). Committed EMPTY: never commit
// real values; CI injects them from a repo secret at build time. Empty
// clientId simply hides the Google Drive chip.
export default {
  clientId: ${val('clientId')},
  clientSecret: ${val('clientSecret')},
  authBase: ${val('authBase')},
  apiBase: ${val('apiBase')},
  uploadBase: ${val('uploadBase')}
}
`
);
console.log('gdrive config: applied to src/gdrive-config.ts');
