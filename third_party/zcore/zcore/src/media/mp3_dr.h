#pragma once

// dr_mp3's low-level frame decoder, and nothing else of it
// (third_party/native/dr_mp3/README.md). Included by exactly ONE translation
// unit, mp3_streaming_source.cpp, which also compiles the implementation — with every
// dr_mp3 function `static`, so no drmp3 symbol leaves this core. That matters
// on iOS, where the app also links react-native-audio-api and a second copy of
// any drmp3 symbol would be a duplicate-symbol link failure, and on Android,
// where libsingzcore.so's export surface is checked after every link.
#define DR_MP3_NO_STDIO
#define DR_MP3_ONLY_MP3
#define DR_MP3_FLOAT_OUTPUT
#define DRMP3_API static
#define DRMP3_PRIVATE static
#define DR_MP3_IMPLEMENTATION
#include <dr_mp3.h>
