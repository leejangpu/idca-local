/**
 * 단타 v2 — 전략 평가 (순수 함수)
 *
 * 진입 로직 제거됨 — 조건검색 결과를 즉시 매수.
 * 청산 판단과 수량 계산만 담당.
 *
 * 익절/손절은 % 기반 (틱 기반 아님).
 */

import {
  type DantaV2Config,
  type DantaV2State,
  type ExitReason,
} from './dantaTypes';

// ========================================
// 청산 조건 평가
// ========================================

export interface ExitSignal {
  shouldExit: boolean;
  exitReason: ExitReason;
  exitPrice: number;
  reason: string;
}

/**
 * 보유 포지션에 대한 청산 조건 평가.
 *
 * 우선순위:
 * 1. 익절: 체결가 >= targetPrice (+N%)
 * 2. 손절: 체결가 <= stopLossPrice (-N%)
 * 3. 시간청산: 체결 후 N초 경과, 목표 도달 이력 없고 현재가 < 목표의 절반
 * 4. 장종료 강제청산 (15:20 이후)
 */
export function evaluateExit(
  position: DantaV2State,
  currentPrice: number,
  bidPrice: number,
  now: number,
  config: DantaV2Config,
  kstMinute: number,
): ExitSignal {
  const noExit: ExitSignal = { shouldExit: false, exitReason: 'target', exitPrice: 0, reason: '' };

  // 1) 익절: 매수1호가(bidPrice) >= targetPrice — 실제 체결가 기준 판단
  if (bidPrice >= position.targetPrice) {
    return {
      shouldExit: true,
      exitReason: 'target',
      exitPrice: bidPrice,
      reason: `익절: 매수1호가 ${bidPrice} >= 목표 ${position.targetPrice}`,
    };
  }

  // 2) 손절: 매수1호가(bidPrice) <= stopLossPrice — 실제 체결가 기준 판단
  if (bidPrice <= position.stopLossPrice) {
    return {
      shouldExit: true,
      exitReason: 'stop_loss',
      exitPrice: bidPrice,
      reason: `손절: 매수1호가 ${bidPrice} <= 손절가 ${position.stopLossPrice}`,
    };
  }

  // 3) 시간청산: 체결 후 N초 경과 + 목표 도달 이력 없음 + 현재가 < 목표의 절반 (timeStopSec=0이면 비활성화)
  if (config.timeStopSec > 0 && position.filledAt) {
    const filledTime = new Date(position.filledAt).getTime();
    const elapsedSec = (now - filledTime) / 1000;
    if (elapsedSec >= config.timeStopSec) {
      const halfTargetPrice = Math.round(position.entryPrice * (1 + config.targetPct / 100 / 2));
      if (!position.hasReachedTarget && currentPrice < halfTargetPrice) {
        return {
          shouldExit: true,
          exitReason: 'time_stop',
          exitPrice: bidPrice,
          reason: `시간청산: ${elapsedSec.toFixed(0)}초 경과, 절반목표(${halfTargetPrice}) 미도달`,
        };
      }
    }
  }

  // 4) 장 종료 강제청산 (15:20 이후)
  if (config.forceCloseBeforeMarketEnd && kstMinute >= 920) {
    return {
      shouldExit: true,
      exitReason: 'market_close',
      exitPrice: bidPrice,
      reason: `장 종료 청산: KST ${Math.floor(kstMinute / 60)}:${String(kstMinute % 60).padStart(2, '0')}`,
    };
  }

  return noExit;
}

// ========================================
// 포지션 사이즈 계산
// ========================================

export function calculateQuantity(price: number, amountPerStock: number): number {
  return Math.floor(amountPerStock / price);
}

// ========================================
// 매수가/익절가/손절가 계산 (% 기반)
// ========================================

export function calculateEntryPrices(
  askPrice: number,
  config: DantaV2Config,
): { entryPrice: number; targetPrice: number; stopLossPrice: number } {
  const entryPrice = askPrice;
  const targetPrice = Math.round(entryPrice * (1 + config.targetPct / 100));
  const stopLossPrice = Math.round(entryPrice * (1 - config.stopPct / 100));
  return { entryPrice, targetPrice, stopLossPrice };
}
