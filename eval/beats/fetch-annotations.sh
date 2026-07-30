#!/usr/bin/env bash
# Fetch CPJKU's beat/downbeat annotations (16 datasets, .beats TSV files:
# time + beat counter, counter 1 = downbeat) into data/.
# Skip-guards on an existing clone; delete data/beat_this_annotations to force.
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p data
if [ -d data/beat_this_annotations/.git ]; then
  echo "data/beat_this_annotations already present — skipping (delete to re-fetch)"
  exit 0
fi
git clone --depth 1 https://github.com/CPJKU/beat_this_annotations data/beat_this_annotations
echo "done: $(find data/beat_this_annotations -name '*.beats' | wc -l | tr -d ' ') annotation files"
