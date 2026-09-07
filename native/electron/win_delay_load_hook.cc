// Windows Node-API addons link node.lib, whose import name is node.exe. The
// actual host can be renamed (Electron ships electron.exe), so resolve the
// delayed host import to the current process image. This follows node-gyp's
// win_delay_load_hook contract without coupling the addon to node-gyp itself.

#if defined(_MSC_VER)

#pragma managed(push, off)

#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif

#include <windows.h>
#include <delayimp.h>

#include <string.h>

namespace {

FARPROC WINAPI loadHostBinary(unsigned int event, DelayLoadInfo* info) {
  if (event != dliNotePreLoadLibrary ||
      _stricmp(info->szDll, HOST_BINARY) != 0) {
    return nullptr;
  }

  // Preserve compatibility with Node builds configured around libnode.dll;
  // Electron and ordinary executable hosts resolve through the process image.
  HMODULE module = GetModuleHandleW(L"libnode.dll");
  if (!module) module = GetModuleHandleW(nullptr);
  return reinterpret_cast<FARPROC>(module);
}

}  // namespace

decltype(__pfnDliNotifyHook2) __pfnDliNotifyHook2 = loadHostBinary;

#pragma managed(pop)

#endif
