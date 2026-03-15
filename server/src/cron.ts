/**
 * Cron 스케줄러 — 모든 매매 트리거 등록
 * Firebase Cloud Functions onSchedule 대체
 */

import cron from 'node-cron';
import { runMomentumScalpBuyKR, runMomentumScalpSellKR } from './runners/momentumScalp';
import { runMarketCloseKR, runMarketCloseUS } from './runners/marketClose';
import { runDailyTrading } from './runners/trading';
import { runMorningSnapshot } from './runners/morning';
// import { runRealtimeV2KR, runRealtimeV2US } from './runners/realtimeV2'; // TODO: realtimeV2 변환 완료 후 활성화

export function registerAllCrons(): void {
  console.log('[Cron] 스케줄러 등록 시작');

  // ==================== 국내 시장 (KST) ====================

  // 실사오팔 v2 — 매분 (09:00~15:30 KST)
  // TODO: realtimeV2 변환 완료 후 활성화
  // cron.schedule('*/1 0-6 * * 1-5', () => runRealtimeV2KR(), { timezone: 'Asia/Seoul' });

  // 모멘텀 스캘핑 매수 — 매분 (09:00~15:20 KST)
  cron.schedule('*/1 0-6 * * 1-5', () => {
    runMomentumScalpBuyKR().catch(err => console.error('[Cron] ScalpBuy error:', err));
  }, { timezone: 'Asia/Seoul' });

  // 모멘텀 스캘핑 매도 — 매분 (09:00~15:30 KST)
  cron.schedule('*/1 0-6 * * 1-5', () => {
    runMomentumScalpSellKR().catch(err => console.error('[Cron] ScalpSell error:', err));
  }, { timezone: 'Asia/Seoul' });

  // 장마감 처리 KR (KST 16:00 = UTC 07:00)
  cron.schedule('0 7 * * 1-5', () => {
    runMarketCloseKR().catch(err => console.error('[Cron] MarketCloseKR error:', err));
  });

  // ==================== 해외 시장 (US) ====================

  // 실사오팔 v2 해외 — 매분 (US 장중)
  // TODO: realtimeV2 변환 완료 후 활성화
  // cron.schedule('*/1 22-23,0-6 * * 1-5', () => runRealtimeV2US());

  // 일봉 매매 (무한매수법/VR) — US 장 개시 후 (UTC 14:30 = EST 09:30)
  cron.schedule('30 14 * * 1-5', () => {
    runDailyTrading().catch(err => console.error('[Cron] DailyTrading error:', err));
  });

  // 장마감 해외 (EST 17:00 = UTC 22:00)
  cron.schedule('0 22 * * 1-5', () => {
    runMarketCloseUS().catch(err => console.error('[Cron] MarketCloseUS error:', err));
  });

  // ==================== 공통 ====================

  // 모닝 잔고 스냅샷 (KST 08:00 = UTC 23:00)
  cron.schedule('0 23 * * *', () => {
    runMorningSnapshot().catch(err => console.error('[Cron] MorningSnapshot error:', err));
  });

  console.log('[Cron] 스케줄러 등록 완료');
  console.log('[Cron] ⚠️ realtimeV2 러너는 변환 진행 중 — 활성화 대기');
}
