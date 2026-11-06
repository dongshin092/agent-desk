// 훅 설치/제거 공통 로직
const fs = require('fs');
const path = require('path');
const os = require('os');

const EVENTS = ['SessionStart', 'SessionEnd', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse',
  'SubagentStart', 'SubagentStop', 'Notification', 'Stop'];
const TOOL_EVENTS = new Set(['PreToolUse', 'PostToolUse']);
const MARKER = 'agent-office-hook.js';

// 경로는 슬래시로 통일 (Git Bash / cmd / PowerShell 어디서 실행돼도 동작하도록)
const PATHS = require('../lib/paths');
// 설치 버전은 함께 설치된 node.exe 를 전체 경로로 지정 (PC 에 Node 가 없어도 동작)
const nodeCmd = PATHS.INSTALLED ? `"${process.execPath.replace(/\\/g, '/')}"` : 'node';
const hookPath = path.resolve(__dirname, '..', 'hooks', MARKER).replace(/\\/g, '/');
const command = `${nodeCmd} "${hookPath}"`;

const SL_MARKER = 'agent-office-statusline.js';
const statuslinePath = path.resolve(__dirname, '..', 'hooks', SL_MARKER).replace(/\\/g, '/');
const statuslineCommand = `${nodeCmd} "${statuslinePath}"`;
const prevStatuslineFile = PATHS.PREV_STATUSLINE;
const isOurStatusline = (sl) => sl && typeof sl.command === 'string' && sl.command.includes(SL_MARKER);

const settingsDir = path.join(os.homedir(), '.claude');
const settingsPath = path.join(settingsDir, 'settings.json');

function readSettings() {
  if (!fs.existsSync(settingsPath)) return {};
  const text = fs.readFileSync(settingsPath, 'utf8').replace(/^\uFEFF/, '').trim();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch (e) {
    console.error(`\n  ${settingsPath} 의 JSON 형식이 올바르지 않아 중단합니다.`);
    console.error(`  (${e.message})`);
    console.error('  파일을 고친 뒤 다시 실행하세요. 설정은 변경하지 않았습니다.\n');
    process.exit(1);
  }
}

function backup() {
  if (!fs.existsSync(settingsPath)) return null;
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  const dest = `${settingsPath}.agent-office-backup-${stamp}`;
  fs.copyFileSync(settingsPath, dest);
  return dest;
}

const isOurs = (h) => h && typeof h.command === 'string' && h.command.includes(MARKER);

function stripOurs(hooks) {
  const out = {};
  for (const [ev, groups] of Object.entries(hooks)) {
    if (!Array.isArray(groups)) { out[ev] = groups; continue; }
    const kept = groups
      .map((g) => (g && Array.isArray(g.hooks) ? { ...g, hooks: g.hooks.filter((h) => !isOurs(h)) } : g))
      .filter((g) => !(g && Array.isArray(g.hooks) && g.hooks.length === 0));
    if (kept.length) out[ev] = kept;
  }
  return out;
}

function writeSettings(settings) {
  fs.mkdirSync(settingsDir, { recursive: true });
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n', 'utf8');
}

module.exports = { PATHS, MARKER, SL_MARKER, EVENTS, TOOL_EVENTS, command, settingsPath, readSettings, backup, stripOurs, writeSettings,
  statuslineCommand, prevStatuslineFile, isOurStatusline };
