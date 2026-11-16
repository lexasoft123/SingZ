#pragma once
#include <csignal>

namespace monitor_spike {
inline volatile std::sig_atomic_t interrupted = 0;
inline void signalHandler(int) { interrupted = 1; }
// Handlers request ordinary control-loop teardown; no device operations in a
// signal context. SIGHUP from terminal closure gets the same lease cleanup.
inline void installTerminationHandlers() {
  std::signal(SIGINT, signalHandler);
  std::signal(SIGTERM, signalHandler);
#ifdef SIGHUP
  std::signal(SIGHUP, signalHandler);
#endif
}
}
