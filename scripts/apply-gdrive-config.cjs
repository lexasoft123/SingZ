/*
 * Desktop twin of mobile/scripts/apply-gdrive-config.js: fills
 * src/main/gdrive-config.ts from mobile/gdrive.config.json (gitignored; CI
 * writes it from a repo secret). No json -> no-op, Drive stays hidden.
 */
const fs = require('fs');
const path = require('path');

const src = path.join(__dirname, '..', 'mobile', 'gdrive.config.json');
const dst = path.join(__dirname, '..', 'src', 'main', 'gdrive-config.ts');
if (!fs.existsSync(src)) {
  console.log('gdrive config: none present — Drive stays hidden in this build');
  process.exit(0);
}
const raw = JSON.parse(fs.readFileSync(src, 'utf8'));
const val = (k) => JSON.stringify(String(raw[k] ?? ''));
fs.writeFileSync(
  dst,
  `// @generated-local — filled from mobile/gdrive.config.json (single local
// source for both apps) by scripts/apply-gdrive-config.cjs. Committed EMPTY:
// never commit real values; CI injects them from a repo secret before
// building. Empty clientId hides Google Drive in the storage picker.
export default {
  clientId: ${val('clientId')},
  clientSecret: ${val('clientSecret')},
  authBase: ${val('authBase')},
  apiBase: ${val('apiBase')},
  uploadBase: ${val('uploadBase')}
}
`
);
console.log('gdrive config: applied to src/main/gdrive-config.ts');
