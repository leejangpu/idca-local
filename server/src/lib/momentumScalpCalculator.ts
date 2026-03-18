/**
 * 빠른 회전 스캘핑 계산기 (v2)
 * 0.5% 익절 / 0.5% 손절 / 5분 타임아웃
 *
 * 순수 함수 모듈 — Firestore/API 접근 금지
 * 백테스트에서 동일 함수를 import하여 재사용 가능
 */

import { MinuteBar } from './rsiCalculator';
import { getKoreanTickSize, roundToKoreanTickCeil, roundToKoreanTickFloor } from './marketUtils';

// ========================================
// 타입 정의
// ========================================

export interface QuickScalpFilterParams {
  ticker: string;
  stockName: string;
  currentPrice: number;
  askPrice: number;       // 매도호가1 (최우선)
  bidPrice: number;       // 매수호가1 (최우선)
}

export interface QuickScalpFilterResult {
  pass: boolean;
  targetTicks: number;    // 0.5% 도달에 필요한 틱 수
  spreadTicks: number;    // 현재 스프레드 틱 수
  reason: string;
}

export interface BoxEntryParams {
  minuteBars: MinuteBar[];  // 최근 10분 1분봉
  currentPrice: number;
  spreadPct?: number;       // 현재 스프레드 (%, 옵션 — 최소 변동성 계산용)
  targetTicks?: number;     // v2.1: boxRangeTicks >= 2×targetTicks 체크용
}

export interface BoxEntryResult {
  shouldEnter: boolean;
  boxHigh: number;
  boxLow: number;
  currentPosition: number;  // 0~1, 0=바닥 1=천장
  reason: string;
}

export interface QuickScalpTargetResult {
  targetPrice: number;    // 진입가 × 1.005, 호가올림
  stopLossPrice: number;  // 진입가 × 0.995, 호가내림
}

export interface MomentumScalpExitParams {
  currentPrice: number;
  targetPrice: number;
  stopLossPrice: number;
  bidPrice: number;
}

export interface MomentumScalpExitResult {
  shouldSell: boolean;
  exitReason: 'target' | 'stop_loss' | null;
  exitPrice: number | null;
  exitOrderType: 'LIMIT' | 'MARKET' | null;
  reason: string;
}

// ========================================
// filterQuickScalpCandidate
// ========================================

/**
 * 코드 필터: 0.5% 스캘핑에 적합한 종목인지 판단
 * - targetTicks >= 3  (0.5%가 최소 3틱 이상)
 * - spreadTicks <= 2  (스프레드 2틱 이내)
 * - spread/target <= 25%  (목표 대비 스프레드 비율)
 */
export function filterQuickScalpCandidate(
  params: QuickScalpFilterParams
): QuickScalpFilterResult {
  const { currentPrice, askPrice, bidPrice } = params;
  const tickSize = getKoreanTickSize(currentPrice);

  const targetAmount = currentPrice * 0.005;
  const targetTicks = Math.round(targetAmount / tickSize);

  const spread = askPrice - bidPrice;
  const spreadTicks = Math.round(spread / tickSize);

  if (targetTicks < 3) {
    return { pass: false, targetTicks, spreadTicks, reason: `targetTicks 부족 (${targetTicks} < 3)` };
  }

  // v2.1: targetTicks > 6 종목 제외 (고가 저변동주 — 승률 4.2%)
  if (targetTicks > 6) {
    return { pass: false, targetTicks, spreadTicks, reason: `targetTicks 초과 (${targetTicks} > 6)` };
  }

  if (spreadTicks > 2) {
    return { pass: false, targetTicks, spreadTicks, reason: `spreadTicks 초과 (${spreadTicks} > 2)` };
  }

  if (targetTicks > 0 && (spreadTicks / targetTicks) > 0.25) {
    return { pass: false, targetTicks, spreadTicks, reason: `spread/target 비율 초과 (${(spreadTicks / targetTicks * 100).toFixed(0)}% > 25%)` };
  }

  return { pass: true, targetTicks, spreadTicks, reason: '통과' };
}

// ========================================
// checkBoxEntry
// ========================================

/**
 * 10분 박스 하단 진입 판단
 * - 최근 10개 1분봉의 고저로 박스 산출
 * - 최소 변동성: boxRangePct >= max(0.35%, 2.5×spreadPct, 4×tickSize/price)
 * - 현재가가 박스 하단 30% 이내
 * - 직전 봉 대비 uptick ≥ 1틱 (반등 확인)
 */
export function checkBoxEntry(params: BoxEntryParams): BoxEntryResult {
  const { minuteBars, currentPrice, spreadPct, targetTicks } = params;

  const noEntry = (reason: string): BoxEntryResult => ({
    shouldEnter: false, boxHigh: 0, boxLow: 0, currentPosition: 0.5, reason,
  });

  if (minuteBars.length < 3) {
    return noEntry('분봉 데이터 부족 (최소 3개 필요)');
  }

  const highs = minuteBars.map(b => b.high);
  const lows = minuteBars.map(b => b.low);
  const boxHigh = Math.max(...highs);
  const boxLow = Math.min(...lows);
  const boxRange = boxHigh - boxLow;

  if (boxRange <= 0) {
    return noEntry('박스 범위 없음 (고가=저가)');
  }

  // 최소 변동성 체크: max(0.35%, 2.5×spreadPct, 4×tickSize/price)
  const boxRangePct = (boxRange / currentPrice) * 100;
  const tickSize = getKoreanTickSize(currentPrice);
  const minTickPct = (4 * tickSize / currentPrice) * 100;
  const minSpreadPct = spreadPct != null ? 2.5 * spreadPct : 0;
  const minBoxRangePct = Math.max(0.35, minSpreadPct, minTickPct);

  if (boxRangePct < minBoxRangePct) {
    return noEntry(`박스 변동성 부족 (${boxRangePct.toFixed(2)}% < ${minBoxRangePct.toFixed(2)}%)`);
  }

  // v2.1: boxRangeTicks >= 2 × targetTicks (박스가 target 대비 충분히 넓은지)
  if (targetTicks && targetTicks > 0) {
    const boxRangeTicks = Math.round(boxRange / tickSize);
    const minBoxRangeTicks = 2 * targetTicks;
    if (boxRangeTicks < minBoxRangeTicks) {
      return noEntry(`박스 틱 범위 부족 (${boxRangeTicks} < 2×${targetTicks}=${minBoxRangeTicks}틱)`);
    }
  }

  const currentPosition = (currentPrice - boxLow) / boxRange; // 0=바닥, 1=천장
  const entryThreshold = 0.3; // 하단 30%

  if (currentPosition > entryThreshold) {
    return {
      shouldEnter: false,
      boxHigh, boxLow, currentPosition,
      reason: `박스 상단 위치 (${(currentPosition * 100).toFixed(0)}% > ${entryThreshold * 100}%)`,
    };
  }

  // uptick 확인: 마지막 봉 close > 직전 봉 close + 1틱 (최소 1틱 이상 반등)
  const lastBar = minuteBars[minuteBars.length - 1];
  const prevBar = minuteBars[minuteBars.length - 2];
  const uptickMin = prevBar.close + tickSize;
  if (lastBar.close < uptickMin) {
    return {
      shouldEnter: false,
      boxHigh, boxLow, currentPosition,
      reason: `uptick 부족 (${lastBar.close} < ${prevBar.close}+${tickSize}=${uptickMin})`,
    };
  }

  return {
    shouldEnter: true,
    boxHigh, boxLow, currentPosition,
    reason: `박스 하단 ${(currentPosition * 100).toFixed(0)}% + uptick ${lastBar.close - prevBar.close}원 확인`,
  };
}

// ========================================
// calculateQuickScalpTarget
// ========================================

/**
 * 고정 0.5% 목표가/손절가 계산
 * - 목표가: 진입가 × 1.005 (호가단위 올림)
 * - 손절가: 진입가 × 0.995 (호가단위 내림)
 */
export function calculateQuickScalpTarget(entryPrice: number): QuickScalpTargetResult {
  const targetPrice = roundToKoreanTickCeil(entryPrice * 1.005);
  const stopLossPrice = roundToKoreanTickFloor(entryPrice * 0.995);

  return { targetPrice, stopLossPrice };
}

// ========================================
// checkMomentumScalpExit
// ========================================

/**
 * 보유 종목 매도 판단 — bestBid 기준
 *
 * 0.5% 스캘핑에서는 "마지막 체결가(last)"보다
 * "지금 바로 팔 수 있는 가격(best bid)"이 핵심.
 *
 * 1. bestBid >= 목표가 → 익절 (MARKET, 즉시 청산)
 * 2. bestBid <= 손절가 → 손절 (MARKET)
 * 3. else → 홀드
 *
 * 타임아웃(5분)은 트리거에서 별도 처리
 */
export function checkMomentumScalpExit(
  params: MomentumScalpExitParams
): MomentumScalpExitResult {
  const { targetPrice, stopLossPrice, bidPrice } = params;

  // 핵심: bestBid 기준 판단 — "이 가격에 지금 팔 수 있는가?"
  if (bidPrice >= targetPrice) {
    return {
      shouldSell: true,
      exitReason: 'target',
      exitPrice: 0,
      exitOrderType: 'MARKET',
      reason: `익절 (bestBid ${bidPrice} >= 목표가 ${targetPrice})`,
    };
  }

  if (bidPrice <= stopLossPrice) {
    return {
      shouldSell: true,
      exitReason: 'stop_loss',
      exitPrice: 0,
      exitOrderType: 'MARKET',
      reason: `손절 (bestBid ${bidPrice} <= 손절가 ${stopLossPrice})`,
    };
  }

  return {
    shouldSell: false,
    exitReason: null,
    exitPrice: null,
    exitOrderType: null,
    reason: `홀드 (bestBid ${bidPrice}, 목표 ${targetPrice}, 손절 ${stopLossPrice})`,
  };
}

// ========================================
// v2.2: Positive Selection Score
// ========================================

export interface PositiveScoreParams {
  recentBars: MinuteBar[];       // 최근 1분봉 (최소 3개)
  entryBoxPos: number;            // 0~1 (박스 내 진입 위치)
  boxRangePct: number;            // 박스 범위 %
  targetTicks: number;
}

export interface PositiveScoreResult {
  score: number;
  details: string[];
  recentMomentumPct: number | null;  // 최근 3분 모멘텀 %
}

/**
 * 진입 전 positive selection 점수 (0~4)
 *
 * 구분력이 있는 항목만 점수화 (이미 하드 필터인 항목 제외):
 * - recent 3m momentum > 0 : 최근 3분봉 상승 추세
 * - entryBoxPos 0.10~0.20 : 박스 하단 sweet spot
 * - boxRangePct >= 2.0%   : 충분한 변동성
 * - targetTicks <= 5       : target 도달 가능성 높은 종목
 *
 * 하드 게이트는 config.positiveScoreGateEnabled로 별도 ON/OFF.
 * 기본은 기록만 (로깅용).
 */
export function calculatePositiveScore(params: PositiveScoreParams): PositiveScoreResult {
  const { recentBars, entryBoxPos, boxRangePct, targetTicks } = params;

  let score = 0;
  const details: string[] = [];
  let recentMomentumPct: number | null = null;

  // 1) recent 3m momentum > 0
  if (recentBars.length >= 3) {
    const closes = recentBars.map(b => b.close);
    const c3ago = closes[closes.length - 3];
    const cNow = closes[closes.length - 1];
    if (c3ago > 0) {
      recentMomentumPct = ((cNow - c3ago) / c3ago) * 100;
      if (recentMomentumPct > 0) {
        score += 1;
        details.push(`mom=${recentMomentumPct.toFixed(2)}%`);
      }
    }
  }

  // 2) entryBoxPos 0.10~0.20 (sweet spot)
  if (entryBoxPos >= 0.10 && entryBoxPos <= 0.20) {
    score += 1;
    details.push(`boxPos=${entryBoxPos.toFixed(2)}`);
  }

  // 3) boxRangePct >= 2.0%
  if (boxRangePct >= 2.0) {
    score += 1;
    details.push(`boxRange=${boxRangePct.toFixed(2)}%`);
  }

  // 4) targetTicks <= 5
  if (targetTicks <= 5) {
    score += 1;
    details.push(`tgtTicks=${targetTicks}`);
  }

  return { score, details, recentMomentumPct };
}
