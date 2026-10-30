include_guard(GLOBAL)

option(SINGZ_COMPILER_CACHE "Use ccache for supported native compilations" ON)

# Root host builds and presets use the same per-build policy as Android.
# Called only by the root project: an embedding host owns its own launchers.
macro(_singz_remove_owned_cache_launchers)
  foreach(_singz_language IN ITEMS C CXX)
    if(CMAKE_${_singz_language}_COMPILER_LAUNCHER MATCHES "/scripts/ccache-launcher\\.(sh|ps1);")
      unset(CMAKE_${_singz_language}_COMPILER_LAUNCHER CACHE)
      unset(CMAKE_${_singz_language}_COMPILER_LAUNCHER PARENT_SCOPE)
    endif()
  endforeach()
endmacro()

function(singz_enable_compiler_cache repo_root)
  if(NOT SINGZ_COMPILER_CACHE)
    _singz_remove_owned_cache_launchers()
    return()
  endif()
  if(SINGZ_CCACHE_EXECUTABLE AND NOT EXISTS "${SINGZ_CCACHE_EXECUTABLE}")
    unset(SINGZ_CCACHE_EXECUTABLE CACHE)
  endif()
  find_program(SINGZ_CCACHE_EXECUTABLE NAMES ccache)
  if(NOT SINGZ_CCACHE_EXECUTABLE)
    _singz_remove_owned_cache_launchers()
    message(STATUS "SingZ compiler cache: ccache not found; compiling normally")
    return()
  endif()
  if(CMAKE_HOST_WIN32)
    set(_singz_launcher
      "powershell.exe;-NoProfile;-NonInteractive;-ExecutionPolicy;Bypass;-File;${repo_root}/scripts/ccache-launcher.ps1;${SINGZ_CCACHE_EXECUTABLE};${repo_root}")
  else()
    set(_singz_launcher
      "/bin/sh;${repo_root}/scripts/ccache-launcher.sh;${SINGZ_CCACHE_EXECUTABLE};${repo_root}")
  endif()
  foreach(_singz_language IN ITEMS C CXX)
    set(_singz_current "${CMAKE_${_singz_language}_COMPILER_LAUNCHER}")
    # Upgrade a direct ccache invocation or our own previous launcher. Respect
    # a deliberately supplied different cache/distributed compiler launcher.
    if(_singz_current AND
       NOT _singz_current STREQUAL "ccache" AND
       NOT _singz_current STREQUAL "${SINGZ_CCACHE_EXECUTABLE}" AND
       NOT _singz_current MATCHES "(^|[/\\\\])ccache(\\.exe)?$" AND
       NOT _singz_current MATCHES "/scripts/ccache-launcher\\.(sh|ps1);")
      continue()
    endif()
    set(CMAKE_${_singz_language}_COMPILER_LAUNCHER "${_singz_launcher}"
      CACHE STRING "SingZ worktree-portable compiler cache launcher" FORCE)
    set(CMAKE_${_singz_language}_COMPILER_LAUNCHER "${_singz_launcher}" PARENT_SCOPE)
  endforeach()
endfunction()
