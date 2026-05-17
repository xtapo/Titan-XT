; NSIS installer hook for Titan-XT supervisor (Scheduled Task).
;
; electron-builder includes this via build.nsis.include. We register the
; LocalSystem scheduled task after files are copied, and remove it on
; uninstall. The launcher is ${INSTDIR}\${PRODUCT_FILENAME}.exe — the same
; Electron binary, with --install-service / --uninstall-service flags
; routed to ../service/service-install.ts via main/index.ts.
;
; Note: we use a Scheduled Task (not a Windows service) because the Node +
; koffi runtime cannot host a SCM ServiceMain reliably. See the comment in
; service-host.ts for the full reasoning.

!macro customInstall
  DetailPrint "Registering Titan-XT background supervisor..."

  ; Best-effort cleanup of any leftover from a previous install (covers
  ; users upgrading from the old SCM-based version too).
  ExecWait 'sc.exe stop TitanXTService' $0
  ExecWait 'sc.exe delete TitanXTService' $0
  ExecWait 'schtasks.exe /End /TN "TitanXTService" /F' $0
  ExecWait 'schtasks.exe /Delete /TN "TitanXTService" /F' $0

  ExecWait '"$INSTDIR\${PRODUCT_FILENAME}.exe" --install-service' $0
  ${If} $0 != 0
    DetailPrint "Supervisor install returned exit code $0 — continuing anyway"
  ${EndIf}
!macroend

!macro customUnInstall
  DetailPrint "Removing Titan-XT background supervisor..."
  ExecWait '"$INSTDIR\${PRODUCT_FILENAME}.exe" --uninstall-service' $0
  ${If} $0 != 0
    ; Fallback in case the binary is already gone.
    ExecWait 'schtasks.exe /End /TN "TitanXTService" /F' $0
    ExecWait 'schtasks.exe /Delete /TN "TitanXTService" /F' $0
  ${EndIf}
!macroend
