// ~/.claude/settings.json 에 Agent Office 훅을 추가합니다.
// - 기존 설정은 그대로 두고 Agent Office 항목만 추가/갱신합니다.
// - 실행할 때마다 백업 파일을 만듭니다.
const { EVENTS, TOOL_EVENTS, command, settingsPath, readSettings, backup, stripOurs, writeSettings } = require('./hooks-common');

const settings = readSettings();
const backupPath = backup();
settings.hooks = stripOurs(settings.hooks || {});

for (const ev of EVENTS) {
  const hook = { type: 'command', command, timeout: 5 };
  const group = TOOL_EVENTS.has(ev) ? { matcher: '*', hooks: [hook] } : { hooks: [hook] };
  (settings.hooks[ev] ||= []).push(group);
}

writeSettings(settings);

console.log('');
console.log('  Agent Office 훅을 설치했습니다.');
console.log(`  설정 파일: ${settingsPath}`);
if (backupPath) console.log(`  백업:      ${backupPath}`);
console.log(`  훅 명령:   ${command}`);
console.log('');
console.log('  다음 단계');
console.log('  1. npm start (또는 start.bat) 로 서버를 켜세요.');
console.log('  2. 열려 있는 Claude Code 와 Claude 앱을 모두 다시 시작하세요.');
console.log('');
