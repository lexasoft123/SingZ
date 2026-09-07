// fseeko/ftello on every platform the core meets. POSIX has them (macOS, iOS,
// Android, Linux — which is why no build before Windows ever noticed); MSVC
// has no fseeko at all and spells the 64-bit pair _fseeki64/_ftelli64 — the
// first MSVC build stopped at C3861 in wav.cpp for exactly this. Same mapping
// libFLAC's share/compat.h uses; kept local so the core's own file IO does not
// depend on FLAC's share headers.
#pragma once
#include <cstdio>
#ifdef _MSC_VER
#define fseeko _fseeki64
#define ftello _ftelli64
#endif
