#!/usr/bin/env node
// Claude Code 훅 → Agent Office 서버로 이벤트를 전달합니다.
// 서버가 꺼져 있거나 오류가 나도 항상 exit 0 으로 끝나서 Claude Code 작업을 막지 않습니다.
// 표준출력에는 아무것도 쓰지 않으므로 Claude 의 컨텍스트(토큰)에 영향이 없습니다.

const fs = require('fs');
const path = require('path');
const { stripCode, extractText, lastAssistantText, clipReport } = require('../lib/report-text');

const PORT = process.env.AGENT_OFFICE_PORT || 4000;
const ENDPOINT = `http://127.0.0.1:${PORT}/events`;

// 시각화에 필요한 입력 필드만 남깁니다 (파일 내용, 코드 diff 등은 보내지 않음)
const KEEP = ['file_path', 'notebook_path', 'path', 'command', 'description', 'pattern',
  'url', 'query', 'subagent_type', 'prompt'];

setTimeout(() => process.exit(0), 3000);

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { raw += chunk; });
process.stdin.on('end', send);
process.stdin.on('error', () => process.exit(0));

function reportSettings() {
  try {
    const text = fs.readFileSync(path.join(__dirname, '..', 'departments.json'), 'utf8').replace(/^\uFEFF/, '');
    const r = JSON.parse(text).reports || {};
    return { enabled: r.enabled !== false, stripCode: r.stripCode !== false };
  } catch {
    return { enabled: true, stripCode: true };
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function reportText(ev) {
  const isDelegation = ev.hook_event_name === 'PostToolUse' && !ev.agent_id &&
    (ev.tool_name === 'Task' || ev.tool_name === 'Agent');
  if (isDelegation) return extractText(ev.tool_response);

  if (ev.hook_event_name === 'Stop') {
    if (typeof ev.last_assistant_message === 'string') return ev.last_assistant_message;
    let text = lastAssistantText(ev.transcript_path);
    if (!text) { await sleep(300); text = lastAssistantText(ev.transcript_path); }
    return text;
  }
  return '';
}

async function send() {
  try {
    const ev = JSON.parse(raw || '{}');

    const settings = reportSettings();
    if (settings.enabled) {
      let text = await reportText(ev);
      if (text) {
        if (settings.stripCode) text = stripCode(text);   // 코드는 여기서 잘라내 서버로 보내지 않음
        ev.report_text = clipReport(text.trim());
      }
    }

    delete ev.tool_response;
    delete ev.last_assistant_message;
    if (ev.tool_input && typeof ev.tool_input === 'object') {
      const slim = {};
      for (const key of KEEP) {
        const v = ev.tool_input[key];
        if (typeof v === 'string') slim[key] = v.length > 160 ? v.slice(0, 160) : v;
      }
      ev.tool_input = slim;
    }
    if (typeof ev.prompt === 'string' && ev.prompt.length > 160) ev.prompt = ev.prompt.slice(0, 160);

    await fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...ev, ts: Date.now() }),
      signal: AbortSignal.timeout(1000),
    });
  } catch {
    // 서버가 안 떠 있으면 조용히 무시
  }
  process.exit(0);
}
