; Agent Office 설치 프로그램 (NSIS)
Unicode true
ManifestDPIAware true
!include "MUI2.nsh"

!define APPNAME "Agent Office"
!define APPID "AgentOffice"
!define VERSION "1.0.0"
!define UNINST "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APPID}"

Name "${APPNAME}"
OutFile "AgentOffice-Setup-${VERSION}.exe"
InstallDir "$LOCALAPPDATA\Programs\AgentOffice"
InstallDirRegKey HKCU "Software\${APPID}" "InstallDir"
RequestExecutionLevel user
SetCompressor /SOLID lzma
BrandingText "${APPNAME} ${VERSION}"

VIProductVersion "${VERSION}.0"
VIAddVersionKey /LANG=1042 "ProductName" "${APPNAME}"
VIAddVersionKey /LANG=1042 "FileDescription" "${APPNAME} 설치 프로그램"
VIAddVersionKey /LANG=1042 "FileVersion" "${VERSION}"
VIAddVersionKey /LANG=1042 "ProductVersion" "${VERSION}"
VIAddVersionKey /LANG=1042 "LegalCopyright" "Agent Office"

!define MUI_ICON "agent-office.ico"
!define MUI_UNICON "agent-office.ico"
!define MUI_ABORTWARNING
!define MUI_WELCOMEPAGE_TITLE "Agent Office 설치"
!define MUI_WELCOMEPAGE_TEXT "Claude Code 에이전트들이 부서별 픽셀 사무실에서 일하는 모습을 보여주는 대시보드입니다.$\r$\n$\r$\n설치하면 Claude Code 훅과 상태줄이 자동으로 설정됩니다. 기존 설정은 백업되고, 원래 쓰던 상태줄은 그대로 유지됩니다.$\r$\n$\r$\nNode.js가 함께 들어 있어서 따로 설치할 필요가 없습니다."
!define MUI_COMPONENTSPAGE_SMALLDESC
!define MUI_FINISHPAGE_TITLE "설치 완료"
!define MUI_FINISHPAGE_TEXT "Agent Office가 설치되었습니다.$\r$\n$\r$\n열려 있는 Claude Code와 Claude 앱을 다시 시작해야 에이전트들이 사무실에 출근합니다."
!define MUI_FINISHPAGE_RUN
!define MUI_FINISHPAGE_RUN_FUNCTION LaunchApp
!define MUI_FINISHPAGE_RUN_TEXT "지금 Agent Office 열기"

!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_COMPONENTS
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "Korean"

Function LaunchApp
  SetOutPath "$INSTDIR"
  Exec `"$INSTDIR\node.exe" "$INSTDIR\server.js" --open`
FunctionEnd

; 실행 중인 서버를 끈 뒤 파일을 교체 (업데이트 시 node.exe 가 잠겨 있지 않도록)
!macro STOP_SERVER
  IfFileExists "$INSTDIR\scripts\stop-server.js" 0 +3
    nsExec::Exec '"$INSTDIR\node.exe" "$INSTDIR\scripts\stop-server.js"'
    Sleep 1000
!macroend

Section "Agent Office (필수)" SecCore
  SectionIn RO
  SetOutPath "$INSTDIR"
  !insertmacro STOP_SERVER
  File /r "stage\*.*"

  WriteRegStr HKCU "Software\${APPID}" "InstallDir" "$INSTDIR"
  WriteUninstaller "$INSTDIR\uninstall.exe"

  ; 시작 메뉴
  CreateDirectory "$APPDATA\AgentOffice"
  CreateDirectory "$SMPROGRAMS\Agent Office"
  CreateShortCut "$SMPROGRAMS\Agent Office\Agent Office.lnk" "$INSTDIR\node.exe" '"$INSTDIR\server.js" --open' "$INSTDIR\agent-office.ico" 0
  CreateShortCut "$SMPROGRAMS\Agent Office\데이터 폴더 열기.lnk" "$APPDATA\AgentOffice"
  CreateShortCut "$SMPROGRAMS\Agent Office\사용 설명서.lnk" "$INSTDIR\README.md"
  CreateShortCut "$SMPROGRAMS\Agent Office\시뮬레이션 미리보기.lnk" "$INSTDIR\node.exe" '"$INSTDIR\scripts\simulate.js"' "$INSTDIR\agent-office.ico" 0
  CreateShortCut "$SMPROGRAMS\Agent Office\Agent Office 제거.lnk" "$INSTDIR\uninstall.exe"

  ; Claude Code 훅·상태줄 설정 (+ 예전 zip 버전 데이터 옮겨오기)
  DetailPrint "Claude Code 훅과 상태줄을 설정하는 중..."
  nsExec::ExecToLog '"$INSTDIR\node.exe" "$INSTDIR\scripts\install-hooks.js"'
  Pop $0
  StrCmp $0 "0" +2
    MessageBox MB_ICONEXCLAMATION "Claude Code 설정을 자동으로 바꾸지 못했습니다.$\r$\n설치 후 시작 메뉴의 사용 설명서를 참고해 수동으로 설정해주세요."

  ; 프로그램 추가/제거 목록
  WriteRegStr HKCU "${UNINST}" "DisplayName" "${APPNAME}"
  WriteRegStr HKCU "${UNINST}" "DisplayVersion" "${VERSION}"
  WriteRegStr HKCU "${UNINST}" "Publisher" "Agent Office"
  WriteRegStr HKCU "${UNINST}" "DisplayIcon" "$INSTDIR\agent-office.ico"
  WriteRegStr HKCU "${UNINST}" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "${UNINST}" "UninstallString" '"$INSTDIR\uninstall.exe"'
  WriteRegDWORD HKCU "${UNINST}" "NoModify" 1
  WriteRegDWORD HKCU "${UNINST}" "NoRepair" 1
  WriteRegDWORD HKCU "${UNINST}" "EstimatedSize" 90000
SectionEnd

Section "바탕화면 바로가기" SecDesktop
  CreateShortCut "$DESKTOP\Agent Office.lnk" "$INSTDIR\node.exe" '"$INSTDIR\server.js" --open' "$INSTDIR\agent-office.ico" 0
SectionEnd

Section /o "Windows 시작할 때 자동 실행" SecStartup
  CreateShortCut "$SMSTARTUP\Agent Office.lnk" "$INSTDIR\node.exe" '"$INSTDIR\server.js"' "$INSTDIR\agent-office.ico" 0 SW_SHOWMINIMIZED
SectionEnd

LangString DESC_Core ${LANG_KOREAN} "대시보드 프로그램과 Node.js 실행 파일. Claude Code 훅과 상태줄을 설정합니다."
LangString DESC_Desktop ${LANG_KOREAN} "바탕화면에 Agent Office 바로가기를 만듭니다."
LangString DESC_Startup ${LANG_KOREAN} "Windows에 로그인하면 Agent Office 서버를 최소화된 창으로 켜둡니다."
!insertmacro MUI_FUNCTION_DESCRIPTION_BEGIN
  !insertmacro MUI_DESCRIPTION_TEXT ${SecCore} $(DESC_Core)
  !insertmacro MUI_DESCRIPTION_TEXT ${SecDesktop} $(DESC_Desktop)
  !insertmacro MUI_DESCRIPTION_TEXT ${SecStartup} $(DESC_Startup)
!insertmacro MUI_FUNCTION_DESCRIPTION_END

Section "Uninstall"
  !insertmacro STOP_SERVER
  ; Claude Code 설정 되돌리기 (Agent Office 훅 제거, 원래 상태줄 복원)
  nsExec::ExecToLog '"$INSTDIR\node.exe" "$INSTDIR\scripts\uninstall-hooks.js"'

  Delete "$DESKTOP\Agent Office.lnk"
  Delete "$SMSTARTUP\Agent Office.lnk"
  RMDir /r "$SMPROGRAMS\Agent Office"

  ; 설치한 파일만 지움 (설치 폴더를 통째로 지우지 않도록)
  RMDir /r "$INSTDIR\lib"
  RMDir /r "$INSTDIR\hooks"
  RMDir /r "$INSTDIR\scripts"
  RMDir /r "$INSTDIR\public"
  RMDir /r "$INSTDIR\docs"
  Delete "$INSTDIR\node.exe"
  Delete "$INSTDIR\server.js"
  Delete "$INSTDIR\package.json"
  Delete "$INSTDIR\departments.json"
  Delete "$INSTDIR\README.md"
  Delete "$INSTDIR\agent-office.ico"
  Delete "$INSTDIR\.installed"
  Delete "$INSTDIR\uninstall.exe"
  RMDir "$INSTDIR"

  MessageBox MB_YESNO|MB_ICONQUESTION "보고서, 부서 설정, 사용량 기록도 삭제할까요?$\r$\n($APPDATA\AgentOffice)$\r$\n$\r$\n'아니요'를 누르면 나중에 다시 설치했을 때 그대로 이어서 쓸 수 있습니다." /SD IDNO IDNO keepdata
    RMDir /r "$APPDATA\AgentOffice"
  keepdata:

  DeleteRegKey HKCU "${UNINST}"
  DeleteRegKey HKCU "Software\${APPID}"
SectionEnd
