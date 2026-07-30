#!/usr/bin/env bash
# Run every dataset the current checkout can reach and write one results file:
#   out/<date>-<git-sha>.json   (per-track + aggregate numbers)
# Library needs the user's split projects (SINGZ_EVAL_LIBRARY); ballroom needs
# fetch-annotations.sh + fetch-ballroom.sh. A missing dataset is skipped with
# a note, not an error — the file records what actually ran.
set -uo pipefail
cd "$(dirname "$0")"

SHA=$(git rev-parse --short HEAD)
STAMP="$(date +%Y-%m-%d)-$SHA"
mkdir -p out/tmp

LIB_JSON=out/tmp/run-all-library.json
BR_JSON=out/tmp/run-all-ballroom.json
rm -f "$LIB_JSON" "$BR_JSON"

LIB_ROOT="${SINGZ_EVAL_LIBRARY:-$HOME/Library/Mobile Documents/com~apple~CloudDocs/SingZ}"
if [ -d "$LIB_ROOT" ]; then
  echo "=== library ==="
  node run-current.mjs --dataset library --json "$LIB_JSON" || true
else
  echo "library root not found ($LIB_ROOT) — skipping library"
fi

if [ -d data/ballroom ] && [ -d data/beat_this_annotations ]; then
  echo "=== ballroom ==="
  node run-current.mjs --dataset ballroom --json "$BR_JSON" || true
else
  echo "ballroom data missing (run ./fetch-annotations.sh and ./fetch-ballroom.sh) — skipping ballroom"
fi

node --input-type=module - "$STAMP" "$LIB_JSON" "$BR_JSON" <<'EOF'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
const [stamp, libJson, brJson] = process.argv.slice(2)
const load = (p) => (existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null)
const out = {
  date: new Date().toISOString(),
  gitSha: stamp.split('-').pop(),
  library: load(libJson),
  ballroom: load(brJson)
}
const path = `out/${stamp}.json`
writeFileSync(path, JSON.stringify(out, null, 2))
console.log(`\nwrote ${path}`)
EOF
