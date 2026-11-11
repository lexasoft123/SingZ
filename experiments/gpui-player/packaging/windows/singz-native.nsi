Unicode true
Name "SingZ Native"
OutFile "${OUTPUT}"
InstallDir "$LOCALAPPDATA\Programs\SingZ Native"
RequestExecutionLevel user
ShowInstDetails show
ShowUninstDetails show
!include "MUI2.nsh"
!include "${INCLUDE}"
!ifdef SIGN_PYTHON
!uninstfinalize '"${SIGN_PYTHON}" "${SIGN_SCRIPT}" --sign-uninstaller "%1"' = 0
!endif
!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "English"
!insertmacro MUI_LANGUAGE "Spanish"
!insertmacro MUI_LANGUAGE "Hindi"
!insertmacro MUI_LANGUAGE "Indonesian"
!insertmacro MUI_LANGUAGE "Japanese"
!insertmacro MUI_LANGUAGE "Korean"
!insertmacro MUI_LANGUAGE "Malay"
!insertmacro MUI_LANGUAGE "PortugueseBR"
!insertmacro MUI_LANGUAGE "Russian"
!insertmacro MUI_LANGUAGE "SimpChinese"
!insertmacro MUI_LANGUAGE "Thai"
!insertmacro MUI_LANGUAGE "TradChinese"
!insertmacro MUI_LANGUAGE "Turkish"
!insertmacro MUI_LANGUAGE "Vietnamese"
Section
  SetShellVarContext current
  SetOutPath "$INSTDIR"
  !insertmacro InstallPayload
  WriteUninstaller "$INSTDIR\Uninstall.exe"
  CreateDirectory "$SMPROGRAMS\SingZ Native"
  CreateShortcut "$SMPROGRAMS\SingZ Native\SingZ Native.lnk" "$INSTDIR\singz-gpui-player.exe"
  CreateShortcut "$DESKTOP\SingZ Native.lnk" "$INSTDIR\singz-gpui-player.exe"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\com.lexasoft.singz.native" "DisplayName" "SingZ Native"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\com.lexasoft.singz.native" "UninstallString" '"$INSTDIR\Uninstall.exe"'
  WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\com.lexasoft.singz.native" "NoModify" 1
  WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\com.lexasoft.singz.native" "NoRepair" 1
SectionEnd
Section "Uninstall"
  SetShellVarContext current
  Delete "$DESKTOP\SingZ Native.lnk"
  Delete "$SMPROGRAMS\SingZ Native\SingZ Native.lnk"
  RMDir "$SMPROGRAMS\SingZ Native"
  !insertmacro UninstallPayload
  Delete "$INSTDIR\Uninstall.exe"
  RMDir "$INSTDIR"
  DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\com.lexasoft.singz.native"
SectionEnd
