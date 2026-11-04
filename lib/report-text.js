// 보고서 본문 추출과 코드 제거 — 훅 스크립트와 서버가 함께 씁니다.
const fs = require('fs');

const MAX_REPORT = 60_000;

// 코드 블록(``` 또는 ~~~ 로 감싼 부분)을 "[코드 생략 · java · 24줄]" 한 줄로 바꿉니다.
// 본문 중의 짧은 인라인 코드(`OrderService` 같은 이름)는 남겨둡니다.
function stripCode(text) {
  if (!text) return '';
  const lines = String(text).replace(/\r/g, '').split('\n');
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^\s*(`{3,}|~{3,})\s*([\w+#.-]*)/);
    if (!m) { out.push(lines[i]); continue; }
    const fence = m[1];
    const lang = m[2];
    let n = 0;
    i++;
    while (i < lines.length && !lines[i].trim().startsWith(fence)) { n++; i++; }
    out.push(`[코드 생략${lang ? ` · ${lang}` : ''} · ${n}줄]`);
  }
  return out.join('\n');
}

// 툴 응답(JSON 구조가 버전마다 조금씩 다름)에서 사람이 읽는 텍스트만 뽑습니다.
function extractText(v, depth = 0) {
  if (v == null || depth > 6) return '';
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) return v.map((x) => extractText(x, depth + 1)).filter(Boolean).join('\n\n');
  if (typeof v === 'object') {
    if (v.type === 'text' && typeof v.text === 'string') return v.text;
    if (v.type && v.type !== 'text' && !('content' in v)) return '';
    for (const k of ['content', 'result', 'output', 'text', 'response', 'message']) {
      if (k in v) {
        const t = extractText(v[k], depth + 1);
        if (t) return t;
      }
    }
  }
  return '';
}

// 트랜스크립트(JSONL) 끝부분에서 마지막 답변 텍스트를 찾습니다. 파일이 커도 끝 2MB만 읽습니다.
function lastAssistantText(file) {
  if (!file || !fs.existsSync(file)) return '';
  let tail;
  try {
    const fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    const len = Math.min(size, 2 * 1024 * 1024);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    fs.closeSync(fd);
    tail = buf.toString('utf8');
  } catch {
    return '';
  }
  const lines = tail.split('\n');
  const texts = [];
  for (let i = lines.length - 1; i >= 0; i--) {
    let e;
    try { e = JSON.parse(lines[i]); } catch { continue; }
    if (e.isSidechain) continue;
    if (e.type === 'user') break;          // 직전 사용자 입력·툴 결과까지만
    if (e.type !== 'assistant') continue;
    const content = e.message && e.message.content;
    const t = typeof content === 'string' ? content : extractText(
      Array.isArray(content) ? content.filter((b) => b && b.type === 'text') : '');
    if (t) texts.unshift(t);
  }
  return texts.join('\n\n');
}

const clipReport = (s) => (s && s.length > MAX_REPORT ? s.slice(0, MAX_REPORT) + '\n\n…(이하 생략)' : s || '');

module.exports = { stripCode, extractText, lastAssistantText, clipReport };

// ───────── 첨부파일 찾기 ─────────
// 보고서 본문에서 파일 경로처럼 보이는 것(마크다운 링크, `경로`, 그냥 쓴 경로)을 모두 후보로 뽑은 뒤
// 프로젝트 폴더 안에 실제로 존재하는 파일만 첨부로 남깁니다.
const path = require('path');

function findAttachments(text, cwd, limit = 20) {
  if (!text || !cwd) return [];
  const root = path.resolve(cwd);
  const tokens = String(text).split(/[\s`'"()<>\[\]{}가-힣ㄱ-ㅎㅏ-ㅣ,;|*]+/);
  const found = new Map();
  for (let t of tokens) {
    if (!t || t.length > 260 || t.includes('://')) continue;
    t = t.replace(/#L\d+(-L?\d+)?$/i, '').replace(/(:\d+){1,2}$/, '').replace(/[.:!?]+$/, '');
    if (!/\.[A-Za-z][A-Za-z0-9]{0,7}$/.test(t)) continue;
    const abs = path.resolve(root, t.replace(/^\.\//, ''));
    const rel = path.relative(root, abs);
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) continue;
    const key = rel.replace(/\\/g, '/');
    if (found.has(key)) continue;
    try { if (fs.statSync(abs).isFile()) found.set(key, true); } catch { /* 없는 파일 */ }
    if (found.size >= limit) break;
  }
  return [...found.keys()];
}

module.exports.findAttachments = findAttachments;
