#!/bin/sh
# Unix validation fixture. Never rewritten by tests while processes may fork.
[ "$#" -eq 2 ] && [ "$1" = '--measure-input' ] || exit 2
case "$2" in
  */input.wav)
    printf '%s\n' '{"protocol":1,"ok":true,"rms":0.25,"sampleRate":48000,"channels":1,"frames":4800}'
    ;;
  */cancel-measure.wav)
    printf ready > "$2.ready"
    sleep 30
    ;;
  */oversized-measure.wav)
    head -c 20000 /dev/zero
    ;;
  *) exit 2 ;;
esac
