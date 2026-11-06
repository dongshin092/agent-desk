// ~/.claude/settings.json 에 Agent Office 훅을 추가합니다.
// - 기존 설정은 그대로 두고 Agent Office 항목만 추가/갱신합니다.
// - 실행할 때마다 백업 파일을 만듭니다.
const fs = require('fs');
const path = require('path');
const { PATHS, MARKER, SL_MARKER, EVENTS, TOOL_EVENTS, command, settingsPath, readSettings, backup, stripOurs, writeSettings,
  statuslineCommand, prevStatuslineFile, isOurStatusline } = require('./hooks-common');

const settings = readSettings();
const backupPath = backup();

// ── 예전 zip 버전에서 옮겨오기 ──
// 기존 설정에 다른 폴더의 Agent Office 훅이 있으면, 그 폴더의 보고서·부서 설정·사용량·원래 상태줄을 새 데이터 폴더로 복사합니다.
const migrated = [];
function oldRootFrom(cmd, marker) {
  const m = typeof cmd === 'string' && cmd.match(new RegExp(`"([^"]*)[\\\\/]hooks[\\\\/]${marker.replace('.', '\\.')}"`));
  return m ? path.resolve(m[1]) : null;
}
let oldRoot = oldRootFrom(settings.statusLine && settings.statusLine.command, SL_MARKER);
if (!oldRoot) {
  for (const groups of Object.values(settings.hooks || {})) {
    for (const g of Array.isArray(groups) ? groups : []) {
      for (const h of (g && g.hooks) || []) oldRoot = oldRoot || oldRootFrom(h.command, MARKER);
    }
  }
}
if (oldRoot && oldRoot !== PATHS.ROOT && oldRoot !== PATHS.DATA && fs.existsSync(oldRoot)) {
  const copyIfMissing = (name) => {
    const src = path.join(oldRoot, name), dst = path.join(PATHS.DATA, name);
    if (fs.existsSync(src) && !fs.existsSync(dst)) { fs.copyFileSync(src, dst); migrated.push(name); }
  };
  copyIfMissing('statusline-previous.json');
  copyIfMissing('usage-state.json');
  // 부서 설정: 새 데이터 폴더의 것이 아직 기본값 그대로일 때만 덮어씀
  const oldCfg = path.join(oldRoot, 'departments.json');
  try {
    const cur = fs.existsSync(PATHS.CONFIG) ? fs.readFileSync(PATHS.CONFIG, 'utf8') : '';
    const def = fs.readFileSync(PATHS.DEFAULT_CONFIG, 'utf8');
    if (fs.existsSync(oldCfg) && PATHS.CONFIG !== oldCfg && (!cur || cur === def)) {
      fs.copyFileSync(oldCfg, PATHS.CONFIG); migrated.push('departments.json');
    }
  } catch { /* 무시 */ }
  // 보고서: 없는 파일만 복사
  const oldReports = path.join(oldRoot, 'reports');
  if (fs.existsSync(oldReports) && oldReports !== PATHS.REPORTS) {
    let n = 0;
    const walk = (src, dst) => {
      fs.mkdirSync(dst, { recursive: true });
      for (const e of fs.readdirSync(src, { withFileTypes: true })) {
        const a = path.join(src, e.name), b = path.join(dst, e.name);
        if (e.isDirectory()) walk(a, b);
        else if (!fs.existsSync(b)) { fs.copyFileSync(a, b); n++; }
      }
    };
    walk(oldReports, PATHS.REPORTS);
    if (n) migrated.push(`보고서 ${n}개`);
  }
}
settings.hooks = stripOurs(settings.hooks || {});

for (const ev of EVENTS) {
  const hook = { type: 'command', command, timeout: 5 };
  const group = TOOL_EVENTS.has(ev) ? { matcher: '*', hooks: [hook] } : { hooks: [hook] };
  (settings.hooks[ev] ||= []).push(group);
}

// 사용량(5시간·주간 한도, 컨텍스트)을 받기 위한 statusLine.
// 이미 쓰던 statusLine 이 있으면 따로 보관해두고, Agent Office 상태줄이 그 명령을 대신 실행해 그대로 보여줍니다.
let keptStatusline = false;
if (settings.statusLine && !isOurStatusline(settings.statusLine)) {
  fs.writeFileSync(prevStatuslineFile, JSON.stringify(settings.statusLine, null, 2), 'utf8');
  keptStatusline = true;
}
settings.statusLine = { type: 'command', command: statuslineCommand, padding: 0 };

writeSettings(settings);

console.log('');
console.log('  Agent Office 훅을 설치했습니다.');
console.log(`  설정 파일: ${settingsPath}`);
if (backupPath) console.log(`  백업:      ${backupPath}`);
console.log(`  훅 명령:   ${command}`);
console.log(`  상태줄:    ${statuslineCommand}`);
if (keptStatusline) console.log('             (기존 statusLine 은 statusline-previous.json 에 보관했고 계속 그대로 표시됩니다)');
console.log(`  데이터:    ${PATHS.DATA}`);
if (migrated.length) console.log(`  옮겨옴:    ${oldRoot} 에서 ${migrated.join(', ')}`);
console.log('');
console.log('  다음 단계');
console.log('  1. npm start (또는 start.bat) 로 서버를 켜세요.');
console.log('  2. 열려 있는 Claude Code 와 Claude 앱을 모두 다시 시작하세요.');
console.log('');
