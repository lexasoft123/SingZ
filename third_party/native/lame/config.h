/* Portable encoder-only configuration; no assembly or decoder. */
#include <stdint.h>
#define STDC_HEADERS 1
#define HAVE_ERRNO_H 1
#define HAVE_FCNTL_H 1
#define HAVE_LIMITS_H 1
#define HAVE_STDINT_H 1
#define HAVE_MEMCPY 1
#define HAVE_STRCHR 1
#include <float.h>
#define PACKAGE "lame"
#define VERSION "3.100"
typedef float ieee754_float32_t;
typedef double ieee754_float64_t;
typedef long double ieee854_float80_t;
