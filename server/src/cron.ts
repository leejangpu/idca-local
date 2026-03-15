/**
 * Cron 스케줄러 — 모든 매매 트리거 등록
 * Firebase Cloud Functions onSchedule 대체
 */

// import cron from 'node-cron';

export function registerAllCrons(): void {
  console.log('[Cron] 스케줄러 등록 시작');

  // ==================== 국내 시장 (KST) ====================

  // 실사오팔 v2 — 매분 (09:00~15:30 KST = UTC 00:00~06:30)
  // cron.schedule('* 0-6 * * 1-5', () => runRealtimeV2KR(), { timezone: 'Asia/Seoul' });

  // 모멘텀 스캘핑 매수 — 매분 (09:00~15:20 KST)
  // cron.schedule('* 0-6 * * 1-5', () => runMomentumScalpBuyKR(), { timezone: 'Asia/Seoul' });

  // 모멘텀 스캘핑 매도 — 매분 (09:00~15:30 KST)
  // cron.schedule('* 0-6 * * 1-5', () => runMomentumScalpSellKR(), { timezone: 'Asia/Seoul' });

  // 장마감 처리 (KST 16:00 = UTC 07:00)
  // cron.schedule('0 7 * * 1-5', () => runMarketCloseKR());

  // ==================== 해외 시장 (US) ====================

  // 실사오팔 v2 해외 — 매분 (US 장중)
  // cron.schedule('* 22-23,0-6 * * 1-5', () => runRealtimeV2US());

  // 일봉 매매 (무한매수법/VR) — US 장 개시 후
  // cron.schedule('30 14 * * 1-5', () => runDailyTrading());

  // 장마감 해외 (EST 17:00 = UTC 22:00)
  // cron.schedule('0 22 * * 1-5', () => runMarketCloseUS());

  // ==================== 공통 ====================

  // 모닝 잔고 스냅샷 (KST 08:00 = UTC 23:00)
  // cron.schedule('0 23 * * *', () => runMorningSnapshot());

  // 스윙 매매 — 5분 주기 (09:00~15:30 KST)
  // cron.schedule('*/5 0-6 * * 1-5', () => runSwingTick(), { timezone: 'Asia/Seoul' });

  console.log('[Cron] 스케줄러 등록 완료 (TODO: 러너 구현 후 활성화)');
}
