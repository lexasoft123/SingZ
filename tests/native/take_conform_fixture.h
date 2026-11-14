#pragma once
// Resident PCM adapters and the frozen oracle belong ONLY to fixture tests.
#include "native/playback/take_conform.h"
#include "fixtures/take-conform-v2/take_conform.h"
#include <atomic>
#include <array>
#include <algorithm>
#include <chrono>
#include <filesystem>
#include <fstream>
#include <stdexcept>
namespace singz {
using TakeConformPcm=singz_v2_reference::TakeConformPcm;
using TakeConformResult=singz_v2_reference::TakeConformResult;
using singz_v2_reference::writeTakeConformWav;
using singz_v2_reference::readTakeConformWav;
inline std::string conformFixturePath() {
  static std::atomic<uint64_t> counter{0};
  return (std::filesystem::temp_directory_path()/("singz-stream-fixture-"+std::to_string(std::chrono::steady_clock::now().time_since_epoch().count())+"-"+std::to_string(counter++)+".wav")).string();
}
inline TakeConformResult conformTakePcm(const TakeConformPcm &p,const TakeConformRequest &r,const std::atomic<bool> *cancel=nullptr) {
  const auto input=conformFixturePath(),output=conformFixturePath(),oracle=conformFixturePath();
  struct Cleanup {std::string a,b,c;~Cleanup(){std::error_code ignored;std::filesystem::remove(a,ignored);std::filesystem::remove(b,ignored);std::filesystem::remove(c,ignored);}} cleanup{input,output,oracle};
  singz_v2_reference::writeTakeConformWav(input,p);
  const auto stats=conformTakeFile(input,output,r,cancel);
  TakeConformResult result;result.pcm=singz_v2_reference::readTakeConformWav(output);
  result.inputLatencyFrames=stats.inputLatencyFrames;result.outputLatencyFrames=stats.outputLatencyFrames;
  result.signalsmithPasses=stats.signalsmithPasses;result.processedBlocks=stats.processedBlocks;
  // Golden comparison uses the committed algorithm under the SAME compiler and
  // FP flags, rather than a platform-specific checksum that hides rounding drift.
  // Mutants must be caught by their named behaviour assertions, rather than
  // an earlier comparison against an intentionally unmutated byte oracle.
#if !defined(SINGZ_CONFORM_NEGATIVE_RATIO) && !defined(SINGZ_CONFORM_NEGATIVE_PLACEMENT) && !defined(SINGZ_CONFORM_NEGATIVE_LATENCY) && !defined(SINGZ_CONFORM_NEGATIVE_DRIFT)
  if (!cancel) {
    singz_v2_reference::TakeConformRequest old;
    old.outputRate=r.outputRate;old.songDurationProjectFrames=r.songDurationProjectFrames;
    old.startPositionSec=r.startPositionSec;old.userOffsetSec=r.userOffsetSec;
    for(const auto&a:r.anchors)old.anchors.push_back({a.takeFrame,a.projectFrame});
    for(const auto&s:r.settings)old.settings.push_back({s.takeFrame,s.transposeSemitones});
    for(const auto&e:r.effects)old.effects.push_back({e.id,e.enabled,e.manualOffsetSemitones,e.preserveFormants});
    const auto golden=singz_v2_reference::conformTakePcm(p,old);
    if(result.pcm.sampleRate!=golden.pcm.sampleRate || result.pcm.samples!=golden.pcm.samples)
      throw std::runtime_error("Streaming PCM differs from frozen committed v2 golden");
    singz_v2_reference::writeTakeConformWav(oracle,golden.pcm);
    std::ifstream a(output,std::ios::binary),b(oracle,std::ios::binary);std::array<char,65536> ab{},bb{};
    do {a.read(ab.data(),ab.size());b.read(bb.data(),bb.size());
      if(a.gcount()!=b.gcount() || !std::equal(ab.begin(),ab.begin()+a.gcount(),bb.begin()))throw std::runtime_error("Streaming WAV bytes differ from v2 golden");
    }while(a.gcount());
  }
#endif
  return result;
}
} // namespace singz
