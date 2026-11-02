#pragma once
#include <stddef.h>
#ifdef __cplusplus
extern "C" {
#endif
// Returned strings belong to the caller. Hosts supply a private root and
// metadata bytes; UI callers choose only an operation, release and file.
char *singz_torrent_call(const char *root, const char *operation,
                         const char *release, int file_index,
                         const unsigned char *metadata, size_t metadata_size);
const char *singz_torrent_source_stamp(void);
void singz_torrent_free(char *result);
void singz_torrent_shutdown(const char *root);
#ifdef __cplusplus
}
#endif
