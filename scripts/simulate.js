// Claude Code 없이 사무실이 어떻게 움직이는지 보여주는 시뮬레이터
// 사용법: npm run simulate        (한 번 실행)
//         npm run simulate -- --loop   (계속 반복)
const PORT = process.env.AGENT_OFFICE_PORT || 4000;
const ENDPOINT = `http://127.0.0.1:${PORT}/events`;
const LOOP = process.argv.includes('--loop');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fs = require('fs');
const os = require('os');
const path = require('path');

// 첨부파일 다운로드를 확인할 수 있도록 임시 폴더에 데모 프로젝트 파일을 만듭니다.
const DEMO = path.join(os.tmpdir(), 'agent-office-demo');
const SHOP = path.join(DEMO, 'shop-api');
const LMS = path.join(DEMO, 'lms-backend');
function writeDemo(root, rel, content) {
  const f = path.join(root, rel);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, content, 'utf8');
}
writeDemo(SHOP, 'docs/cancel-plan.md', '# 주문 취소 구현 계획\n\n- PAID, PREPARING 상태만 취소 가능\n- 환불은 refund() 재사용\n');
writeDemo(SHOP, 'src/main/java/com/example/order/OrderCancelController.java',
  'package com.example.order;\n\n// 데모용 파일입니다.\npublic class OrderCancelController {}\n');
writeDemo(LMS, 'docs/slow-query-analysis.md', '# 수강신청 조회 성능 분석\n\n1. N+1 쿼리\n2. course_id 인덱스 누락\n');
writeDemo(LMS, 'scripts/add_enrollment_index.sql', 'CREATE INDEX IX_ENROLLMENT_COURSE ON ENROLLMENT (COURSE_ID);\n');
let toolSeq = 0;

async function post(ev) {
  try {
    await fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...ev, ts: Date.now() }),
    });
  } catch {
    console.error(`서버(${ENDPOINT})에 연결할 수 없습니다. 먼저 npm start 로 서버를 켜세요.`);
    process.exit(1);
  }
}


const R = {
  planner: `## 주문 취소 요구사항 정리

결제 완료 후 **배송 시작 전**까지만 취소를 허용합니다.

| 주문 상태 | 취소 가능 | 처리 |
|---|---|---|
| PAID | 가능 | 전액 환불 |
| PREPARING | 가능 | 전액 환불, 출고 중지 |
| SHIPPED | 불가 | 반품 절차 안내 |

### 구현 계획
1. \`OrderStatus\`에 \`CANCELLED\` 추가
2. \`POST /api/orders/{id}/cancel\` 엔드포인트
3. 환불은 결제 모듈의 기존 \`refund()\` 재사용

계획 문서는 docs/cancel-plan.md 에 저장했습니다.`,

  backend: `## 취소 API 구현 완료

\`OrderCancelController\`와 서비스 로직을 추가했습니다.

\`\`\`java
@PostMapping("/api/orders/{id}/cancel")
public ResponseEntity<OrderResponse> cancel(@PathVariable Long id) {
    return ResponseEntity.ok(orderService.cancel(id));
}
\`\`\`

- 새 파일: [OrderCancelController.java](src/main/java/com/example/order/OrderCancelController.java)
- 상태 검증은 \`Order.cancel()\` 도메인 메서드 안에서 처리
- 테스트 12개 통과, 신규 테스트 4개 추가

> SHIPPED 상태에서 취소 요청 시 409를 반환합니다.`,

  frontend: `## 취소 버튼 UI 반영

주문 상세 화면에 취소 버튼을 추가했고, 상태가 PAID·PREPARING일 때만 노출됩니다.

\`\`\`jsx
{canCancel && <Button onClick={handleCancel}>주문 취소</Button>}
\`\`\`

빌드 정상 완료.`,

  reviewer: `## 코드 리뷰 결과

전반적으로 깔끔합니다. 아래 두 가지만 확인해주세요.

1. **환불 실패 시 롤백**: \`refund()\`가 예외를 던지면 주문 상태가 CANCELLED로 남을 수 있습니다. 같은 트랜잭션으로 묶는 게 좋겠습니다.
2. 취소 사유(\`reason\`)를 받지 않고 있습니다. CS 대응을 위해 저장을 권장합니다.

심각한 문제는 없어 머지해도 됩니다.`,

  explore: `## 수강신청 조회 코드 탐색 결과

\`EnrollmentRepository.findByCourseId\`가 화면당 여러 번 호출되고 있습니다.

- 강좌 목록 화면에서 강좌마다 개별 조회 (N+1 패턴)
- \`course_id\` 컬럼에 인덱스가 없음

\`\`\`sql
SELECT * FROM enrollment WHERE course_id = :id
\`\`\`

관련 파일: EnrollmentRepository.java, CourseListService.java`,

  leadShop: `주문 취소 기능 작업을 마쳤습니다.

## 요약
- 기획팀이 상태별 취소 정책을 정리했습니다 (배송 전까지만 취소 가능)
- 개발팀이 취소 API와 화면 버튼을 구현했고 테스트가 모두 통과했습니다
- 품질팀 리뷰에서 **환불 실패 시 롤백 처리**가 지적되어 트랜잭션으로 묶었습니다

## 남은 일
취소 사유 저장은 이번 범위에서 제외했습니다. 필요하면 다음 작업으로 진행하겠습니다.`,

  leadLms: `수강신청 조회가 느린 원인을 찾았습니다.

## 원인
1. 강좌 목록에서 강좌마다 수강 인원을 따로 조회하는 **N+1 쿼리**
2. \`enrollment.course_id\` 인덱스 누락

## 제안
| 방법 | 예상 효과 | 작업량 |
|---|---|---|
| course_id 인덱스 추가 | 단건 조회 수십 배 개선 | 작음 |
| 집계 쿼리 한 번으로 변경 | 호출 수 N → 1 | 보통 |

자세한 분석은 [slow-query-analysis.md](docs/slow-query-analysis.md)에, 인덱스 DDL은 \`scripts/add_enrollment_index.sql\`에 저장했습니다.

둘 다 적용하는 것을 권장합니다. 인덱스부터 먼저 반영할까요?`,
};

// 사용량 데모: 트랜스크립트에 토큰 사용 기록을 쌓고, statusLine 이 보내는 값도 흉내 냅니다.
const TRANSCRIPTS = path.join(DEMO, 'transcripts');
fs.mkdirSync(TRANSCRIPTS, { recursive: true });
let fiveHour = 18, sevenDay = 41, msgSeq = 0;
const now5h = Date.now() + (2 * 60 + 40) * 60000;
const nowWeek = Date.now() + 3 * 24 * 3600000;

function session(id, cwd) {
  const transcript = path.join(TRANSCRIPTS, `${id}.jsonl`);
  fs.writeFileSync(transcript, '');
  const base = { session_id: id, cwd, transcript_path: transcript };
  const send = (name, extra = {}) => post({ ...base, hook_event_name: name, ...extra });
  let ctx = 6, cost = 0;

  function useTokens(file, model, scale = 1, text = '') {
    const usage = {
      input_tokens: Math.round((30 + Math.random() * 400) * scale),
      output_tokens: Math.round((200 + Math.random() * 1600) * scale),
      cache_creation_input_tokens: Math.round((500 + Math.random() * 4000) * scale),
      cache_read_input_tokens: Math.round((8000 + Math.random() * 30000) * scale),
    };
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, JSON.stringify({
      type: 'assistant', timestamp: new Date().toISOString(),
      message: { id: `msg_sim_${++msgSeq}`, model, usage, content: text ? [{ type: 'text', text }] : [] },
    }) + '\n');
  }
  async function statusline() {
    ctx = Math.min(92, ctx + 1.5 + Math.random() * 3);
    cost += 0.02 + Math.random() * 0.08;
    fiveHour = Math.min(99, fiveHour + 0.4 + Math.random() * 0.6);
    sevenDay = Math.min(99, sevenDay + 0.05);
    try {
      await fetch(`http://127.0.0.1:${PORT}/statusline`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          session_id: id, transcript_path: transcript, workspace: { current_dir: cwd },
          model: { display_name: 'Opus' }, context_window: { used_percentage: ctx }, cost: { total_cost_usd: cost },
          rate_limits: { five_hour: { used_percentage: fiveHour, resets_at: Math.floor(now5h / 1000) },
            seven_day: { used_percentage: sevenDay, resets_at: Math.floor(nowWeek / 1000) } },
        }),
      });
    } catch { /* 무시 */ }
  }

  // say: 에이전트가 툴을 쓰기 전에 남기는 말 (실제 Claude Code 처럼 트랜스크립트에 기록 → 말풍선)
  async function tool(name, input, ms = 1600, agentId, agentType, sayText = '', extra = {}) {
    const tool_use_id = `sim_${++toolSeq}`;
    const who = agentId ? { agent_id: agentId, agent_type: agentType } : {};
    if (sayText) {
      const file = agentId ? path.join(TRANSCRIPTS, id, 'subagents', `agent-${agentId}.jsonl`) : transcript;
      useTokens(file, agentId ? 'claude-sonnet-4-5' : 'claude-opus-4-5', 0.2, sayText);
      await sleep(900);
    }
    await send('PreToolUse', { tool_name: name, tool_input: input, tool_use_id, ...who, ...extra });
    await sleep(ms);
    if (agentId) useTokens(path.join(TRANSCRIPTS, id, 'subagents', `agent-${agentId}.jsonl`), 'claude-sonnet-4-5', 0.6);
    else useTokens(transcript, 'claude-opus-4-5');
    await send('PostToolUse', { tool_name: name, tool_input: input, tool_use_id, ...who });
    await statusline();
    await sleep(350);
  }

  // 메인 에이전트가 서브에이전트에게 업무를 맡기는 흐름 (Task → SubagentStart → 작업 → SubagentStop)
  async function delegate(type, description, work, report) {
    const tool_use_id = `sim_${++toolSeq}`;
    const agentId = `${id}-${type}-${toolSeq}`;
    const input = { subagent_type: type, description, prompt: description };
    await send('PreToolUse', { tool_name: 'Task', tool_input: input, tool_use_id });
    await sleep(400);
    await send('SubagentStart', { agent_id: agentId, agent_type: type });
    await sleep(2600); // 자리까지 걸어가는 시간
    for (const [name, toolInput, ms, sayText] of work) await tool(name, toolInput, ms, agentId, type, sayText);
    await send('SubagentStop', { agent_id: agentId, agent_type: type });
    // 실제 훅은 툴 응답에서 보고서를 뽑아 report_text 로 보냅니다 (코드 블록은 서버에서도 한 번 더 제거)
    await send('PostToolUse', { tool_name: 'Task', tool_input: input, tool_use_id, report_text: report });
    await sleep(500);
  }

  return { send, tool, delegate, statusline };
}

async function shopApi() {
  const s = session('sim-shop', SHOP);
  await s.send('SessionStart', { source: 'startup' });
  await sleep(1500);
  await s.send('UserPromptSubmit', { prompt: '주문 취소 API 만들고 리뷰까지 받아줘' });
  await sleep(1200);
  await s.tool('TodoWrite', {}, 1200, undefined, undefined, '할 일부터 정리하고 기획팀에 넘기겠습니다.',
    { todo: { total: 4, done: 0, current: '취소 정책 정리 맡기기' } });
  await s.tool('Read', { file_path: path.join(SHOP, 'CLAUDE.md') }, 1400);

  await s.delegate('planner', '주문 취소 요구사항 정리', [
    ['Read', { file_path: 'docs/order-spec.md' }, 2000, '먼저 기존 주문 명세서를 읽어볼게요.'],
    ['Grep', { pattern: 'OrderStatus' }, 1600],
    ['Write', { file_path: 'docs/cancel-plan.md' }, 2400, '상태별 취소 정책을 표로 정리하겠습니다.'],
  ], R.planner);

  // 개발팀 두 명이 동시에 작업
  await Promise.all([
    s.delegate('backend-dev', '취소 API 구현', [
      ['Read', { file_path: 'src/main/java/com/example/order/OrderService.java' }, 1800, 'OrderService 구조부터 확인하겠습니다.'],
      ['Edit', { file_path: 'src/main/java/com/example/order/OrderService.java' }, 2600],
      ['Write', { file_path: 'src/main/java/com/example/order/OrderCancelController.java' }, 2800],
      ['Bash', { command: './gradlew test', description: 'gradle 테스트 실행' }, 4200, '구현 끝났으니 테스트를 돌려보겠습니다.'],
    ], R.backend),
    (async () => {
      await sleep(900);
      await s.delegate('frontend-dev', '취소 버튼 UI', [
        ['Read', { file_path: 'frontend/src/pages/OrderDetail.jsx' }, 1600],
        ['Edit', { file_path: 'frontend/src/pages/OrderDetail.jsx' }, 3000, '취소 가능 상태일 때만 버튼이 보이게 할게요.'],
        ['Bash', { command: 'npm run build', description: '프론트 빌드' }, 3600],
      ], R.frontend);
    })(),
  ]);

  await s.delegate('reviewer', '변경사항 코드 리뷰', [
    ['Bash', { command: 'git diff', description: '변경사항 확인' }, 1500],
    ['Read', { file_path: 'OrderCancelController.java' }, 2200],
    ['Grep', { pattern: '@Transactional' }, 1500, '트랜잭션 경계가 맞는지 확인해보겠습니다.'],
  ], R.reviewer);

  await s.send('Notification', { message: 'Claude needs your permission to use Bash' });
  await sleep(4000);
  await s.tool('Bash', { command: 'git commit -m "feat: 주문 취소"', description: '커밋' }, 1500);
  await s.send('Stop', { report_text: R.leadShop });
}

async function lmsBackend() {
  await sleep(5000);
  const s = session('sim-lms', LMS);
  await s.send('SessionStart', { source: 'startup' });
  await sleep(1200);
  await s.send('UserPromptSubmit', { prompt: '수강신청 쿼리 느린 원인 찾아줘' });
  await sleep(1000);
  await s.delegate('Explore', '수강신청 관련 코드 탐색', [
    ['Glob', { pattern: '**/*Enrollment*.java' }, 1500],
    ['Grep', { pattern: 'findByCourseId' }, 1800, '이 쿼리가 어디서 호출되는지 찾아볼게요.'],
    ['Read', { file_path: 'EnrollmentRepository.java' }, 2000],
  ], R.explore);
  await s.tool('WebSearch', { query: 'Oracle index skip scan' }, 2400, undefined, undefined, '인덱스 전략을 확인하기 위해 문서를 찾아보겠습니다.');
  await s.tool('mcp__notion__API-post-search', {}, 1800);
  await s.send('Stop', { report_text: R.leadLms });
  await sleep(6000);
  await s.send('SessionEnd', { reason: 'exit' });
}

(async () => {
  console.log(`시뮬레이션을 시작합니다 → ${ENDPOINT}`);
  do {
    await Promise.all([shopApi(), lmsBackend()]);
    console.log('한 바퀴 끝.');
    if (LOOP) await sleep(8000);
  } while (LOOP);
})();
