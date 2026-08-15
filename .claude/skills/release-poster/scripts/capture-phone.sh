#!/usr/bin/env bash
# Poster capture, phone. Screenshots the running SingZ player.
#
# iOS:      capture-phone.sh ios <out-dir> [udid]
# Android:  capture-phone.sh android <out-dir> [serial]
#
# Screenshots are headless — no live panel needed. Drive the app to the screen
# you want first (simctl/adb taps, or by hand), then call this.
set -euo pipefail

PLATFORM="${1:?usage: capture-phone.sh <ios|android> <out-dir> [device]}"
OUT="${2:?out dir required}"
DEV="${3:-}"
mkdir -p "$OUT"
STAMP=$(date +%H%M%S)

case "$PLATFORM" in
  ios)
    if [ -z "$DEV" ]; then
      # `|| true` matters: with nothing booted, simctl exits 0 with empty
      # arrays, grep finds nothing and exits 1, and pipefail + set -e would
      # kill the script here — silently, before the message below that tells
      # the operator to boot a simulator.
      DEV=$(xcrun simctl list devices booted -j | grep -o '"udid" : "[^"]*"' | head -1 | cut -d'"' -f4 || true)
    fi
    [ -n "$DEV" ] || { echo "no booted simulator; boot one first" >&2; exit 1; }
    # Confirm the app is actually installed, so a blank shot is never mistaken
    # for a UI problem.
    xcrun simctl get_app_container "$DEV" com.lexasoft.singz >/dev/null
    xcrun simctl io "$DEV" screenshot "$OUT/phone-ios-$STAMP.png" >/dev/null 2>&1
    echo "$OUT/phone-ios-$STAMP.png"
    ;;
  android)
    ADB=(adb)
    [ -n "$DEV" ] && ADB=(adb -s "$DEV")
    # A release APK on the emulator is a different app from this tree's debug
    # build; say so rather than shooting whatever is installed.
    "${ADB[@]}" shell dumpsys package com.lexasoft.singz | grep -q DEBUGGABLE \
      || echo "warning: installed package is not debuggable — may not be this tree's build" >&2
    "${ADB[@]}" exec-out screencap -p > "$OUT/phone-android-$STAMP.png"
    echo "$OUT/phone-android-$STAMP.png"
    ;;
  *)
    echo "unknown platform: $PLATFORM" >&2; exit 1 ;;
esac
