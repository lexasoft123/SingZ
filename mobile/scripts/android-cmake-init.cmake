# Loaded through CMAKE_PROJECT_INCLUDE_BEFORE for every Android CMake project,
# including React Native dependencies under node_modules.  AGP starts Ninja
# directly for each of those projects, so an app-local job pool does not cap
# Skia, Reanimated, Worklets, Audio API, or the other native modules.
#
# Compile and link edges deliberately share one pool. With ccache, one edge is
# visible in `ps ... | grep clang` twice (the ccache wrapper command line names
# clang, then ccache starts the real compiler), so the pool uses half the
# process ceiling. This keeps that operational check at or below eight as well
# as preventing extra link drivers from escaping the limit.
if(NOT SINGZ_ANDROID_BUILD_POLICY_HASH)
    message(FATAL_ERROR
        "SINGZ_ANDROID_BUILD_POLICY_HASH must identify this policy file")
endif()

set(SINGZ_ANDROID_NATIVE_MAX_JOBS 8 CACHE STRING
    "Maximum combined Android native compile/link jobs")

if(SINGZ_ANDROID_NATIVE_MAX_JOBS LESS 1)
    message(FATAL_ERROR
        "SINGZ_ANDROID_NATIVE_MAX_JOBS must be at least 1")
endif()

# One ccache launcher for every Android native module, with paths normalized
# to the checkout root so sibling worktrees share entries. React Native's
# application helper otherwise adds a second RULE_LAUNCH_COMPILE wrapper only
# to the app graph; a compiler launcher plus that rule becomes `ccache ccache
# clang`, which ccache rejects as a multi-source invocation.
get_filename_component(SINGZ_ANDROID_REPO_ROOT
    "${CMAKE_CURRENT_LIST_DIR}/../.." REALPATH)
find_program(SINGZ_ANDROID_CCACHE_EXECUTABLE ccache)
set(_SINGZ_ANDROID_NATIVE_POOL_DEPTH ${SINGZ_ANDROID_NATIVE_MAX_JOBS})
if(SINGZ_ANDROID_CCACHE_EXECUTABLE)
    if(CMAKE_HOST_WIN32)
        # PowerShell remains resident while ccache and clang run, so each edge
        # can contribute three matching process lines on Windows.
        math(EXPR _SINGZ_ANDROID_NATIVE_POOL_DEPTH
            "${SINGZ_ANDROID_NATIVE_MAX_JOBS} / 3")
        if(_SINGZ_ANDROID_NATIVE_POOL_DEPTH LESS 1)
            set(_SINGZ_ANDROID_NATIVE_POOL_DEPTH 1)
        endif()
        set(_SINGZ_ANDROID_CCACHE_LAUNCHER
            "powershell.exe;-NoProfile;-NonInteractive;-ExecutionPolicy;Bypass;-File;${CMAKE_CURRENT_LIST_DIR}/android-ccache-launcher.ps1;${SINGZ_ANDROID_CCACHE_EXECUTABLE};${SINGZ_ANDROID_REPO_ROOT}")
    else()
        # The POSIX launcher execs ccache, leaving only ccache + clang visible.
        math(EXPR _SINGZ_ANDROID_NATIVE_POOL_DEPTH
            "${SINGZ_ANDROID_NATIVE_MAX_JOBS} / 2")
        if(_SINGZ_ANDROID_NATIVE_POOL_DEPTH LESS 1)
            set(_SINGZ_ANDROID_NATIVE_POOL_DEPTH 1)
        endif()
        set(_SINGZ_ANDROID_CCACHE_LAUNCHER
            "/bin/sh;${CMAKE_CURRENT_LIST_DIR}/android-ccache-launcher.sh;${SINGZ_ANDROID_CCACHE_EXECUTABLE};${SINGZ_ANDROID_REPO_ROOT}")
    endif()
    set(CMAKE_C_COMPILER_LAUNCHER "${_SINGZ_ANDROID_CCACHE_LAUNCHER}"
        CACHE STRING "SingZ Android C compiler launcher" FORCE)
    set(CMAKE_CXX_COMPILER_LAUNCHER "${_SINGZ_ANDROID_CCACHE_LAUNCHER}"
        CACHE STRING "SingZ Android C++ compiler launcher" FORCE)

    # find_program() is a no-op for an already-defined, non-NOTFOUND value;
    # OFF therefore keeps ReactNative-application.cmake from stacking its
    # global `ccache` rule while remaining false in its following if().
    set(CCACHE_FOUND OFF CACHE STRING
        "React Native ccache rule disabled; SingZ owns the launcher" FORCE)
else()
    unset(CMAKE_C_COMPILER_LAUNCHER CACHE)
    unset(CMAKE_CXX_COMPILER_LAUNCHER CACHE)
endif()

set_property(GLOBAL PROPERTY JOB_POOLS
    singz_android_native_pool=${_SINGZ_ANDROID_NATIVE_POOL_DEPTH})
set(CMAKE_JOB_POOL_COMPILE singz_android_native_pool)
set(CMAKE_JOB_POOL_LINK singz_android_native_pool)
