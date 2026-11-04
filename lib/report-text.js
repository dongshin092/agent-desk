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
// 보고서 본문에서 파일처럼 보이는 것(마크다운 링크, `경로`, 그냥 쓴 경로나 파일 이름)을 후보로 뽑고
// 프로젝트 폴더 안에 실제로 있는 파일만 첨부로 남깁니다.
// 폴더 없이 이름만 적힌 경우(ddl_faq.sql)는
//   1) 이 세션에서 에이전트가 만들거나 고친 파일 중 같은 이름을 먼저 찾고
//   2) 없으면 프로젝트 폴더 안을 검색해 같은 이름의 파일을 찾습니다 (여러 개면 가장 최근 수정본).
const path = require('path');

const SKIP_DIRS = new Set(['node_modules', '.git', '.svn', '.idea', '.vscode', '.gradle', 'build', 'target',
  'dist', 'out', 'bin', 'obj', '.next', '.nuxt', 'coverage', 'venv', '.venv', '__pycache__', '.cache']);
const HANGUL = /[가-힣ㄱ-ㅎㅏ-ㅣ]+/;
const sameName = process.platform === 'win32'
  ? (a, b) => a.toLowerCase() === b.toLowerCase()
  : (a, b) => a === b;

const treeCache = new Map(); // root → { at, files: [절대경로] }
function projectFiles(root) {
  const hit = treeCache.get(root);
  if (hit && Date.now() - hit.at < 15_000) return hit.files;
  const files = [];
  const walk = (dir, depth) => {
    if (depth > 10 || files.length >= 30_000) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) walk(path.join(dir, e.name), depth + 1); }
      else if (e.isFile()) files.push(path.join(dir, e.name));
    }
  };
  walk(root, 0);
  treeCache.set(root, { at: Date.now(), files });
  return files;
}

function newest(paths) {
  let best = null, bestT = -1;
  for (const p of paths) {
    try { const t = fs.statSync(p).mtimeMs; if (t > bestT) { bestT = t; best = p; } } catch { /* 없는 파일 */ }
  }
  return best;
}

function insideRel(root, abs) {
  const rel = path.relative(root, abs);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return rel.replace(/\\/g, '/');
}

function findAttachments(text, cwd, { touched = [], limit = 20 } = {}) {
  if (!text || !cwd) return [];
  const root = path.resolve(cwd);
  const tokens = String(text).split(/[\s`'"()<>\[\]{},;|*]+/);
  const found = new Set();
  for (let t of tokens) {
    if (found.size >= limit) break;
    t = t.replace(new RegExp(`^${HANGUL.source}`), '').replace(new RegExp(`${HANGUL.source}$`), '');  // "plan.md에" → "plan.md"
    t = t.replace(/#L\d+(-L?\d+)?$/i, '').replace(/(:\d+){1,2}$/, '').replace(/[.:!?]+$/, '');
    if (!t || t.length > 400 || t.includes('://')) continue;
    if (!/\.[A-Za-z][A-Za-z0-9]{0,7}$/.test(t)) continue;

    let abs = null;
    if (/[\\/]/.test(t)) {
      const p = path.resolve(root, t.replace(/^\.[\\/]/, ''));
      try { if (fs.statSync(p).isFile()) abs = p; } catch { /* 없음 */ }
    }
    if (!abs) {
      const name = path.basename(t.replace(/\\/g, '/'));
      // 1) 이 세션에서 다룬 파일 (가장 최근 것부터)
      for (let i = touched.length - 1; i >= 0 && !abs; i--) {
        const p = path.resolve(root, touched[i]);
        if (sameName(path.basename(p), name) && insideRel(root, p)) {
          try { if (fs.statSync(p).isFile()) abs = p; } catch { /* 없음 */ }
        }
      }
      // 2) 프로젝트 폴더 검색
      if (!abs) {
        const suffix = t.replace(/\\/g, '/').replace(/^\.\//, '');
        const matches = projectFiles(root).filter((p) => {
          const rel = p.replace(/\\/g, '/');
          return sameName(path.basename(p), name) && (suffix === name || rel.toLowerCase().endsWith('/' + suffix.toLowerCase()));
        });
        abs = matches.length === 1 ? matches[0] : newest(matches);
      }
    }
    const rel = abs && insideRel(root, abs);
    if (rel) found.add(rel);
  }
  return [...found];
}

module.exports.findAttachments = findAttachments;
