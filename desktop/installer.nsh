!include "WordFunc.nsh"

!macro customInit
  ReadRegStr $0 HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${UNINSTALL_APP_KEY}" "DisplayVersion"
  StrCmp $0 "" deptriagem_init_done
  ${VersionCompare} "$0" "${VERSION}" $1
  StrCmp $1 1 0 deptriagem_init_done
  SetErrorLevel 1
  Abort "Uma versão mais recente do DepTriagem já está instalada."
deptriagem_init_done:
!macroend

!macro customRemoveFiles
  SetOutPath "$TEMP"
  !include "${BUILD_RESOURCES_DIR}\electron-install-files.nsh"
  Delete "$INSTDIR\${UNINSTALL_FILENAME}"
  RMDir "$INSTDIR"
!macroend
!macro customCheckAppRunning
deptriagem_check_app:
  ${nsProcess::FindProcess} "${APP_EXECUTABLE_FILENAME}" $R0
  StrCmp $R0 0 0 deptriagem_app_closed
  MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "Feche o DepTriagem antes de continuar. Se o monitor estiver na bandeja, escolha Sair do DepTriagem." /SD IDCANCEL IDRETRY deptriagem_check_app
  SetErrorLevel 2
  Quit
deptriagem_app_closed:
!macroend
