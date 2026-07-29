/*
 * Desktop twin of mobile/scripts/apply-gdrive-config.js: writes
 * src/main/gdrive-config.ts (gitignored, never in the repo) from
 * mobile/gdrive.config.json (gitignored; CI writes it from a repo secret).
 * No json -> EMPTY module, Drive stays hidden. Runs on postinstall and
 * again inside `npm run build` (CI injects the secret between the two).
 */
const fs = require('fs');
const path = require('path');

const src = path.join(__dirname, '..', 'mobile', 'gdrive.config.json');
const dst = path.join(__dirname, '..', 'src', 'main', 'gdrive-config.ts');
const raw = fs.existsSync(src) ? JSON.parse(fs.readFileSync(src, 'utf8')) : {};
const val = (k) => JSON.stringify(String(raw[k] ?? ''));
fs.writeFileSync(
  dst,
  `// @generated — DO NOT EDIT, DO NOT COMMIT (gitignored). Written by
// scripts/apply-gdrive-config.cjs from mobile/gdrive.config.json (single
// local source for both apps) when present, EMPTY otherwise. Empty clientId
// hides Google Drive in the storage picker.
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
    ? 'gdrive config: applied to src/main/gdrive-config.ts'
    : 'gdrive config: none present — EMPTY module written, Drive stays hidden'
);
