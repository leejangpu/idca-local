/**
 * 단타 v1 — 전략 평가 (순수 함수)
 *
 * 모든 함수는 side-effect 없이 데이터를 받아 판단만 반환한다.
 * API 호출, 상태 변경, 로깅은 호출자(엔진)가 담당.
 *
 * 상태 머신 흐름:
 *   NEW_CANDIDATE → WAIT_PULLBACK → READY_TO_BREAKOUT → (매수) → (청산)
 */

import {
  type DantaCandidate,
  type CandidatePhase,
  type DantaV1Config,
  type DantaV1State,
  type ExitReason,
} from './dantaTypes';
import { priceUpTicks, priceDownTicks, ticksBetween } from './tickSize';

// ========================================
// 후보 상태 전이 평가
// ========================================

export interface PhaseTransitionResult {
  newPhase: CandidatePhase;
  reason: string;
  updatedCandidate: Partial<DantaCandidate>;
}

/**
 * triggerHigh 설정: 직전 3개 완료 1분봉의 최고가
 * minuteBarHighs = 완료 봉들의 high 배열 (최신 순)
 */
export function calculateTriggerHigh(minuteBarHighs: number[]): number | null {
  if (minuteBarHighs.length < 3) return null;
  // 직전 3개 봉의 최고가
  return Math.max(minuteBarHighs[0], minuteBarHighs[1], minuteBarHighs[2]);
}

/**
 * NEW_CANDIDATE → WAIT_PULLBACK: triggerHigh가 설정되면 전이
 * WAIT_PULLBACK → READY_TO_BREAKOUT: 유효 눌림 감지 시 전이
 * WAIT_PULLBACK → INVALIDATED: 3틱 이상 눌림 시 무효화
 * READY_TO_BREAKOUT → INVALIDATED: 다시 3틱 이상 빠지면 무효화
 */
export function evaluateCandidatePhase(
  candidate: DantaCandidate,
  currentPrice: number,
  config: DantaV1Config,
): PhaseTransitionResult {
  const { phase, triggerHigh } = candidate;

  // NEW_CANDIDATE: triggerHigh 아직 미설정 → 대기
  if (phase === 'NEW_CANDIDATE') {
    if (!triggerHigh) {
      return { newPhase: 'NEW_CANDIDATE', reason: 'triggerHigh 미설정', updatedCandidate: {} };
    }
    // triggerHigh 설정됨 → WAIT_PULLBACK 전이
    return {
      newPhase: 'WAIT_PULLBACK',
      reason: `triggerHigh=${triggerHigh} 설정, 눌림 대기`,
      updatedCandidate: {},
    };
  }

  if (!triggerHigh) {
    return { newPhase: 'INVALIDATED', reason: 'triggerHigh 없음', updatedCandidate: {} };
  }

  const pulldownTicks = ticksBetween(triggerHigh, currentPrice);

  // WAIT_PULLBACK: 눌림 폭 체크
  if (phase === 'WAIT_PULLBACK') {
    // 3틱 이상 눌림 → 무효
    if (pulldownTicks >= config.pullbackInvalidTicks) {
      return {
        newPhase: 'INVALIDATED',
        reason: `눌림 ${pulldownTicks}틱 >= ${config.pullbackInvalidTicks}틱 무효`,
        updatedCandidate: {},
      };
    }

    // 1~2틱 눌림 → READY_TO_BREAKOUT
    if (pulldownTicks >= config.pullbackValidMinTicks && pulldownTicks <= config.pullbackValidMaxTicks) {
      const pullbackLow = candidate.pullbackLow
        ? Math.min(candidate.pullbackLow, currentPrice)
        : currentPrice;

      return {
        newPhase: 'READY_TO_BREAKOUT',
        reason: `눌림 ${pulldownTicks}틱 감지, pullbackLow=${pullbackLow}`,
        updatedCandidate: {
          pullbackLow,
          pullbackDetectedAt: Date.now(),
        },
      };
    }

    // 아직 안 눌림 — 저점 추적만
    if (currentPrice < triggerHigh) {
      const pullbackLow = candidate.pullbackLow
        ? Math.min(candidate.pullbackLow, currentPrice)
        : currentPrice;
      return {
        newPhase: 'WAIT_PULLBACK',
        reason: '눌림 진행중',
        updatedCandidate: { pullbackLow },
      };
    }

    return { newPhase: 'WAIT_PULLBACK', reason: '눌림 대기', updatedCandidate: {} };
  }

  // READY_TO_BREAKOUT: 다시 깊이 빠지면 무효
  if (phase === 'READY_TO_BREAKOUT') {
    if (pulldownTicks >= config.pullbackInvalidTicks) {
      return {
        newPhase: 'INVALIDATED',
        reason: `돌파 대기 중 ${pulldownTicks}틱 추가 하락, 무효`,
        updatedCandidate: {},
      };
    }

    // pullbackLow 갱신
    if (currentPrice < (candidate.pullbackLow ?? Infinity)) {
      return {
        newPhase: 'READY_TO_BREAKOUT',
        reason: 'pullbackLow 갱신',
        updatedCandidate: { pullbackLow: currentPrice },
      };
    }

    return { newPhase: 'READY_TO_BREAKOUT', reason: '돌파 대기', updatedCandidate: {} };
  }

  return { newPhase: phase, reason: 'no transition', updatedCandidate: {} };
}

// ========================================
// 매수 조건 평가
// ========================================

export interface EntrySignal {
  shouldEnter: boolean;
  reason: string;
  entryPrice: number;           // 매수가 (최우선 매도호가)
  targetPrice: number;
  stopLossPrice: number;
  pullbackLow: number;
}

/**
 * READY_TO_BREAKOUT 상태 후보에 대해 매수 여부 판단.
 *
 * 조건: 체결가(currentPrice)가 triggerHigh를 1틱 이상 상향 돌파
 * 매수가: 최우선 매도호가(askPrice)로 공격적 지정가
 */
export function evaluateEntry(
  candidate: DantaCandidate,
  currentPrice: number,
  askPrice: number,
  config: DantaV1Config,
): EntrySignal {
  const noEntry: EntrySignal = {
    shouldEnter: false,
    reason: '',
    entryPrice: 0,
    targetPrice: 0,
    stopLossPrice: 0,
    pullbackLow: candidate.pullbackLow ?? 0,
  };

  if (candidate.phase !== 'READY_TO_BREAKOUT' || !candidate.triggerHigh || !candidate.pullbackLow) {
    noEntry.reason = 'phase/data 부적합';
    return noEntry;
  }

  const triggerHigh = candidate.triggerHigh;
  const breakoutLevel = priceUpTicks(triggerHigh, config.breakoutConfirmTicks);

  // 체결가가 돌파 레벨 이상인지 확인
  if (currentPrice < breakoutLevel) {
    noEntry.reason = `체결가 ${currentPrice} < 돌파레벨 ${breakoutLevel}`;
    return noEntry;
  }

  // 매수가 = 최우선 매도호가 (공격적 지정가)
  const entryPrice = askPrice;
  const targetPrice = priceUpTicks(entryPrice, config.targetTicks);
  const stopLossPrice = priceDownTicks(entryPrice, config.stopTicks);

  return {
    shouldEnter: true,
    reason: `체결가 ${currentPrice} >= 돌파레벨 ${breakoutLevel} (triggerHigh=${triggerHigh}+${config.breakoutConfirmTicks}틱)`,
    entryPrice,
    targetPrice,
    stopLossPrice,
    pullbackLow: candidate.pullbackLow,
  };
}

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
 * 1. 익절: 체결가 >= targetPrice (+2틱)
 * 2. 손절: 체결가 <= stopLossPrice (-2틱)
 * 3. 시간청산: 체결 후 30초 경과, +2틱 도달 이력 없고 현재가 < +1틱
 * 4. 장종료 강제청산 (15:20 이후)
 */
export function evaluateExit(
  position: DantaV1State,
  currentPrice: number,
  bidPrice: number,
  now: number,
  config: DantaV1Config,
  kstMinute: number,
): ExitSignal {
  const noExit: ExitSignal = { shouldExit: false, exitReason: 'target', exitPrice: 0, reason: '' };

  // 1) 익절: 체결가 >= targetPrice
  if (currentPrice >= position.targetPrice) {
    return {
      shouldExit: true,
      exitReason: 'target',
      exitPrice: bidPrice,  // 최우선 매수호가로 매도
      reason: `익절: 체결가 ${currentPrice} >= 목표 ${position.targetPrice}`,
    };
  }

  // 2) 손절: 체결가 <= stopLossPrice
  if (currentPrice <= position.stopLossPrice) {
    return {
      shouldExit: true,
      exitReason: 'stop_loss',
      exitPrice: bidPrice,
      reason: `손절: 체결가 ${currentPrice} <= 손절가 ${position.stopLossPrice}`,
    };
  }

  // 3) 시간청산: 체결 후 30초 경과 + MFE < +2틱 + 현재가 < +1틱
  if (position.filledAt) {
    const filledTime = new Date(position.filledAt).getTime();
    const elapsedSec = (now - filledTime) / 1000;
    if (elapsedSec >= config.timeStopSec) {
      const plusOneTick = priceUpTicks(position.entryPrice, 1);
      if (!position.hasReachedPlusTwoTicks && currentPrice < plusOneTick) {
        return {
          shouldExit: true,
          exitReason: 'time_stop',
          exitPrice: bidPrice,
          reason: `시간청산: ${elapsedSec.toFixed(0)}초 경과, +1틱(${plusOneTick}) 미도달`,
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
