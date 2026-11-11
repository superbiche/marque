; Tauri's NSIS template registers only UninstallString, so `winget uninstall`
; and other package managers open the interactive uninstaller.
!macro NSIS_HOOK_POSTINSTALL
  WriteRegStr SHCTX "${UNINSTKEY}" "QuietUninstallString" "$\"$INSTDIR\uninstall.exe$\" /S"
!macroend
