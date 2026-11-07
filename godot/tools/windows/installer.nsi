; installer.nsi — установщик 4tox для Windows x64.
;
; Собирается tools/package_windows.sh:
;   makensis -DAPP_VERSION=… -DSOURCE_DIR=… -DOUT_FILE=… -DICON_FILE=… installer.nsi
;
; Установка — в профиль пользователя, без UAC: %LOCALAPPDATA%\Programs\4tox.
; Рядом с 4tox.exe лежит server\ с game\, mapgen2\ и node.exe, поэтому
; отдельный Node.js игроку не нужен.

Unicode true

!include "MUI2.nsh"
!include "x64.nsh"
!include "WinVer.nsh"
!include "FileFunc.nsh"

!ifndef APP_VERSION
  !define APP_VERSION "0.2.0"
!endif
!ifndef SOURCE_DIR
  !error "Не задан SOURCE_DIR (каталог с 4tox.exe и server/)"
!endif
!ifndef OUT_FILE
  !error "Не задан OUT_FILE (путь к setup.exe)"
!endif
!ifndef ICON_FILE
  !define ICON_FILE "icon.ico"
!endif

!define APP_NAME "4tox"
!define APP_PUBLISHER "4tox"
!define APP_EXE "4tox.exe"
!define UNINST_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\4tox"

Name "${APP_NAME}"
OutFile "${OUT_FILE}"
InstallDir "$LOCALAPPDATA\Programs\4tox"
InstallDirRegKey HKCU "Software\4tox" "InstallDir"
RequestExecutionLevel user
SetCompressor /SOLID lzma
SetCompressorDictSize 64
BrandingText "${APP_NAME} ${APP_VERSION}"
ShowInstDetails show
ShowUninstDetails show

VIProductVersion "${APP_VERSION}.0"
VIAddVersionKey "ProductName" "${APP_NAME}"
VIAddVersionKey "ProductVersion" "${APP_VERSION}"
VIAddVersionKey "FileDescription" "Установщик 4tox"
VIAddVersionKey "FileVersion" "${APP_VERSION}.0"
VIAddVersionKey "CompanyName" "${APP_PUBLISHER}"
VIAddVersionKey "LegalCopyright" ""

!define MUI_ICON "${ICON_FILE}"
!define MUI_UNICON "${ICON_FILE}"
!define MUI_ABORTWARNING
!define MUI_FINISHPAGE_RUN "$INSTDIR\${APP_EXE}"
!define MUI_FINISHPAGE_RUN_TEXT "Запустить 4tox"
!define MUI_FINISHPAGE_LINK "Как играть и что делать с предупреждением Windows"
!define MUI_FINISHPAGE_LINK_LOCATION "$INSTDIR\README-WINDOWS.txt"

!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH

!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES

!insertmacro MUI_LANGUAGE "Russian"
!insertmacro MUI_LANGUAGE "English"

Function .onInit
  ${IfNot} ${RunningX64}
    MessageBox MB_ICONSTOP|MB_OK "4tox требует 64-битную Windows 10 или 11."
    Abort
  ${EndIf}
  ${IfNot} ${AtLeastWin10}
    MessageBox MB_ICONSTOP|MB_OK "4tox требует Windows 10 или 11."
    Abort
  ${EndIf}
FunctionEnd

Section "Игра 4tox" SEC_MAIN
  SectionIn RO
  SetOutPath "$INSTDIR"
  File /r "${SOURCE_DIR}/*"

  WriteUninstaller "$INSTDIR\Uninstall.exe"

  CreateDirectory "$SMPROGRAMS\4tox"
  CreateShortcut "$SMPROGRAMS\4tox\4tox.lnk" "$INSTDIR\${APP_EXE}" "" "$INSTDIR\${APP_EXE}" 0
  CreateShortcut "$SMPROGRAMS\4tox\Удалить 4tox.lnk" "$INSTDIR\Uninstall.exe"

  WriteRegStr HKCU "Software\4tox" "InstallDir" "$INSTDIR"
  WriteRegStr HKCU "${UNINST_KEY}" "DisplayName" "4tox — изометрическая деревня"
  WriteRegStr HKCU "${UNINST_KEY}" "DisplayVersion" "${APP_VERSION}"
  WriteRegStr HKCU "${UNINST_KEY}" "Publisher" "${APP_PUBLISHER}"
  WriteRegStr HKCU "${UNINST_KEY}" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "${UNINST_KEY}" "DisplayIcon" "$INSTDIR\${APP_EXE}"
  WriteRegStr HKCU "${UNINST_KEY}" "UninstallString" '"$INSTDIR\Uninstall.exe"'
  WriteRegStr HKCU "${UNINST_KEY}" "QuietUninstallString" '"$INSTDIR\Uninstall.exe" /S'
  WriteRegDWORD HKCU "${UNINST_KEY}" "NoModify" 1
  WriteRegDWORD HKCU "${UNINST_KEY}" "NoRepair" 1

  ${GetSize} "$INSTDIR" "/S=0K" $0 $1 $2
  IntFmt $0 "0x%08X" $0
  WriteRegDWORD HKCU "${UNINST_KEY}" "EstimatedSize" "$0"
SectionEnd

Section "Ярлык на рабочем столе" SEC_DESKTOP
  CreateShortcut "$DESKTOP\4tox.lnk" "$INSTDIR\${APP_EXE}" "" "$INSTDIR\${APP_EXE}" 0
SectionEnd

Section "Uninstall"
  ; Приложение могло остаться запущенным: закрываем его, но не трогаем
  ; чужие node.exe — сервер гасит сам супервизор при выходе.
  nsExec::Exec 'taskkill /IM "${APP_EXE}" /T /F'
  Pop $0

  Delete "$DESKTOP\4tox.lnk"
  Delete "$SMPROGRAMS\4tox\4tox.lnk"
  Delete "$SMPROGRAMS\4tox\Удалить 4tox.lnk"
  RMDir "$SMPROGRAMS\4tox"

  RMDir /r "$INSTDIR"

  DeleteRegKey HKCU "${UNINST_KEY}"
  DeleteRegKey HKCU "Software\4tox"

  ; В тихом режиме не спрашиваем: сохранения остаются, папка игры удаляется.
  IfSilent noSaves
  MessageBox MB_YESNO|MB_ICONQUESTION "Удалить сохранения и настройки 4tox ($APPDATA\Godot\app_userdata\4tox)?" IDNO noSaves
  RMDir /r "$APPDATA\Godot\app_userdata\4tox"
  noSaves:
SectionEnd
