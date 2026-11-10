#pragma once
// Shared by the owner integration executable and a dependency-free fixture.
#include "native/playback/box_timing_journal.h"
#include <array>
#include <cstdio>
#include <cstdlib>

namespace singz::box_timing {
inline void runJournalRegression() {
  auto check = [](bool value, const char* message) {
    if (!value) { std::fprintf(stderr, "timing journal regression: %s\n", message); std::abort(); }
  };
  struct Row { std::atomic<uint64_t> sequence{0}, payload{0}; };
  std::array<Row, 2> rows;
  std::atomic<bool> lost{false};
  // Deterministically pause A after claim; B advances the other slot, C laps A.
  check(tryClaim(rows[0].sequence, 0, lost), "A owns slot zero");
  rows[0].payload.store(111);
  check(!published(rows[0].sequence, 0), "inflight A is never a readable record");
  check(tryClaim(rows[1].sequence, 1, lost), "B owns slot one");
  rows[1].payload.store(222); publish(rows[1].sequence, 1);
  check(!tryClaim(rows[0].sequence, 2, lost), "C cannot overwrite preempted A");
  check(lost.load() && rows[0].payload.load() == 111, "lap latches loss without touching A");
  publish(rows[0].sequence, 0);
  check(!published(rows[0].sequence, 2), "A completion is not C completion");

  // A reserved index0 but was preempted before claim. C already published2.
  rows[0].sequence.store(0); rows[1].sequence.store(0); lost.store(false);
  check(tryClaim(rows[0].sequence, 2, lost), "newer reservation claims free slot");
  rows[0].payload.store(333); publish(rows[0].sequence, 2);
  check(!tryClaim(rows[0].sequence, 0, lost), "stale reservation cannot reclaim newer data");
  check(lost.load() && rows[0].payload.load() == 333, "stale failure preserves C payload");

  // Every final snapshot guard participates; a new reservation can carry a
  // failure interval outside the scanned window even if its slot is complete.
  std::atomic<uint64_t> physical{3}, missing{4}; lost.store(false);
  check(unchanged(physical, 3, missing, 4, lost), "unchanged snapshot certifies absence");
  physical.fetch_add(1);
  check(!unchanged(physical, 3, missing, 4, lost), "new physical boundary rejects snapshot");
  physical.store(3); missing.fetch_add(1);
  check(!unchanged(physical, 3, missing, 4, lost), "new missing interval rejects snapshot");
  missing.store(4); lost.store(true);
  check(!unchanged(physical, 3, missing, 4, lost), "coverage loss fences projection");


}
} // namespace singz::box_timing
