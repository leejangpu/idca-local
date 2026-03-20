/**
 * 전략 C: flush_reclaim
 *
 * 가설: 의미있는 급락(flush) 후 저점 재이탈 없이 EMA10을 리클레임하면
 *       짧은 반등 edge가 발생한다.
 *
 * 조건:
 * - 09:15~15:15 (점심 제외)
 * - 최근 2~5봉 내 의미있는 하락: 고점~저점 > 0.3%
 * - flushLow 이후 저점 재이탈 없음 (higher low)
 * - currentPrice > EMA10 (재상향 돌파, 직전봉은 EMA10 이하)
 * - currentPrice > bars[-1].high (signal bar high 돌파)
 * - armed: triggerLevel = bars[-1].high, 8초, direction=above
 */

import { type ScalpStrategy } from './strategyInterface';
import { type CandidateContext, type EntrySignal } from '../scalpTypes';

const NO_ENTRY: EntrySignal = { shouldEnter: false, reason: '', entryMeta: {} };

/** 단순 EMA 계산 */
function calcEMA(closes: number[], period: number): number {
  if (closes.length === 0) return 0;
  if (closes.length < period) {
    return closes.reduce((a, b) => a + b, 0) / closes.length;
  }
  const k = 2 / (period + 1);
  let ema = closes.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < closes.length; i++) {
    ema = closes[i] * k + ema * (1 - k);
  }
  return ema;
}

export const flushReclaim: ScalpStrategy = {
  id: 'flush_reclaim',
  label: '플러시후리클레임',
  version: '1.0',

  isActiveAt(currentMinute: number): boolean {
    if (currentMinute < 555 || currentMinute > 915) return false;
    if (currentMinute >= 690 && currentMinute < 780) return false;
    return true;
  },

  evaluate(ctx: CandidateContext): EntrySignal {
    const { minuteBars, currentPrice, spreadTicks, targetTicks } = ctx;

    if (minuteBars.length < 10) {
      return { ...NO_ENTRY, reason: '분봉 부족 (< 10)' };
    }

    if (spreadTicks > 2) {
      return { ...NO_ENTRY, reason: `spreadTicks 초과 (${spreadTicks} > 2)` };
    }

    if (targetTicks < 4 || targetTicks > 6) {
      return { ...NO_ENTRY, reason: `targetTicks 범위 밖 (${targetTicks})` };
    }

    // 1) flush 감지: 최근 2~5봉 내에서 고점→저점 > 0.3%
    const lookbackBars = minuteBars.slice(-6, -1); // bars[-6] ~ bars[-2] (직전봉 제외)
    let flushFound = false;
    let flushDepthPct = 0;
    let flushLow = Infinity;

    for (let i = 0; i < lookbackBars.length; i++) {
      const windowEnd = i + 1;
      // 2~5봉 윈도우
      for (let windowStart = Math.max(0, i - 4); windowStart < i; windowStart++) {
        const high = Math.max(...lookbackBars.slice(windowStart, windowEnd + 1).map(b => b.high));
        const low = Math.min(...lookbackBars.slice(windowStart, windowEnd + 1).map(b => b.low));
        const depth = high > 0 ? ((high - low) / high) * 100 : 0;
        if (depth > flushDepthPct) {
          flushDepthPct = depth;
          flushLow = low;
          if (depth >= 0.3) flushFound = true;
        }
      }
    }

    if (!flushFound) {
      return { ...NO_ENTRY, reason: `flush 부족 (max depth=${flushDepthPct.toFixed(2)}% < 0.3%)` };
    }

    // 2) higher low: flushLow 이후 저점 재이탈 없음
    const lastBar = minuteBars[minuteBars.length - 2]; // 직전 봉
    const recentLow = Math.min(lastBar.low, minuteBars[minuteBars.length - 1]?.low ?? Infinity);
    const higherLow = recentLow > flushLow;
    if (!higherLow) {
      return { ...NO_ENTRY, reason: `higher low 실패 (recentLow=${recentLow} <= flushLow=${flushLow})` };
    }

    // 3) EMA10 리클레임
    const closes = minuteBars.map(b => b.close);
    const ema10 = calcEMA(closes, 10);
    if (currentPrice <= ema10) {
      // nearMiss: 가격이 EMA10의 0.05% 이내
      const gap = ((ema10 - currentPrice) / ema10) * 100;
      if (gap < 0.05 && flushFound) {
        return {
          shouldEnter: false,
          reason: `EMA10 리클레임 근접 (gap=${gap.toFixed(3)}%)`,
          entryMeta: { flushDepthPct: Number(flushDepthPct.toFixed(2)), ema10: Number(ema10.toFixed(0)) },
          nearMiss: true,
        };
      }
      return { ...NO_ENTRY, reason: `EMA10 미돌파 (${currentPrice} <= ${ema10.toFixed(0)})` };
    }

    // 직전봉이 EMA10 이하 (리클레임 확인)
    const prevClose = closes[closes.length - 2];
    const closesForPrevEma = closes.slice(0, -1);
    const ema10Prev = calcEMA(closesForPrevEma, 10);
    const ema10Reclaim = prevClose <= ema10Prev;
    if (!ema10Reclaim) {
      return { ...NO_ENTRY, reason: '직전봉이 이미 EMA10 위 (리클레임 아님)' };
    }

    // 4) signal bar high 돌파
    const signalBarHigh = lastBar.high;
    if (currentPrice <= signalBarHigh) {
      return { ...NO_ENTRY, reason: `signal bar high 미돌파 (${currentPrice} <= ${signalBarHigh})` };
    }

    const ema10DistancePct = ((currentPrice - ema10) / ema10) * 100;
    const ema10Slope = ema10Prev > 0 ? ((ema10 - ema10Prev) / ema10Prev) * 100 : 0;

    // 3분 모멘텀
    const c3ago = closes.length >= 4 ? closes[closes.length - 4] : closes[0];
    const cNow = closes[closes.length - 1];
    const recentMomentumPct = c3ago > 0 ? ((cNow - c3ago) / c3ago) * 100 : 0;

    return {
      shouldEnter: true,
      reason: `플러시리클레임: flush=${flushDepthPct.toFixed(2)}%, ema10reclaim`,
      entryMeta: {
        flushDepthPct: Number(flushDepthPct.toFixed(2)),
        flushLow,
        higherLow: recentLow,
        ema10: Number(ema10.toFixed(0)),
        ema10Reclaim: true,
        ema10DistancePct: Number(ema10DistancePct.toFixed(2)),
        ema10Slope: Number(ema10Slope.toFixed(3)),
        recentMomentumPct: Number(recentMomentumPct.toFixed(2)),
      },
      triggerLevel: signalBarHigh,
      triggerDirection: 'above',
      armDurationMs: 8000,
    };
  },
};
