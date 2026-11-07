#!/usr/bin/env bash
# Hosted images often already contain these packages. Avoid refreshing every
# unrelated repository, and never let package setup consume the whole CI job.
set -euo pipefail
if [ "$#" -eq 0 ]; then
  echo "usage: ci-install-apt.sh <package>..." >&2
  exit 64
fi
missing=()
for package in "$@"; do
  if [ "$(dpkg-query -W -f='${Status}' "$package" 2>/dev/null || true)" != 'install ok installed' ]; then
    missing+=("$package")
  fi
done
if [ "${#missing[@]}" -eq 0 ]; then
  echo "CI packages already installed: $*"
  exit 0
fi
options=(-o Acquire::Retries=2 -o Acquire::http::Timeout=15 -o Acquire::https::Timeout=15 -o DPkg::Lock::Timeout=30)
install_packages() {
  sudo timeout --kill-after=5s "$1" env DEBIAN_FRONTEND=noninteractive \
    apt-get "${options[@]}" install --yes --no-install-recommends "${missing[@]}"
}
echo "Installing missing CI packages: ${missing[*]}"
if install_packages 60s; then exit 0; fi
echo "Refreshing package indexes before one installation retry"
sudo timeout --kill-after=5s 90s apt-get "${options[@]}" update
install_packages 120s
