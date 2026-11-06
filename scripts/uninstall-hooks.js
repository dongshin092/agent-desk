// ~/.claude/settings.json 에서 Agent Office 훅만 제거합니다. 다른 훅은 건드리지 않습니다.
const fs = require('fs');
const { settingsPath, readSettings, backup, stripOurs, writeSettings, prevStatuslineFile, isOurStatusline } = require('./hooks-common');

if (!fs.existsSync(settingsPath)) {
  console.log('\n  settings.json 이 없어 제거할 훅이 없습니다.\n');
  process.exit(0);
}
const settings = readSettings();
const backupPath = backup();
const cleaned = stripOurs(settings.hooks || {});
if (Object.keys(cleaned).length) settings.hooks = cleaned; else delete settings.hooks;

// statusLine: 설치 전에 쓰던 것이 있으면 되돌리고, 없으면 제거
if (isOurStatusline(settings.statusLine)) {
  if (fs.existsSync(prevStatuslineFile)) {
    try { settings.statusLine = JSON.parse(fs.readFileSync(prevStatuslineFile, 'utf8')); } catch { delete settings.statusLine; }
    fs.unlinkSync(prevStatuslineFile);
  } else {
    delete settings.statusLine;
  }
}
writeSettings(settings);

console.log('\n  Agent Office 훅을 제거했습니다.');
if (backupPath) console.log(`  백업: ${backupPath}`);
console.log('  Claude Code 와 Claude 앱을 다시 시작하면 적용됩니다.\n');
