#!/usr/bin/env bash
# Fetch the Ballroom audio set (ISMIR04 tempo-contest data: 698 tracks x 30 s,
# 1.4 GB) into data/ballroom/BallroomData/<Genre>/*.wav.
# Matching beat/downbeat annotations: fetch-annotations.sh (dataset "ballroom",
# 685 files — CPJKU excludes the 13 known duplicate tracks).
#
# The server 403s the default curl User-Agent — keep the -A flag.
# Resumable (curl -C -); skip-guards on extracted audio; delete
# data/ballroom to force a re-download.
set -euo pipefail
cd "$(dirname "$0")"

URL="https://mtg.upf.edu/ismir2004/contest/tempoContest/data1.tar.gz"
UA="Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)"
DEST=data/ballroom

if [ -d "$DEST/BallroomData" ] && [ "$(find "$DEST/BallroomData" -name '*.wav' | wc -l)" -ge 698 ]; then
  echo "$DEST/BallroomData already complete — skipping (delete $DEST to re-fetch)"
  exit 0
fi

mkdir -p "$DEST"
echo "downloading ~1.4 GB (resumable — rerun on interruption)…"
curl -L -C - --fail -A "$UA" -o "$DEST/data1.tar.gz" "$URL"
echo "extracting…"
tar -xzf "$DEST/data1.tar.gz" -C "$DEST"
echo "done: $(find "$DEST/BallroomData" -name '*.wav' | wc -l | tr -d ' ') wav files"
echo "the tarball can be deleted now: rm $DEST/data1.tar.gz"
