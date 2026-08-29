#!/usr/bin/env bash
#
# Run a command with the Apple credentials from the SOPS store in the
# environment. The plaintext never touches a file that outlives the command,
# and never appears in the shell history or a process argument list.
#
# fastlane must run from mobile/ios (that is where its Gemfile and fastlane/
# directory live), and this script does not change directory for you — so cd
# inside the command rather than passing a bare `bundle exec`, which fails
# from the repo root with "Could not locate Gemfile":
#
#   scripts/with-apple-secrets.sh bash -c 'cd mobile/ios && bundle exec fastlane ios certs'
#   scripts/with-apple-secrets.sh bash -c 'cd mobile/ios && bundle exec fastlane ios validate'
#
# Exports APP_STORE_CONNECT_API_KEY_ID, APP_STORE_CONNECT_API_ISSUER_ID and
# MATCH_PASSWORD, and writes the .p8 to a mode-600 temp file pointed at by
# SINGZ_ASC_KEY_PATH — which is exactly what the Fastfile's api_key helper
# looks for. CI does not use this: it has the same values as repo secrets.
#
# Store layout and rationale: .sops.yaml at the repo root, ciphertext at
# .keys/secrets.enc.yaml. See docs/IOS-RELEASE.md.
set -euo pipefail

if [ $# -eq 0 ]; then
  echo "usage: $(basename "$0") <command> [args...]" >&2
  exit 64
fi

command -v sops >/dev/null || { echo "sops is not installed (brew install sops)" >&2; exit 1; }

# Feature work happens in worktrees (CLAUDE.md) and the store is kept ONCE
# beside the main checkout, shared — same rule as vendor/ and
# gdrive.config.json. Look here, then there.
here=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
store="$here/.keys/secrets.enc.yaml"
if [ ! -f "$store" ]; then
  common=$(git -C "$here" rev-parse --git-common-dir 2>/dev/null || true)
  if [ -n "$common" ]; then
    case "$common" in /*) ;; *) common="$here/$common" ;; esac
    store="$(dirname "$common")/.keys/secrets.enc.yaml"
  fi
fi
[ -f "$store" ] || { echo "no SOPS store found (.keys/secrets.enc.yaml) — see docs/IOS-RELEASE.md" >&2; exit 1; }

# sops does not reliably fall back to the default age key path (measured on
# 3.x here: it reports only the SOPS_AGE_* and SSH locations and fails), so
# name it explicitly when the caller has not.
if [ -z "${SOPS_AGE_KEY_FILE:-}" ] && [ -f "$HOME/.config/sops/age/keys.txt" ]; then
  export SOPS_AGE_KEY_FILE="$HOME/.config/sops/age/keys.txt"
fi

umask 077
tmpdir=$(mktemp -d)
# Not `exec` below, precisely so this still runs.
cleanup() { rm -rf "$tmpdir"; }
trap cleanup EXIT INT TERM HUP

# --config /dev/null: the creation rules are for `sops -e`, and letting sops
# hunt for a .sops.yaml relative to the CWD makes decryption fail in ways
# that depend on where you happened to be standing.
plain=$(sops --config /dev/null -d --output-type json "$store")

# Parse with node rather than grep/sed: the .p8 is a multi-line PEM, and a
# line-oriented parse of it is how you get a key that is subtly truncated
# and an auth error three steps later that says nothing about parsing.
eval "$(
  printf '%s' "$plain" | node -e '
    let raw = ""
    process.stdin.on("data", (d) => (raw += d))
    process.stdin.on("end", () => {
      const s = JSON.parse(raw)
      const need = ["asc_key_id", "asc_issuer_id", "match_password", "asc_key_p8"]
      const missing = need.filter((k) => !s[k])
      if (missing.length) {
        console.error(`sops store is missing: ${missing.join(", ")}`)
        process.exit(1)
      }
      const q = (v) => "'"'"'" + String(v).replace(/'"'"'/g, "'"'"'\\'"'"''"'"'") + "'"'"'"
      console.log(`SINGZ_ASC_KEY_ID=${q(s.asc_key_id)}`)
      console.log(`SINGZ_ASC_ISSUER_ID=${q(s.asc_issuer_id)}`)
      console.log(`SINGZ_MATCH_PASSWORD=${q(s.match_password)}`)
      // App Review contact. Optional — older stores predate these keys and
      // every lane except `release` runs fine without them.
      for (const k of ["review_first_name", "review_last_name", "review_phone", "review_email"]) {
        if (s[k]) console.log(`SINGZ_${k.toUpperCase()}=${q(s[k])}`)
      }
      console.log(`SINGZ_ASC_P8=${q(s.asc_key_p8)}`)
    })
  '
)"

printf '%s' "$SINGZ_ASC_P8" > "$tmpdir/AuthKey_${SINGZ_ASC_KEY_ID}.p8"
unset SINGZ_ASC_P8

export APP_STORE_CONNECT_API_KEY_ID="$SINGZ_ASC_KEY_ID"
export APP_STORE_CONNECT_API_ISSUER_ID="$SINGZ_ASC_ISSUER_ID"
export MATCH_PASSWORD="$SINGZ_MATCH_PASSWORD"
export SINGZ_ASC_KEY_PATH="$tmpdir/AuthKey_${SINGZ_ASC_KEY_ID}.p8"
unset SINGZ_ASC_KEY_ID SINGZ_ASC_ISSUER_ID SINGZ_MATCH_PASSWORD

# App Review contact, when the store carries it. The eval above only SETS
# these as shell variables; without an explicit export the child process —
# which is the whole point of this script — never sees them.
for v in SINGZ_REVIEW_FIRST_NAME SINGZ_REVIEW_LAST_NAME SINGZ_REVIEW_PHONE SINGZ_REVIEW_EMAIL; do
  [ -n "${!v:-}" ] && export "$v"
done

# fastlane refuses to run under a non-UTF-8 locale, and the store metadata is
# bilingual — a non-UTF-8 locale is how Cyrillic release notes get mangled.
export LANG="${LANG:-en_US.UTF-8}"
export LC_ALL="${LC_ALL:-en_US.UTF-8}"

set +e
"$@"
rc=$?
set -e
exit $rc
