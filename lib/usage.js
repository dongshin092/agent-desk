// 사용량 집계
// - 토큰: 세션 트랜스크립트(JSONL)의 assistant 메시지 usage 를 합산합니다. 서브에이전트 기록 파일도 포함.
//         같은 메시지가 여러 줄에 나뉘어 기록되므로 메시지 id 기준으로 중복을 없앱니다.
// - 5시간·주간 한도, 컨텍스트 사용률, 비용: Claude Code 의 statusLine 이 보내주는 값을 그대로 씁니다.
const fs = require('fs');
const path = require('path');
const { StringDecoder } = require('string_decoder');

const pad = (n) => String(n).padStart(2, '0');
const dayKey = (ts) => { const d = new Date(ts); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const toMs = (v) => {
  if (v == null || v === '') return null;
  if (typeof v === 'number') return v < 1e12 ? v * 1000 : v;
  const n = Number(v);
  if (Number.isFinite(n)) return n < 1e12 ? n * 1000 : n;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : null;
};
const emptyTokens = () => ({ input: 0, output: 0, cacheWrite: 0, cacheRead: 0 });

class UsageTracker {
  constructor(stateFile, { onText } = {}) {
    this.stateFile = stateFile;
    this.onText = onText || null; // (sessionId, 파일, 텍스트, sidechain여부) — 에이전트가 방금 쓴 문장
    this.sessions = new Map();
    this.rateLimits = null;
    this.today = dayKey(Date.now());
    this.todayById = {}; // 오늘 메시지 id → [입력, 출력, 캐시쓰기, 캐시읽기] (재시작해도 중복 집계되지 않도록 저장)
    this.saveTimer = null;
    try {
      const s = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
      this.rateLimits = s.rateLimits || null;
      if (s.day === this.today) this.todayById = s.todayById || {};
    } catch { /* 처음 실행 */ }
  }

  save() {
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      const data = { rateLimits: this.rateLimits, day: this.today, todayById: this.todayById };
      fs.writeFile(this.stateFile, JSON.stringify(data), () => {});
    }, 1000);
  }

  rollDay() {
    const k = dayKey(Date.now());
    if (k !== this.today) { this.today = k; this.todayById = {}; this.save(); }
  }

  session(sid) {
    let u = this.sessions.get(sid);
    if (!u) {
      u = { sid, files: new Map(), perId: new Map(), tokens: emptyTokens(), model: '', modelName: '', ctxPct: null, costUsd: null, lastRefresh: 0 };
      this.sessions.set(sid, u);
    }
    return u;
  }

  addFile(sid, file) {
    if (!file || typeof file !== 'string') return;
    const u = this.session(sid);
    if (!u.files.has(file)) u.files.set(file, { offset: 0, decoder: new StringDecoder('utf8'), rest: '' });
  }

  remove(sid) { this.sessions.delete(sid); }

  // 새로 추가된 줄만 읽습니다. 바뀐 게 있으면 true
  refresh(sid, force = false) {
    const u = this.sessions.get(sid);
    if (!u) return false;
    const now = Date.now();
    if (!force && now - u.lastRefresh < 1500) return false;
    u.lastRefresh = now;
    this.rollDay();
    // <세션id>.jsonl 옆의 <세션id>/subagents/*.jsonl (서브에이전트 기록) 도 찾아서 포함
    for (const f of [...u.files.keys()]) {
      if (!f.endsWith('.jsonl') || f.includes(`${path.sep}subagents${path.sep}`) || f.includes('/subagents/')) continue;
      const dir = path.join(path.dirname(f), path.basename(f, '.jsonl'), 'subagents');
      try { for (const n of fs.readdirSync(dir)) if (n.endsWith('.jsonl')) this.addFile(sid, path.join(dir, n)); } catch { /* 없음 */ }
    }
    let changed = false;
    for (const [file, st] of u.files) changed = this.readFile(u, file, st) || changed;
    return changed;
  }

  readFile(u, file, st) {
    let size;
    try { size = fs.statSync(file).size; } catch { return false; }
    if (size < st.offset) { st.offset = 0; st.rest = ''; st.decoder = new StringDecoder('utf8'); }
    if (size === st.offset) return false;
    let changed = false;
    let fd;
    try {
      fd = fs.openSync(file, 'r');
      while (st.offset < size) {
        const len = Math.min(size - st.offset, 4 * 1024 * 1024);
        const buf = Buffer.alloc(len);
        fs.readSync(fd, buf, 0, len, st.offset);
        st.offset += len;
        const lines = (st.rest + st.decoder.write(buf)).split('\n');
        st.rest = lines.pop();
        for (const line of lines) changed = this.ingest(u, line, file) || changed;
      }
    } catch { /* 읽기 실패는 다음에 다시 시도 */ } finally {
      if (fd !== undefined) try { fs.closeSync(fd); } catch { /* 무시 */ }
    }
    return changed;
  }

  ingest(u, line, file) {
    if (!line || line.indexOf('"usage"') < 0) return false;
    let e;
    try { e = JSON.parse(line); } catch { return false; }
    const msg = e && e.type === 'assistant' && e.message;
    // 방금(90초 이내) 쓴 문장만 말풍선으로 (서버 재시작 시 예전 기록이 한꺼번에 떠들지 않도록)
    if (msg && this.onText && Array.isArray(msg.content)) {
      const ts = Date.parse(e.timestamp) || 0;
      const text = msg.content.filter((b) => b && b.type === 'text' && b.text).map((b) => b.text).join(' ');
      if (text && Date.now() - ts < 90_000) {
        try { this.onText(u.sid, file, text, !!e.isSidechain); } catch { /* 무시 */ }
      }
    }
    const us = msg && msg.usage;
    if (!us) return false;
    const id = msg.id || e.requestId || e.uuid;
    if (!id) return false;
    const cur = [num(us.input_tokens), num(us.output_tokens), num(us.cache_creation_input_tokens), num(us.cache_read_input_tokens)];
    const prev = u.perId.get(id) || [0, 0, 0, 0];
    const next = cur.map((v, i) => Math.max(v, prev[i]));
    const delta = next.map((v, i) => v - prev[i]);
    u.perId.set(id, next);
    u.tokens.input += delta[0]; u.tokens.output += delta[1]; u.tokens.cacheWrite += delta[2]; u.tokens.cacheRead += delta[3];
    if (msg.model && !e.isSidechain && msg.model !== '<synthetic>') u.model = msg.model;

    if (dayKey(Date.parse(e.timestamp) || Date.now()) === this.today) {
      const p = this.todayById[id] || [0, 0, 0, 0];
      const n = next.map((v, i) => Math.max(v, p[i]));
      if (n.some((v, i) => v !== p[i])) { this.todayById[id] = n; this.save(); }
    }
    return delta.some((v) => v > 0);
  }

  applyStatusline(sid, data) {
    const u = this.session(sid);
    if (data.transcript_path) this.addFile(sid, data.transcript_path);
    if (data.model && data.model.display_name) u.modelName = String(data.model.display_name);
    const cw = data.context_window || {};
    if (cw.used_percentage != null) u.ctxPct = num(cw.used_percentage);
    if (data.cost && data.cost.total_cost_usd != null) u.costUsd = num(data.cost.total_cost_usd);
    const rl = data.rate_limits;
    if (rl && (rl.five_hour || rl.seven_day)) {
      const w = (x) => (x && x.used_percentage != null ? { pct: num(x.used_percentage), resetsAt: toMs(x.resets_at) } : null);
      this.rateLimits = { fiveHour: w(rl.five_hour), sevenDay: w(rl.seven_day), updatedAt: Date.now() };
      this.save();
    }
  }

  todayTotals() {
    this.rollDay();
    const t = emptyTokens();
    for (const v of Object.values(this.todayById)) {
      t.input += v[0]; t.output += v[1]; t.cacheWrite += v[2]; t.cacheRead += v[3];
    }
    return t;
  }

  sessionView(sid) {
    const u = this.sessions.get(sid);
    if (!u) return { model: '', ctxPct: null, costUsd: null, tokens: emptyTokens() };
    return { model: u.modelName || u.model, ctxPct: u.ctxPct, costUsd: u.costUsd, tokens: { ...u.tokens } };
  }
}

module.exports = { UsageTracker };
