/**
 * 단타 v1 — 독립 실행 스크립트
 *
 * 서버 전체를 띄우지 않고 단타 워커만 단독 실행.
 *
 * 사용법:
 *   npx tsx server/src/scripts/runDantaWorker.ts
 *
 * pm2:
 *   pm2 start npx --name danta-worker -- tsx server/src/scripts/runDantaWorker.ts
 *
 * 종료: Ctrl+C (SIGINT) → graceful shutdown
 */

import { getEnabledAccounts } from '../lib/accountContext';
import { startDantaWorker, stopAllDantaWorkers } from '../runners/danta/dantaScheduler';

async function main() {
  console.log('=== 단타 v1 워커 시작 ===');

  const accounts = getEnabledAccounts();
  if (accounts.length === 0) {
    console.error('활성 계좌가 없습니다. 계좌 설정을 확인하세요.');
    process.exit(1);
  }

  for (const ctx of accounts) {
    console.log(`계좌 등록: ${ctx.accountId} (${ctx.nickname})`);
    startDantaWorker(ctx);
  }

  console.log(`총 ${accounts.length}개 계좌 워커 시작됨. Ctrl+C로 종료.`);

  // Graceful shutdown
  const shutdown = () => {
    console.log('\n=== 단타 v1 워커 종료 중... ===');
    stopAllDantaWorkers();
    console.log('=== 종료 완료 ===');
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  // 프로세스 유지
  await new Promise(() => {});
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
