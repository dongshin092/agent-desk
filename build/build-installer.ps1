# Agent Office 설치 프로그램 빌드 스크립트 (Windows)
# 준비: NSIS 설치 (https://nsis.sourceforge.io) — makensis 가 PATH 에 있거나 기본 경로에 설치되어 있으면 됩니다.
# 실행: PowerShell 에서  .\build\build-installer.ps1
# 결과: build\AgentOffice-Setup-<버전>.exe

$ErrorActionPreference = 'Stop'
$build = $PSScriptRoot
$root = Split-Path -Parent $build
$stage = Join-Path $build 'stage'
$nodeVersion = '22.23.3'   # 함께 넣을 Node.js 버전 (LTS)

Write-Host '1/4 파일 모으는 중...'
if (Test-Path $stage) { Remove-Item $stage -Recurse -Force }
New-Item -ItemType Directory $stage | Out-Null
foreach ($item in 'server.js', 'package.json', 'departments.json', 'README.md', 'lib', 'hooks', 'scripts', 'public', 'docs') {
  Copy-Item (Join-Path $root $item) $stage -Recurse
}

Write-Host "2/4 Node.js $nodeVersion 준비 중..."
$nodeCache = Join-Path $build "node-v$nodeVersion-win-x64.exe"
if (-not (Test-Path $nodeCache)) {
  Invoke-WebRequest "https://nodejs.org/dist/v$nodeVersion/win-x64/node.exe" -OutFile $nodeCache
}
$sig = Get-AuthenticodeSignature $nodeCache
if ($sig.Status -ne 'Valid' -or $sig.SignerCertificate.Subject -notmatch 'OpenJS Foundation') {
  throw "node.exe 서명을 확인할 수 없습니다 ($($sig.Status)). 파일을 지우고 다시 실행하세요: $nodeCache"
}
Copy-Item $nodeCache (Join-Path $stage 'node.exe')

Write-Host '3/4 설치 버전 표시 파일 추가...'
Copy-Item (Join-Path $build 'agent-office.ico') $stage
Set-Content (Join-Path $stage '.installed') 'installed'

Write-Host '4/4 설치 프로그램 만드는 중...'
$makensis = (Get-Command makensis -ErrorAction SilentlyContinue).Source
if (-not $makensis) { $makensis = Join-Path ${env:ProgramFiles(x86)} 'NSIS\makensis.exe' }
if (-not (Test-Path $makensis)) { throw 'makensis 를 찾을 수 없습니다. NSIS 를 먼저 설치하세요.' }
& $makensis (Join-Path $build 'installer.nsi')
if ($LASTEXITCODE -ne 0) { throw 'NSIS 빌드 실패' }
Write-Host "완료: $(Join-Path $build 'AgentOffice-Setup-*.exe')"
