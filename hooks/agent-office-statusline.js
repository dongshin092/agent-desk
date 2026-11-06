#!/usr/bin/env node
// Claude Code statusLine → Agent Office 서버로 사용량 정보를 전달하고, 터미널 하단 상태줄을 출력합니다.
// 설치 전에 쓰던 statusLine 이 있었다면 그 명령을 그대로 실행해서 그 출력을 보여줍니다.
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const PORT = process.env.AGENT_OFFICE_PORT || 4000;
const ENDPOINT = `http://127.0.0.1:${PORT}/statusline`;
const PREV_FILE = require('../lib/paths').PREV_STATUSLINE;

setTimeout(() => process.exit(0), 2500);

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => { raw += c; });
process.stdin.on('end', main);
process.stdin.on('error', () => process.exit(0));

function ownLine(d) {
  const parts = [];
  if (d.model && d.model.display_name) parts.push(d.model.display_name);
  const ctx = d.context_window && d.context_window.used_percentage;
  if (ctx != null) parts.push(`ctx ${Math.round(ctx)}%`);
  const rl = d.rate_limits || {};
  if (rl.five_hour && rl.five_hour.used_percentage != null) parts.push(`5h ${Math.round(rl.five_hour.used_percentage)}%`);
  if (rl.seven_day && rl.seven_day.used_percentage != null) parts.push(`주간 ${Math.round(rl.seven_day.used_percentage)}%`);
  return parts.join('  │  ');
}

function previousLine() {
  let prev;
  try { prev = JSON.parse(fs.readFileSync(PREV_FILE, 'utf8')); } catch { return null; }
  if (!prev || prev.type !== 'command' || !prev.command) return null;
  try {
    return execSync(prev.command, { input: raw, timeout: 2000, encoding: 'utf8', shell: true, windowsHide: true }).replace(/\s+$/, '');
  } catch {
    return null;
  }
}

async function main() {
  let data = {};
  try { data = JSON.parse(raw || '{}'); } catch { /* 무시 */ }

  // 서버 전송은 상태줄 출력을 늦추지 않도록 짧게
  const sent = fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
    signal: AbortSignal.timeout(400),
  }).catch(() => {});

  const line = previousLine();
  process.stdout.write((line != null ? line : ownLine(data)) + '\n');
  await sent;
  process.exit(0);
}
