/**
 * Cron 스케줄러 — 모든 매매 트리거 등록
 * 멀티 계좌: 등록된 모든 계좌에 대해 러너 실행
 */

import cron from 'node-cron';
import { runMomentumScalpBuyKR, runMomentumScalpSellKR } from './runners/momentumScalp';
import { runMarketCloseKR, runMarketCloseUS } from './runners/marketClose';
import { runDailyTrading } from './runners/trading';
import { runMorningSnapshot } from './runners/morning';
import { runRealtimeV2KR, runRealtimeV2US } from './runners/realtimeV2';
import { runSwingTradingLoop, runEodSetupScan, submitPendingOrders, checkPendingFills, cancelUnfilledOrders } from './runners/swingTrading';
import { getEnabledAccounts, AccountContext } from './lib/accountContext';
import type { SwingConfig } from './lib/swingCalculator';

async function forEachAccount(label: string, fn: (ctx: AccountContext) => Promise<unknown>): Promise<void> {
  const accounts = getEnabledAccounts();
  for (const ctx of accounts) {
    try {
      await fn(ctx);
    } catch (err) {
      console.error(`[Cron] ${label} error (${ctx.accountId}/${ctx.nickname}):`, err);
    }
  }
}

export function registerAllCrons(): void {
  console.log('[Cron] 스케줄러 등록 시작');

  // ==================== 국내 시장 (KST) ====================

  // 실사오팔 v2 — 매분 (09:00~15:30 KST)
  cron.schedule('*/1 0-6 * * 1-5', () => {
    forEachAccount('RealtimeV2KR', ctx => runRealtimeV2KR(ctx));
  }, { timezone: 'Asia/Seoul' });

  // 모멘텀 스캘핑 매수 — 매분 (09:00~15:20 KST)
  cron.schedule('*/1 0-6 * * 1-5', () => {
    forEachAccount('ScalpBuy', ctx => runMomentumScalpBuyKR(ctx));
  }, { timezone: 'Asia/Seoul' });

  // 모멘텀 스캘핑 매도 — 매분 (09:00~15:30 KST)
  cron.schedule('*/1 0-6 * * 1-5', () => {
    forEachAccount('ScalpSell', ctx => runMomentumScalpSellKR(ctx));
  }, { timezone: 'Asia/Seoul' });

  // 장마감 처리 KR (KST 16:00 = UTC 07:00)
  cron.schedule('0 7 * * 1-5', () => {
    forEachAccount('MarketCloseKR', ctx => runMarketCloseKR(ctx));
  });

  // ==================== 해외 시장 (US) ====================

  // 실사오팔 v2 해외 — 매분 (US 장중)
  cron.schedule('*/1 22-23,0-6 * * 1-5', () => {
    forEachAccount('RealtimeV2US', ctx => runRealtimeV2US(ctx));
  });

  // 일봉 매매 (무한매수법/VR) — US 장 개시 후 (UTC 14:30 = EST 09:30)
  cron.schedule('30 14 * * 1-5', () => {
    forEachAccount('DailyTrading', ctx => runDailyTrading(undefined, ctx));
  });

  // 장마감 해외 (EST 17:00 = UTC 22:00)
  cron.schedule('0 22 * * 1-5', () => {
    forEachAccount('MarketCloseUS', ctx => runMarketCloseUS(ctx));
  });

  // ==================== 공통 ====================

  // 모닝 잔고 스냅샷 (KST 08:00 = UTC 23:00)
  cron.schedule('0 23 * * *', () => {
    forEachAccount('MorningSnapshot', ctx => runMorningSnapshot(ctx));
  });

  // ==================== 스윙매매 (KST) ====================

  // 스윙 매매 루프 — 5분 주기 (09:00~15:30 KST)
  cron.schedule('*/5 0-6 * * 1-5', () => {
    forEachAccount('SwingLoop', ctx => runSwingTradingLoop(ctx));
  }, { timezone: 'Asia/Seoul' });

  // 스윙 EOD 스캔 — 매일 KST 17:00 (장마감 후 일봉 확정)
  cron.schedule('0 8 * * 1-5', () => {
    forEachAccount('SwingEodScan', ctx => runEodSetupScan(ctx));
  });

  // 스윙 주문 제출 — 매일 KST 08:50 (장 개시 10분 전)
  cron.schedule('50 23 * * 0-4', () => {
    forEachAccount('SwingSubmit', async ctx => {
      const shadow = ctx.store.getStrategyConfig<SwingConfig>('domestic', 'swing')?.shadowMode !== false;
      await submitPendingOrders(shadow, ctx);
    });
  });

  // 스윙 체결 확인 — 매일 KST 15:50 (장마감 20분 후, 데이터 확정 대기)
  cron.schedule('50 6 * * 1-5', () => {
    forEachAccount('SwingFills', async ctx => {
      const shadow = ctx.store.getStrategyConfig<SwingConfig>('domestic', 'swing')?.shadowMode !== false;
      await checkPendingFills(shadow, ctx);
    });
  });

  // 스윙 미체결 취소 — 매일 KST 15:55
  cron.schedule('55 6 * * 1-5', () => {
    forEachAccount('SwingCancel', async ctx => {
      const shadow = ctx.store.getStrategyConfig<SwingConfig>('domestic', 'swing')?.shadowMode !== false;
      await cancelUnfilledOrders(shadow, ctx);
    });
  });

  console.log('[Cron] 스케줄러 등록 완료 (멀티 계좌 지원)');
}
