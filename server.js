// Agent Office 서버 — 외부 패키지 없이 Node 기본 모듈만 사용합니다.
// POST /events  : 훅이 보내는 Claude Code 이벤트 수신
// GET  /stream  : 브라우저로 실시간 상태 전송 (Server-Sent Events)
// GET  /state   : 현재 상태 스냅샷(JSON)

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.AGENT_OFFICE_PORT || 4000);
const HOST = '127.0.0.1'; // 이벤트에 파일 경로·명령어가 담기므로 내 PC에서만 접속 가능하게
const CONFIG_PATH = path.join(__dirname, 'departments.json');
const PUBLIC_DIR = path.join(__dirname, 'public');
const REPORTS_DIR = path.join(__dirname, 'reports');
const { stripCode, findAttachments } = require('./lib/report-text');

// ───────────────────────── 부서 설정 ─────────────────────────
let config = loadConfig();

fs.watchFile(CONFIG_PATH, { interval: 1000 }, () => {
  config = loadConfig();
  for (const a of agents.values()) {
    a.dept = a.role === 'lead' ? config.leadRoom : deptFor(a.type);
  }
  console.log('[설정] departments.json 을 다시 불러왔습니다.');
  scheduleBroadcast();
});

function loadConfig() {
  const reports = (r = {}) => ({
    enabled: r.enabled !== false,
    stripCode: r.stripCode !== false,
    leadMinLength: Number.isFinite(Number(r.leadMinLength)) ? Number(r.leadMinLength) : 200,
  });
  const fallback = { leadRoom: '팀장실', defaultDept: 'TF팀', departments: [], reports: reports() };
  try {
    const text = fs.readFileSync(CONFIG_PATH, 'utf8').replace(/^\uFEFF/, '');
    const c = JSON.parse(text);
    return {
      leadRoom: c.leadRoom || fallback.leadRoom,
      defaultDept: c.defaultDept || fallback.defaultDept,
      departments: Array.isArray(c.departments) ? c.departments : [],
      reports: reports(c.reports),
    };
  } catch (e) {
    console.error('[설정] departments.json 을 읽지 못해 기본값을 씁니다:', e.message);
    return fallback;
  }
}

function deptFor(agentType) {
  const t = String(agentType || '').toLowerCase();
  for (const d of config.departments) {
    if ((d.agents || []).some((a) => String(a).toLowerCase() === t)) return d.name;
  }
  return config.defaultDept;
}

// ───────────────────────── 상태 ─────────────────────────
const sessions = new Map(); // session_id → { id, project, cwd, lastActivity }
const agents = new Map();   // 내부 id → agent
const bySubagentId = new Map(); // Claude Code agent_id → 내부 id
const byToolUseId = new Map();  // Task/Agent 툴 호출 id → 내부 id
const touchedFiles = new Map(); // session_id → 이 세션에서 읽거나 만든·고친 파일 경로 (첨부 찾기용)

function rememberFile(sid, cwd, input) {
  const f = input && (input.file_path || input.notebook_path);
  if (!f) return;
  const abs = path.resolve(cwd || '.', f);
  const list = touchedFiles.get(sid) || [];
  const i = list.indexOf(abs);
  if (i >= 0) list.splice(i, 1);
  list.push(abs);
  if (list.length > 300) list.shift();
  touchedFiles.set(sid, list);
}
const log = [];
let logSeq = 0;
let agentSeq = 0;

const leadId = (sid) => `lead:${sid}`;

function projectName(cwd) {
  if (!cwd) return '팀장';
  return String(cwd).split(/[\\/]/).filter(Boolean).pop() || '팀장';
}

function ensureSession(sid, cwd) {
  let s = sessions.get(sid);
  if (!s) {
    s = { id: sid, cwd: cwd || '', project: projectName(cwd), lastActivity: Date.now() };
    sessions.set(sid, s);
    agents.set(leadId(sid), {
      id: leadId(sid), sessionId: sid, role: 'lead', type: 'lead',
      name: s.project, project: s.project, dept: config.leadRoom,
      status: 'idle', activity: 'idle', detail: '출근 완료',
      since: Date.now(), lastActivity: Date.now(),
    });
  } else if (cwd && !s.cwd) {
    s.cwd = cwd;
    s.project = projectName(cwd);
    const lead = agents.get(leadId(sid));
    if (lead) { lead.name = s.project; lead.project = s.project; }
  }
  return s;
}

function createMember(sid, type, extra = {}) {
  const session = sessions.get(sid);
  const id = `m${++agentSeq}`;
  const agent = {
    id, sessionId: sid, role: 'member', type: type || 'general-purpose',
    name: type || 'general-purpose', project: session ? session.project : '',
    dept: deptFor(type), status: 'working', activity: 'think', detail: '업무 파악 중',
    since: Date.now(), lastActivity: Date.now(), ...extra,
  };
  agents.set(id, agent);
  return agent;
}

function update(agent, patch) {
  if (!agent) return;
  Object.assign(agent, patch, { lastActivity: Date.now() });
}

function addLog(agent, text) {
  const entry = {
    id: ++logSeq, ts: Date.now(),
    who: agent ? agent.name : '시스템', dept: agent ? agent.dept : '', text,
  };
  log.push(entry);
  if (log.length > 300) log.shift();
  const t = new Date(entry.ts).toTimeString().slice(0, 8);
  console.log(`[${t}] ${entry.who} (${entry.dept}) ${text}`);
}

const clip = (s, n) => {
  s = String(s || '').replace(/\s+/g, ' ').trim();
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
};
const baseName = (p) => String(p || '').split(/[\\/]/).filter(Boolean).pop() || '';
const hostOf = (u) => { try { return new URL(u).host; } catch { return ''; } };

const isAgentTool = (name, input) =>
  (name === 'Task' || name === 'Agent') && input && ('subagent_type' in input || 'prompt' in input);

function describeTool(name = '', input = {}) {
  const mk = (activity, label, target = '') =>
    ({ activity, label, target, detail: target ? `${label} · ${target}` : label });
  const file = baseName(input.file_path || input.notebook_path || input.path);

  if (/^(Read|NotebookRead)$/.test(name)) return mk('read', '파일 읽기', file);
  if (name === 'Write') return mk('write', '파일 작성', file);
  if (/^(Edit|MultiEdit|NotebookEdit)$/.test(name)) return mk('write', '코드 수정', file);
  if (/^(Bash|PowerShell|BashOutput|KillShell|KillBash)$/.test(name))
    return mk('run', '명령 실행', clip(input.description || input.command, 36));
  if (/^(Grep|Glob|LS)$/.test(name)) return mk('search', '코드 검색', clip(input.pattern || input.path, 28));
  if (/^(WebFetch|WebSearch)$/.test(name)) return mk('web', '자료 조사', clip(input.query || hostOf(input.url), 28));
  if (isAgentTool(name, input)) return mk('delegate', '업무 지시', input.subagent_type || '');
  if (/^(TodoWrite|TaskCreate|TaskUpdate|TaskList|ExitPlanMode)$/.test(name)) return mk('plan', '할 일 정리');
  if (name.startsWith('mcp__')) {
    const [, server = 'MCP', ...rest] = name.split('__');
    return mk('tool', `${server} 사용`, rest.join('__'));
  }
  return mk('tool', `${name || '도구'} 사용`);
}

// 툴 이벤트를 누가 했는지 판단: 서브에이전트 안에서 발생하면 agent_id 가 함께 옵니다.
function actorFor(ev, sid) {
  if (ev.agent_id) {
    const id = bySubagentId.get(ev.agent_id);
    if (id && agents.has(id)) return agents.get(id);
    const created = createMember(sid, ev.agent_type);
    bySubagentId.set(ev.agent_id, created.id);
    addLog(created, '출근했습니다');
    return created;
  }
  return agents.get(leadId(sid));
}

function finishMember(agent, text = '업무 완료') {
  if (!agent || agent.status === 'done') return;
  update(agent, { status: 'done', activity: 'idle', detail: text, endedAt: Date.now() });
  addLog(agent, `${text} — 보고 후 퇴근`);
}


// ───────────────────────── 보고서함 ─────────────────────────
// reports/YYYYMM/<id>.md 로 저장합니다. 맨 위 머리말(---)에 보낸 사람·제목 등이 들어갑니다.
const READ_STATE = path.join(REPORTS_DIR, '.read.json');
const ID_RE = /^\d{8}-\d{6}-[a-z0-9]{4}$/;
let reportIndex = [];          // 최신순 메타데이터
let readIds = new Set();
let reportsVersion = 0;
let lastReport = null;

const reportFile = (id) => path.join(REPORTS_DIR, id.slice(0, 6), `${id}.md`);
const oneLine = (s) => String(s || '').replace(/\s+/g, ' ').trim();

function previewOf(body) {
  return clip(String(body)
    .replace(/\[코드 생략[^\]]*\]/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^[#>\-*|+\s]+/gm, '')
    .replace(/[`*_|]/g, ''), 140);
}

function parseReport(id, text) {
  const m = text.replace(/\r/g, '').match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!m) return null;
  const meta = { id };
  for (const line of m[1].split('\n')) {
    const k = line.indexOf(':');
    if (k > 0) meta[line.slice(0, k).trim()] = line.slice(k + 1).trim();
  }
  meta.ts = Date.parse(meta.date) || 0;
  try { meta.attachments = JSON.parse(meta.attachments || '[]'); } catch { meta.attachments = []; }
  if (!Array.isArray(meta.attachments)) meta.attachments = [];
  return { meta, body: m[2] };
}

function loadReports() {
  fs.mkdirSync(REPORTS_DIR, { recursive: true });
  try { readIds = new Set(JSON.parse(fs.readFileSync(READ_STATE, 'utf8')).read || []); } catch { readIds = new Set(); }
  const list = [];
  for (const dir of fs.readdirSync(REPORTS_DIR, { withFileTypes: true })) {
    if (!dir.isDirectory()) continue;
    for (const f of fs.readdirSync(path.join(REPORTS_DIR, dir.name))) {
      const id = f.replace(/\.md$/, '');
      if (!f.endsWith('.md') || !ID_RE.test(id)) continue;
      try {
        const r = parseReport(id, fs.readFileSync(reportFile(id), 'utf8'));
        if (r) list.push({ ...r.meta, preview: previewOf(r.body) });
      } catch { /* 깨진 파일은 건너뜀 */ }
    }
  }
  reportIndex = list.sort((a, b) => b.ts - a.ts);
  console.log(`[보고서함] 보고서 ${reportIndex.length}건을 불러왔습니다.`);
}

let readSaveTimer = null;
function saveReadState() {
  clearTimeout(readSaveTimer);
  readSaveTimer = setTimeout(() => {
    const valid = [...readIds].filter((id) => reportIndex.some((r) => r.id === id));
    fs.writeFile(READ_STATE, JSON.stringify({ read: valid }), () => {});
  }, 300);
}

function saveReport({ agent, subject, kind, body }) {
  if (!config.reports.enabled || !agent) return;
  let text = String(body || '').trim();
  if (config.reports.stripCode) text = stripCode(text);
  if (!text) return;

  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const id = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-` +
    `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}-` +
    Math.random().toString(36).slice(2, 6).padEnd(4, '0');
  const session = sessions.get(agent.sessionId);
  const cwd = session ? session.cwd : '';
  const attachments = findAttachments(text, cwd, { touched: touchedFiles.get(agent.sessionId) || [] });
  const meta = {
    from: oneLine(agent.name), dept: oneLine(agent.dept), project: oneLine(agent.project),
    subject: oneLine(subject) || '업무 보고', kind, session: oneLine(agent.sessionId), date: d.toISOString(),
    cwd: oneLine(cwd),
  };
  const head = [...Object.entries(meta).map(([k, v]) => `${k}: ${v}`),
    `attachments: ${JSON.stringify(attachments)}`].join('\n');
  try {
    fs.mkdirSync(path.dirname(reportFile(id)), { recursive: true });
    fs.writeFileSync(reportFile(id), `---\n${head}\n---\n\n${text}\n`, 'utf8');
  } catch (e) {
    console.error('[보고서함] 저장 실패:', e.message);
    return;
  }
  reportIndex.unshift({ id, ...meta, attachments, ts: d.getTime(), preview: previewOf(text) });
  reportsVersion++;
  lastReport = { id, from: meta.from, kind, sessionId: agent.sessionId, ts: d.getTime() };
  addLog(agent, `보고서 제출: ${meta.subject}`);
}

function reportsSummary() {
  return {
    version: reportsVersion,
    total: reportIndex.length,
    unread: reportIndex.filter((r) => !readIds.has(r.id)).length,
    last: lastReport,
  };
}

loadReports();

function handleEvent(ev) {
  const name = ev.hook_event_name;
  const sid = ev.session_id || 'unknown';
  const session = ensureSession(sid, ev.cwd);
  session.lastActivity = Date.now();
  const lead = agents.get(leadId(sid));

  switch (name) {
    case 'SessionStart':
      update(lead, { status: 'idle', activity: 'idle', detail: '출근 완료' });
      addLog(lead, '출근했습니다');
      break;

    case 'UserPromptSubmit':
      update(lead, { status: 'working', activity: 'think', detail: '지시 검토 중', lastPrompt: clip(ev.prompt, 60) });
      addLog(lead, ev.prompt ? `새 지시 접수: ${clip(ev.prompt, 40)}` : '새 지시 접수');
      break;

    case 'PreToolUse': {
      const input = ev.tool_input || {};
      if (!ev.agent_id && isAgentTool(ev.tool_name, input)) {
        // 서브에이전트 출근 (SubagentStart 이벤트가 없는 버전도 대비)
        const member = createMember(sid, input.subagent_type, {
          pending: true, detail: clip(input.description, 30) || '업무 파악 중',
        });
        if (ev.tool_use_id) byToolUseId.set(ev.tool_use_id, member.id);
        addLog(member, `출근했습니다${input.description ? ` (${clip(input.description, 30)})` : ''}`);
      }
      if (/^(Write|Edit|MultiEdit|NotebookEdit|Read)$/.test(ev.tool_name || '')) rememberFile(sid, session.cwd, input);
      const actor = actorFor(ev, sid);
      const info = describeTool(ev.tool_name, input);
      update(actor, { status: 'working', activity: info.activity, detail: info.detail });
      addLog(actor, info.target ? `${info.label} · ${info.target}` : info.label);
      break;
    }

    case 'PostToolUse': {
      const input = ev.tool_input || {};
      if (!ev.agent_id && isAgentTool(ev.tool_name, input)) {
        const id = ev.tool_use_id && byToolUseId.get(ev.tool_use_id);
        const member = agents.get(id) || [...agents.values()].find((a) =>
          a.sessionId === sid && a.role === 'member' && a.status !== 'done' &&
          a.type.toLowerCase() === String(input.subagent_type || '').toLowerCase());
        if (ev.report_text) {
          saveReport({
            agent: member || { name: input.subagent_type || 'general-purpose', dept: deptFor(input.subagent_type), project: session.project, sessionId: sid },
            subject: input.description || '업무 보고', kind: 'member', body: ev.report_text,
          });
        }
        finishMember(member);
        if (ev.tool_use_id) byToolUseId.delete(ev.tool_use_id);
      }
      const actor = actorFor(ev, sid);
      if (actor && actor.status !== 'done') {
        update(actor, { status: 'working', activity: 'think', detail: '다음 작업 구상' });
      }
      break;
    }

    case 'SubagentStart': {
      if (!ev.agent_id || bySubagentId.has(ev.agent_id)) break;
      const type = String(ev.agent_type || 'general-purpose');
      // PreToolUse 에서 미리 만든 직원이 있으면 그 사람으로 연결
      const pending = [...agents.values()].find((a) =>
        a.sessionId === sid && a.pending && a.status !== 'done' &&
        a.type.toLowerCase() === type.toLowerCase());
      if (pending) {
        pending.pending = false;
        bySubagentId.set(ev.agent_id, pending.id);
      } else {
        const member = createMember(sid, type);
        bySubagentId.set(ev.agent_id, member.id);
        addLog(member, '출근했습니다');
      }
      break;
    }

    case 'SubagentStop': {
      const id = bySubagentId.get(ev.agent_id);
      finishMember(agents.get(id));
      break;
    }

    case 'Notification': {
      const msg = String(ev.message || '');
      const needsApproval = /permission|approve|허가|권한|승인/i.test(msg);
      update(lead, needsApproval
        ? { status: 'alert', activity: 'idle', detail: '결재 필요' }
        : { status: 'waiting', activity: 'idle', detail: '지시 대기' });
      addLog(lead, needsApproval ? `결재 요청: ${clip(msg, 50)}` : '다음 지시를 기다리는 중');
      break;
    }

    case 'Stop':
      update(lead, { status: 'waiting', activity: 'idle', detail: '보고 완료' });
      addLog(lead, '작업을 마치고 보고했습니다');
      if (ev.report_text && ev.report_text.length >= config.reports.leadMinLength) {
        saveReport({
          agent: lead, kind: 'lead', body: ev.report_text,
          subject: lead.lastPrompt ? `Re: ${lead.lastPrompt}` : '작업 보고',
        });
      }
      break;

    case 'SessionEnd':
      for (const a of agents.values()) {
        if (a.sessionId === sid) update(a, { status: 'done', activity: 'idle', detail: '퇴근', endedAt: Date.now() });
      }
      addLog(lead, '퇴근했습니다');
      break;

    default:
      break;
  }
  scheduleBroadcast();
}

// 주기 정리: 퇴근 처리, 오래 조용한 직원 휴식 처리, 버려진 세션 정리
setInterval(() => {
  const now = Date.now();
  let changed = false;
  for (const [id, a] of agents) {
    if (a.status === 'done' && a.endedAt && now - a.endedAt > 3500) {
      agents.delete(id);
      for (const [k, v] of bySubagentId) if (v === id) bySubagentId.delete(k);
      for (const [k, v] of byToolUseId) if (v === id) byToolUseId.delete(k);
      if (a.role === 'lead') { sessions.delete(a.sessionId); touchedFiles.delete(a.sessionId); }
      changed = true;
    } else if (a.status === 'working' && a.activity === 'think' && now - a.lastActivity > 90_000) {
      update(a, { status: 'idle', activity: 'idle', detail: '잠시 휴식' });
      changed = true;
    } else if (a.role === 'member' && now - a.lastActivity > 30 * 60_000) {
      agents.delete(id);
      changed = true;
    }
  }
  for (const [sid, s] of sessions) {
    if (now - s.lastActivity > 30 * 60_000) {
      sessions.delete(sid);
      touchedFiles.delete(sid);
      for (const [id, a] of agents) if (a.sessionId === sid) agents.delete(id);
      changed = true;
    }
  }
  if (changed) scheduleBroadcast();
}, 1000);

// ───────────────────────── 브라우저 전송 (SSE) ─────────────────────────
const clients = new Set();
let broadcastTimer = null;

function snapshot() {
  return {
    config: {
      leadRoom: config.leadRoom,
      defaultDept: config.defaultDept,
      departments: config.departments.map((d) => ({ name: d.name, color: d.color })),
    },
    agents: [...agents.values()].map(({ pending, lastPrompt, ...a }) => a),
    sessions: [...sessions.values()],
    log: log.slice(-80),
    reports: reportsSummary(),
  };
}

function scheduleBroadcast() {
  if (broadcastTimer) return;
  broadcastTimer = setTimeout(() => {
    broadcastTimer = null;
    const data = `data: ${JSON.stringify(snapshot())}\n\n`;
    for (const res of clients) res.write(data);
  }, 80);
}

setInterval(() => { for (const res of clients) res.write(': keep-alive\n\n'); }, 20_000);

// ───────────────────────── HTTP ─────────────────────────
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
};

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  if (req.method === 'POST' && url.pathname === '/events') {
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 1_000_000) req.destroy(); });
    req.on('end', () => {
      try { handleEvent(JSON.parse(body)); } catch (e) { console.error('[이벤트] 처리 실패:', e.message); }
      res.writeHead(204).end();
    });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/stream') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    res.write(`data: ${JSON.stringify(snapshot())}\n\n`);
    clients.add(res);
    req.on('close', () => clients.delete(res));
    return;
  }

  // 보고서함 API
  if (url.pathname === '/api/reports' && req.method === 'GET') {
    const list = reportIndex.map((r) => ({ ...r, read: readIds.has(r.id) }));
    res.writeHead(200, { 'Content-Type': MIME['.json'] }).end(JSON.stringify({ reports: list }));
    return;
  }

  // 첨부파일 다운로드: 보고서에 기록된 첨부 목록에 있는 파일만, 그 프로젝트 폴더 안에서만 내려줍니다.
  const fm = url.pathname.match(/^\/api\/reports\/([^/]+)\/file$/);
  if (fm && req.method === 'GET') {
    const id = decodeURIComponent(fm[1]);
    const meta = ID_RE.test(id) && reportIndex.find((r) => r.id === id);
    const rel = url.searchParams.get('path') || '';
    if (!meta || !meta.cwd || !meta.attachments.includes(rel)) { res.writeHead(404).end('첨부 목록에 없는 파일입니다.'); return; }
    const root = path.resolve(meta.cwd);
    const abs = path.resolve(root, rel);
    const inside = path.relative(root, abs);
    if (!inside || inside.startsWith('..') || path.isAbsolute(inside)) { res.writeHead(403).end(); return; }
    fs.stat(abs, (err, st) => {
      if (err || !st.isFile()) { res.writeHead(410, { 'Content-Type': 'text/plain; charset=utf-8' }).end('파일이 이동되었거나 삭제되었습니다.'); return; }
      const name = path.basename(abs);
      const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/"/g, '');
      res.writeHead(200, {
        'Content-Type': 'application/octet-stream',
        'Content-Length': st.size,
        'Content-Disposition': `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`,
      });
      fs.createReadStream(abs).pipe(res);
    });
    return;
  }
  const rm = url.pathname.match(/^\/api\/reports\/([^/]+)(\/read)?$/);
  if (rm) {
    const id = decodeURIComponent(rm[1]);
    const meta = ID_RE.test(id) && reportIndex.find((r) => r.id === id);
    if (!meta) { res.writeHead(404).end(); return; }

    if (!rm[2] && req.method === 'GET') {
      fs.readFile(reportFile(id), 'utf8', (err, text) => {
        if (err) { res.writeHead(404).end(); return; }
        const r = parseReport(id, text);
        // 열 때 첨부를 다시 찾아봅니다 (예전 버전에서 못 찾았던 첨부나, 나중에 생긴 파일 반영)
        if (r && meta.cwd) {
          const fresh = findAttachments(r.body, meta.cwd, { touched: touchedFiles.get(meta.session) || [] });
          const merged = [...new Set([...meta.attachments, ...fresh])];
          if (merged.length !== meta.attachments.length) {
            meta.attachments = merged;
            const line = `attachments: ${JSON.stringify(merged)}`;
            const updated = /^attachments: .*$/m.test(text)
              ? text.replace(/^attachments: .*$/m, line)
              : text.replace(/\n---\n/, `\n${line}\n---\n`);
            fs.writeFile(reportFile(id), updated, 'utf8', () => {});
            reportsVersion++;
            scheduleBroadcast();
          }
        }
        res.writeHead(200, { 'Content-Type': MIME['.json'] })
          .end(JSON.stringify({ ...meta, read: readIds.has(id), body: r ? r.body.trim() : '' }));
      });
      return;
    }
    if (rm[2] && req.method === 'POST') {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        let read = true;
        try { read = JSON.parse(body || '{}').read !== false; } catch {}
        if (read) readIds.add(id); else readIds.delete(id);
        saveReadState();
        reportsVersion++;
        scheduleBroadcast();
        res.writeHead(204).end();
      });
      return;
    }
    if (!rm[2] && req.method === 'DELETE') {
      fs.unlink(reportFile(id), () => {
        reportIndex = reportIndex.filter((r) => r.id !== id);
        readIds.delete(id);
        saveReadState();
        reportsVersion++;
        scheduleBroadcast();
        res.writeHead(204).end();
      });
      return;
    }
    res.writeHead(405).end();
    return;
  }

  if (req.method === 'GET' && url.pathname === '/state') {
    res.writeHead(200, { 'Content-Type': MIME['.json'] }).end(JSON.stringify(snapshot()));
    return;
  }

  if (req.method === 'GET') {
    const rel = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname).replace(/^\/+/, '');
    const file = path.normalize(path.join(PUBLIC_DIR, rel));
    if (!file.startsWith(PUBLIC_DIR)) { res.writeHead(403).end(); return; }
    fs.readFile(file, (err, data) => {
      if (err) { res.writeHead(404).end('Not found'); return; }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' }).end(data);
    });
    return;
  }

  res.writeHead(405).end();
});

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.error(`\n포트 ${PORT} 이(가) 이미 사용 중입니다.`);
    console.error('이미 Agent Office 가 켜져 있는지 확인하거나, 다른 포트로 실행하세요:');
    console.error('  PowerShell:  $env:AGENT_OFFICE_PORT=4100; npm start');
    console.error('  (훅도 같은 포트를 쓰도록 사용자 환경변수 AGENT_OFFICE_PORT 를 설정해야 합니다)\n');
    process.exit(1);
  }
  throw e;
});

server.listen(PORT, HOST, () => {
  console.log('');
  console.log('  Agent Office 가 문을 열었습니다.');
  console.log(`  사무실 보기:  http://localhost:${PORT}`);
  console.log(`  보고서함:     http://localhost:${PORT}/#inbox  (파일: reports 폴더)`);
  console.log('  미리보기:     다른 터미널에서  npm run simulate');
  console.log('  종료:         Ctrl + C');
  console.log('');
});
