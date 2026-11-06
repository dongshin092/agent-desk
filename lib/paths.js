// 파일 위치 정리
// - zip 으로 풀어서 쓰는 경우: 모든 데이터를 프로그램 폴더에 둡니다.
// - 설치 프로그램으로 설치한 경우(.installed 파일이 있음): 보고서·설정·사용량은 %APPDATA%\AgentOffice 에 둡니다.
//   (프로그램 폴더는 업데이트할 때 덮어써지므로)
const fs = require('fs');
const path = require('path');
const os = require('os');

const ROOT = path.resolve(__dirname, '..');
const INSTALLED = fs.existsSync(path.join(ROOT, '.installed'));
const APPDATA = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
const DATA = process.env.AGENT_OFFICE_DATA || (INSTALLED ? path.join(APPDATA, 'AgentOffice') : ROOT);

try { fs.mkdirSync(DATA, { recursive: true }); } catch { /* 무시 */ }

const CONFIG = path.join(DATA, 'departments.json');
const DEFAULT_CONFIG = path.join(ROOT, 'departments.json');
if (DATA !== ROOT && !fs.existsSync(CONFIG)) {
  try { fs.copyFileSync(DEFAULT_CONFIG, CONFIG); } catch { /* 무시 */ }
}

module.exports = {
  ROOT, DATA, INSTALLED, CONFIG, DEFAULT_CONFIG,
  REPORTS: path.join(DATA, 'reports'),
  USAGE: path.join(DATA, 'usage-state.json'),
  PREV_STATUSLINE: path.join(DATA, 'statusline-previous.json'),
};
