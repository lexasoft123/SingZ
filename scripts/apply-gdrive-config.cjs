/*
 * Desktop twin of mobile/scripts/apply-gdrive-config.js: writes
 * src/main/gdrive-config.ts (gitignored, never in the repo) from
 * mobile/gdrive.config.json (gitignored; CI writes it from a repo secret).
 * No json -> EMPTY module, Drive stays hidden. Runs on postinstall and
 * again inside `npm run build` (CI injects the secret between the two).
 */
const fs = require('fs');
const path = require('path');


// A worktree is never MEANT to be without it: the main checkout beside it has
// the file, worktree-setup.sh links it, and the only reason it is missing is
// that the link was not made. CI genuinely has no json until it injects the
// secret, so the quiet line below is right there and wrong here — say which
// case this is, and name the fix, because "Drive stays hidden" reads as a
// decision rather than as the reason sync went dead.
function worktreeHint(rel) {
  try {
    const dotGit = path.join(__dirname, '..', '.git');
    if (!fs.existsSync(dotGit) || !fs.statSync(dotGit).isFile()) return '';
    const main = /gitdir:\s*(.+)/.exec(fs.readFileSync(dotGit, 'utf8'))?.[1] ?? '';
    const root = main.split('/.git/worktrees/')[0];
    if (!root || !fs.existsSync(path.join(root, rel))) return '';
    return `\n  This is a WORKTREE and the main checkout HAS the config — Drive sync will\n` +
      `  not work here until it is linked:\n    ln -s ${path.join(root, rel)} ${rel}\n` +
      `  then re-run this script (or npm run build).`;
  } catch { return ''; }
}

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
    : 'gdrive config: none present — EMPTY module written, Drive stays hidden' + worktreeHint('mobile/gdrive.config.json')
);
