#include "flac_io.h"

#include <FLAC/stream_decoder.h>
#include <FLAC/stream_encoder.h>

#include <cstdio>
#include <cstring>
#include <sys/stat.h>
#include <vector>

namespace singz {

// ---- decode ----------------------------------------------------------------

namespace {

struct DecCtx {
  MonoWav* out = nullptr;
  bool sawError = false;
  std::string error;
};

FLAC__StreamDecoderWriteStatus onWrite(const FLAC__StreamDecoder*, const FLAC__Frame* frame,
                                       const FLAC__int32* const buffer[], void* client) {
  DecCtx* ctx = static_cast<DecCtx*>(client);
  const unsigned channels = frame->header.channels;
  const unsigned bps = frame->header.bits_per_sample;
  // 2^(bps-1), the same scale the WAV reader applies per bit depth.
  const double scale = static_cast<double>(1u << (bps - 1));
  MonoWav& out = *ctx->out;
  for (unsigned i = 0; i < frame->header.blocksize; i++) {
    // THE fold, byte for byte the WAV reader's (and JS loadMono44k's): the
    // running sum is squeezed through float32 after every channel. Grid
    // parity rests on this loop, not merely on FLAC being lossless.
    double acc = 0;
    for (unsigned c = 0; c < channels; c++) {
      const double v = static_cast<double>(buffer[c][i]) / scale;
      acc = static_cast<double>(static_cast<float>(acc + v / channels));
    }
    out.samples.push_back(static_cast<float>(acc));
  }
  return FLAC__STREAM_DECODER_WRITE_STATUS_CONTINUE;
}

void onMeta(const FLAC__StreamDecoder*, const FLAC__StreamMetadata* meta, void* client) {
  DecCtx* ctx = static_cast<DecCtx*>(client);
  if (meta->type != FLAC__METADATA_TYPE_STREAMINFO) return;
  ctx->out->sampleRate = static_cast<int>(meta->data.stream_info.sample_rate);
  ctx->out->channels = static_cast<int>(meta->data.stream_info.channels);
  // total_samples may legitimately be 0 (unknown); reserve only when stated.
  if (meta->data.stream_info.total_samples > 0)
    ctx->out->samples.reserve(static_cast<size_t>(meta->data.stream_info.total_samples));
}

void onError(const FLAC__StreamDecoder*, FLAC__StreamDecoderErrorStatus status, void* client) {
  DecCtx* ctx = static_cast<DecCtx*>(client);
  ctx->sawError = true;
  ctx->error = FLAC__StreamDecoderErrorStatusString[status];
}

}  // namespace

MonoWav readFlacMono(const std::string& path) {
  MonoWav out;
  FLAC__StreamDecoder* d = FLAC__stream_decoder_new();
  if (d == nullptr) {
    out.error = "FLAC decoder unavailable";
    return out;
  }
  DecCtx ctx;
  ctx.out = &out;
  const FLAC__StreamDecoderInitStatus init =
      FLAC__stream_decoder_init_file(d, path.c_str(), onWrite, onMeta, onError, &ctx);
  if (init != FLAC__STREAM_DECODER_INIT_STATUS_OK) {
    out.error = FLAC__StreamDecoderInitStatusString[init];
    FLAC__stream_decoder_delete(d);
    return out;
  }
  const bool decoded = FLAC__stream_decoder_process_until_end_of_stream(d);
  FLAC__stream_decoder_finish(d);
  FLAC__stream_decoder_delete(d);
  if (!decoded || ctx.sawError) {
    out.samples.clear();
    out.error = ctx.error.empty() ? "FLAC decode failed" : ctx.error;
    return out;
  }
  if (out.sampleRate <= 0 || out.channels <= 0) {
    out.error = "FLAC stream carried no STREAMINFO";
    return out;
  }
  out.ok = true;
  return out;
}

WavInfo readFlacInfo(const std::string& path) {
  WavInfo out;
  MonoWav probe;  // reuse the metadata callback's target shape
  FLAC__StreamDecoder* d = FLAC__stream_decoder_new();
  if (d == nullptr) {
    out.error = "FLAC decoder unavailable";
    return out;
  }
  DecCtx ctx;
  ctx.out = &probe;
  int64_t total = 0;
  const FLAC__StreamDecoderInitStatus init =
      FLAC__stream_decoder_init_file(d, path.c_str(), onWrite, onMeta, onError, &ctx);
  if (init == FLAC__STREAM_DECODER_INIT_STATUS_OK &&
      FLAC__stream_decoder_process_until_end_of_metadata(d)) {
    total = static_cast<int64_t>(FLAC__stream_decoder_get_total_samples(d));
  } else {
    out.error = "not a FLAC stream";
    FLAC__stream_decoder_delete(d);
    return out;
  }
  FLAC__stream_decoder_finish(d);
  FLAC__stream_decoder_delete(d);
  if (probe.sampleRate <= 0 || probe.channels <= 0) {
    out.error = "FLAC stream carried no STREAMINFO";
    return out;
  }
  out.sampleRate = probe.sampleRate;
  out.channels = probe.channels;
  out.frames = total;  // 0 when the stream does not state it, like a lying WAV header clamps
  out.ok = true;
  return out;
}

// ---- encode (the upgrade's per-stem op) ------------------------------------

namespace {

bool fileExists(const std::string& p, int64_t* size = nullptr) {
  struct stat st;
  if (::stat(p.c_str(), &st) != 0) return false;
  if (size != nullptr) *size = static_cast<int64_t>(st.st_size);
  return true;
}

uint32_t rdLe32(const unsigned char* p) {
  return static_cast<uint32_t>(p[0]) | (static_cast<uint32_t>(p[1]) << 8) |
         (static_cast<uint32_t>(p[2]) << 16) | (static_cast<uint32_t>(p[3]) << 24);
}
uint16_t rdLe16(const unsigned char* p) { return static_cast<uint16_t>(p[0] | (p[1] << 8)); }

// The canonical-16-bit-PCM walk, standalone so the encoder does not reach
// into wav.cpp's internals: leaves f at the first data byte. Rejects
// anything that is not what the split writes — the desktop's converter
// (src/main/flac.ts:91) rejects identically, so a stem that upgrades on one
// machine upgrades on both.
bool walkPcm16(std::FILE* f, int* rate, int* channels, int64_t* frames, std::string* err) {
  unsigned char hdr[12];
  if (std::fread(hdr, 1, 12, f) != 12 || std::memcmp(hdr, "RIFF", 4) != 0 ||
      std::memcmp(hdr + 8, "WAVE", 4) != 0) {
    *err = "not a RIFF/WAVE file";
    return false;
  }
  bool haveFmt = false;
  int format = 0, bits = 0;
  for (;;) {
    unsigned char ch[8];
    if (std::fread(ch, 1, 8, f) != 8) {
      *err = haveFmt ? "no data chunk" : "no fmt chunk";
      return false;
    }
    const uint32_t size = rdLe32(ch + 4);
    if (std::memcmp(ch, "fmt ", 4) == 0) {
      if (size < 16) {
        *err = "fmt chunk too short";
        return false;
      }
      std::vector<unsigned char> fmt(size);
      if (std::fread(fmt.data(), 1, size, f) != size) {
        *err = "truncated fmt chunk";
        return false;
      }
      format = rdLe16(fmt.data());
      *channels = rdLe16(fmt.data() + 2);
      *rate = static_cast<int>(rdLe32(fmt.data() + 4));
      bits = rdLe16(fmt.data() + 14);
      if (format == 0xFFFE && size >= 26) format = rdLe16(fmt.data() + 24);
      haveFmt = true;
      if ((size & 1u) != 0) std::fseek(f, 1, SEEK_CUR);
    } else if (std::memcmp(ch, "data", 4) == 0) {
      if (!haveFmt || *channels <= 0 || *rate <= 0) {
        *err = "data before fmt";
        return false;
      }
      if (format != 1 || bits != 16) {
        *err = "only canonical 16-bit PCM is compacted (the split's own output)";
        return false;
      }
      const long here = std::ftell(f);
      std::fseek(f, 0, SEEK_END);
      const long end = std::ftell(f);
      std::fseek(f, here, SEEK_SET);
      const int64_t left = here >= 0 && end >= here ? static_cast<int64_t>(end - here) : 0;
      const int64_t frameBytes = 2 * static_cast<int64_t>(*channels);
      *frames = std::min<int64_t>(static_cast<int64_t>(size), left) / frameBytes;
      return true;
    } else {
      std::fseek(f, static_cast<long>(size + (size & 1u)), SEEK_CUR);
    }
  }
}

}  // namespace

CompactResult compactStem(const std::string& wavPath, const std::string& flacPath) {
  CompactResult out;

  // A completed flac beside a leftover wav is the kill-between-rename-and-
  // unlink state: finish the unlink and report the flac. The .part suffix is
  // never renamed unless the encoder FINISHED with verify on, so a file at
  // flacPath is a verified encode by construction.
  int64_t flacSize = 0;
  if (fileExists(flacPath, &flacSize)) {
    std::remove(wavPath.c_str());  // absent is fine — remove() failing changes nothing
    out.ok = true;
    out.skipped = true;
    out.bytes = flacSize;
    return out;
  }

  std::FILE* f = std::fopen(wavPath.c_str(), "rb");
  if (f == nullptr) {
    out.error = "no wav and no flac for this stem";
    return out;
  }
  int rate = 0, channels = 0;
  int64_t frames = 0;
  if (!walkPcm16(f, &rate, &channels, &frames, &out.error)) {
    std::fclose(f);
    return out;
  }

  const std::string part = flacPath + ".part";
  FLAC__StreamEncoder* e = FLAC__stream_encoder_new();
  if (e == nullptr) {
    std::fclose(f);
    out.error = "FLAC encoder unavailable";
    return out;
  }
  // The desktop's four choices (src/main/flac.ts): level 5, verify ON — the
  // encoder decodes its own output as it writes and fails the finish on any
  // mismatch, which is the decode-back check placed where a crash cannot
  // skip it — total samples declared, and the atomic .part rename below.
  const bool set = FLAC__stream_encoder_set_channels(e, static_cast<unsigned>(channels)) &&
                   FLAC__stream_encoder_set_bits_per_sample(e, 16) &&
                   FLAC__stream_encoder_set_sample_rate(e, static_cast<unsigned>(rate)) &&
                   FLAC__stream_encoder_set_compression_level(e, 5) &&
                   FLAC__stream_encoder_set_total_samples_estimate(e, static_cast<FLAC__uint64>(frames)) &&
                   FLAC__stream_encoder_set_verify(e, true);
  if (!set || FLAC__stream_encoder_init_file(e, part.c_str(), nullptr, nullptr) !=
                  FLAC__STREAM_ENCODER_INIT_STATUS_OK) {
    out.error = "FLAC encoder init failed";
    FLAC__stream_encoder_delete(e);
    std::fclose(f);
    std::remove(part.c_str());
    return out;
  }

  // Stream in 64k-frame slabs: a five-minute stem is ~55 MB and the phone
  // must never hold it twice.
  const int64_t CHUNK = 65536;
  std::vector<unsigned char> raw(static_cast<size_t>(CHUNK) * 2 * static_cast<size_t>(channels));
  std::vector<FLAC__int32> pcm(static_cast<size_t>(CHUNK) * static_cast<size_t>(channels));
  bool wrote = true;
  int64_t left = frames;
  while (left > 0 && wrote) {
    const int64_t n = std::min(left, CHUNK);
    const size_t want = static_cast<size_t>(n) * 2 * static_cast<size_t>(channels);
    if (std::fread(raw.data(), 1, want, f) != want) {
      out.error = "wav truncated mid-read";
      wrote = false;
      break;
    }
    for (int64_t i = 0; i < n * channels; i++)
      pcm[static_cast<size_t>(i)] =
          static_cast<int16_t>(rdLe16(raw.data() + static_cast<size_t>(i) * 2));
    wrote = FLAC__stream_encoder_process_interleaved(e, pcm.data(), static_cast<unsigned>(n));
    if (!wrote) out.error = "FLAC encode failed";
    left -= n;
  }
  std::fclose(f);
  if (wrote && !FLAC__stream_encoder_finish(e)) {
    // Verify-on makes this the failure site for a corrupt encode.
    out.error = "FLAC verify failed at finish";
    wrote = false;
  }
  FLAC__stream_encoder_delete(e);
  if (!wrote) {
    std::remove(part.c_str());  // the wav is untouched; the project stays v1
    return out;
  }
  if (std::rename(part.c_str(), flacPath.c_str()) != 0) {
    out.error = "rename .part failed";
    std::remove(part.c_str());
    return out;
  }
  std::remove(wavPath.c_str());
  fileExists(flacPath, &out.bytes);
  out.ok = true;
  return out;
}

}  // namespace singz
