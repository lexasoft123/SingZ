#pragma once

#include <pthread.h>
#include <sched.h>

#include <cstdio>

namespace singz::detail {

inline void prepareAlsaWorker(const char* name) noexcept {
  const int nameError = pthread_setname_np(pthread_self(), name);
  sched_param parameters{};
  parameters.sched_priority = 20;
  const int schedulingError =
      pthread_setschedparam(pthread_self(), SCHED_FIFO, &parameters);
  if (schedulingError != 0) {
    std::fprintf(stderr,
        "zcore: %s SCHED_FIFO priority 20 request failed (error %d); "
        "retaining inherited scheduling\n", name, schedulingError);
  } else if (nameError != 0) {
    std::fprintf(stderr, "zcore: %s thread naming failed (error %d)\n",
        name, nameError);
  }
}

}  // namespace singz::detail
