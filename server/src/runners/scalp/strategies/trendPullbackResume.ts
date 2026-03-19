/**
 * 전략 A: trend_pullback_resume
 *
 * 가설: 살아 있는 강한 종목의 짧은 눌림 후 재개를 잡으면 follow-through가 붙는다.
 *
 * 조건 (완화 버전 — 초기 데이터 수집용):
 * - 최근 3분 모멘텀 > 0
 * - currentPrice > EMA10
 * - EMA10 기울기 > 0
 * - 최근 2봉 중 1봉 이상 눌림 (close < 직전 close)
 * - currentPrice > 눌림 봉의 high (재개 확인)
 * - spreadTicks <= 2 (1틱 선호지만 2틱까지 허용)
 * - targetTicks 4~6 허용
 */

import { type ScalpStrategy } from './strategyInterface';
import { type CandidateContext, type EntrySignal } from '../scalpTypes';

const NO_ENTRY: EntrySignal = { shouldEnter: false, reason: '', entryMeta: {} };

/** 단순 EMA 계산 */
function calcEMA(closes: number[], period: number): number {
  if (closes.length === 0) return 0;
  if (closes.length < period) {
    // 데이터 부족 시 SMA 반환
    return closes.reduce((a, b) => a + b, 0) / closes.length;
  }
  const k = 2 / (period + 1);
  let ema = closes.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < closes.length; i++) {
    ema = closes[i] * k + ema * (1 - k);
  }
  return ema;
}

export const trendPullbackResume: ScalpStrategy = {
  id: 'trend_pullback_resume',
  label: '추세눌림재개',
  version: '1.0',

  isActiveAt(currentMinute: number): boolean {
    // 09:15~15:15, 점심 제외 — 장초 10분 혼돈 회피
    if (currentMinute < 555 || currentMinute > 915) return false;
    if (currentMinute >= 690 && currentMinute < 780) return false;
    return true;
  },

  evaluate(ctx: CandidateContext): EntrySignal {
    const { minuteBars, currentPrice, spreadTicks, targetTicks } = ctx;

    // 최소 10봉 필요 (EMA10 + 눌림 판단)
    if (minuteBars.length < 10) {
      return { ...NO_ENTRY, reason: '분봉 부족 (< 10)' };
    }

    // spread 필터: 2틱까지 허용
    if (spreadTicks > 2) {
      return { ...NO_ENTRY, reason: `spreadTicks 초과 (${spreadTicks} > 2)` };
    }

    // targetTicks: 4~6 허용
    if (targetTicks < 4 || targetTicks > 6) {
      return { ...NO_ENTRY, reason: `targetTicks 범위 밖 (${targetTicks}, 4~6 필요)` };
    }

    const closes = minuteBars.map(b => b.close);

    // 1) 최근 3분 모멘텀 > 0
    const c3ago = closes[closes.length - 4];
    const cNow = closes[closes.length - 1];
    const momentumPct = ((cNow - c3ago) / c3ago) * 100;
    if (momentumPct <= 0) {
      return { ...NO_ENTRY, reason: `3분 모멘텀 <= 0 (${momentumPct.toFixed(2)}%)` };
    }

    // 2) EMA10 계산 + currentPrice > EMA10
    const ema10 = calcEMA(closes, 10);
    if (currentPrice <= ema10) {
      return { ...NO_ENTRY, reason: `currentPrice(${currentPrice}) <= EMA10(${ema10.toFixed(0)})` };
    }

    // 3) EMA10 기울기 > 0 (2봉 전 대비)
    const closesExcludeLast2 = closes.slice(0, -2);
    const ema10prev = calcEMA(closesExcludeLast2, 10);
    const ema10Slope = ema10prev > 0 ? (ema10 - ema10prev) / ema10prev : 0;
    if (ema10Slope <= 0) {
      return { ...NO_ENTRY, reason: `EMA10 기울기 <= 0 (${(ema10Slope * 100).toFixed(3)}%)` };
    }

    // 4) 눌림 감지: 최근 2봉(bar[-2], bar[-3]) 중 1봉 이상 close 하락
    const bar1 = minuteBars[minuteBars.length - 2]; // 직전 봉
    const bar2 = minuteBars[minuteBars.length - 3]; // 2봉 전
    const bar3 = minuteBars[minuteBars.length - 4]; // 3봉 전

    const pullback1 = bar1.close < bar2.close;  // 직전봉이 2봉전보다 하락
    const pullback2 = bar2.close < bar3.close;  // 2봉전이 3봉전보다 하락

    if (!pullback1 && !pullback2) {
      return { ...NO_ENTRY, reason: '눌림 없음 (최근 2봉 모두 상승)' };
    }

    // 5) 재개 확인: currentPrice > 눌림 봉의 high
    const pullbackBar = pullback1 ? bar1 : bar2;
    if (currentPrice <= pullbackBar.high) {
      return { ...NO_ENTRY, reason: `재개 미확인 (${currentPrice} <= pullbackHigh ${pullbackBar.high})` };
    }

    const ema10DistancePct = ((currentPrice - ema10) / ema10) * 100;

    return {
      shouldEnter: true,
      reason: `추세눌림재개: mom=${momentumPct.toFixed(2)}%, slope=${(ema10Slope * 100).toFixed(3)}%`,
      entryMeta: {
        recentMomentumPct: Number(momentumPct.toFixed(2)),
        ema10: Number(ema10.toFixed(0)),
        ema10DistancePct: Number(ema10DistancePct.toFixed(2)),
        ema10Slope: Number((ema10Slope * 100).toFixed(3)),
        prevHighBreak: true,
        pullbackBars: pullback1 && pullback2 ? 2 : 1,
        pullbackBarHigh: pullbackBar.high,
      },
    };
  },
};
