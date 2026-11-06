// 실행 중인 Agent Office 서버를 끕니다 (설치·업데이트·제거할 때 사용)
const PORT = process.env.AGENT_OFFICE_PORT || 4000;
fetch(`http://127.0.0.1:${PORT}/shutdown`, {
  method: 'POST',
  headers: { 'x-agent-office': 'shutdown' },
  signal: AbortSignal.timeout(1500),
}).catch(() => {}).finally(() => process.exit(0));
