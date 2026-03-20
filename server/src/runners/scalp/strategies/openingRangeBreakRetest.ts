/**
 * 전략 D: opening_range_break_retest
 *
 * 가설: 장초반 ORB 후 리테스트(눌림) → 재돌파가 순수 돌파보다 신뢰도가 높다.
 *
 * 조건:
 * - 09:15~10:00 한정
 * - 첫 5~10분 range 산출 (openRangeHigh/Low)
 * - 초기 돌파 이력: 이전 봉 중 high > openRangeHigh
 * - 눌림 후 openRangeHigh 유지: currentPrice >= openRangeHigh
 * - 재돌파: currentPrice > bars[-1].high
 * - armed: triggerLevel = openRangeHigh, 8초, direction=above
 */

import { type ScalpStrategy } from './strategyInterface';
import { type CandidateContext, type EntrySignal } from '../scalpTypes';

const NO_ENTRY: EntrySignal = { shouldEnter: false, reason: '', entryMeta: {} };

export const openingRangeBreakRetest: ScalpStrategy = {
  id: 'opening_range_break_retest',
  label: 'ORB리테스트',
  version: '1.0',

  isActiveAt(currentMinute: number): boolean {
    // 09:15~10:00 전용
    return currentMinute >= 555 && currentMinute <= 600;
  },

  evaluate(ctx: CandidateContext): EntrySignal {
    const { minuteBars, currentPrice, spreadTicks, targetTicks, currentMinute } = ctx;

    if (currentMinute < 555 || currentMinute > 600) {
      return { ...NO_ENTRY, reason: '시간대 밖' };
    }

    if (spreadTicks > 2) {
      return { ...NO_ENTRY, reason: `spreadTicks 초과 (${spreadTicks} > 2)` };
    }

    if (targetTicks < 3 || targetTicks > 6) {
      return { ...NO_ENTRY, reason: `targetTicks 범위 밖 (${targetTicks})` };
    }

    if (minuteBars.length < 5) {
      return { ...NO_ENTRY, reason: '분봉 부족 (< 5)' };
    }

    // 1) 첫 5~10분(09:00~09:10) range 산출
    const openBars = minuteBars.filter(b => {
      const t = parseInt(b.time || '0', 10);
      return t >= 90000 && t < 91000;
    });

    if (openBars.length < 3) {
      return { ...NO_ENTRY, reason: `시초 10분 봉 부족 (${openBars.length} < 3)` };
    }

    const openRangeHigh = Math.max(...openBars.map(b => b.high));
    const openRangeLow = Math.min(...openBars.map(b => b.low));
    const openRangePct = openRangeLow > 0 ? ((openRangeHigh - openRangeLow) / openRangeLow) * 100 : 0;

    // 2) 초기 돌파 이력: openRange 이후 봉 중 high > openRangeHigh
    const postOpenBars = minuteBars.filter(b => {
      const t = parseInt(b.time || '0', 10);
      return t >= 91000;
    });

    const hasBreakHistory = postOpenBars.some(b => b.high > openRangeHigh);
    if (!hasBreakHistory) {
      return { ...NO_ENTRY, reason: '초기 돌파 이력 없음' };
    }

    // 3) 눌림 후 openRangeHigh 유지
    if (currentPrice < openRangeHigh) {
      // nearMiss: 가격이 openRangeHigh의 0.1% 이내
      const gap = ((openRangeHigh - currentPrice) / openRangeHigh) * 100;
      if (gap < 0.1) {
        return {
          shouldEnter: false,
          reason: `ORB 지지 근접 (gap=${gap.toFixed(3)}%)`,
          entryMeta: { openRangeHigh, openRangeLow },
          nearMiss: true,
        };
      }
      return { ...NO_ENTRY, reason: `openRangeHigh 이탈 (${currentPrice} < ${openRangeHigh})` };
    }

    // 4) 재돌파: currentPrice > bars[-1].high
    const lastBar = minuteBars[minuteBars.length - 2]; // 직전 완성 봉
    if (!lastBar) {
      return { ...NO_ENTRY, reason: '직전 봉 없음' };
    }

    if (currentPrice <= lastBar.high) {
      return { ...NO_ENTRY, reason: `재돌파 미달 (${currentPrice} <= lastHigh ${lastBar.high})` };
    }

    // 리테스트 깊이: 돌파 후 최저점 대비
    const retestLow = Math.min(...postOpenBars.slice(-3).map(b => b.low));
    const retestDepthPct = openRangeHigh > 0 ? ((openRangeHigh - retestLow) / openRangeHigh) * 100 : 0;

    // 거래량 체크 (보조)
    const barsWithVol = minuteBars.filter(b => b.volume != null && b.volume > 0);
    let volumeRatio = 0;
    if (barsWithVol.length >= 4) {
      const recentVolBars = barsWithVol.slice(-2);
      const prevVolBars = barsWithVol.slice(-5, -2);
      const recentAvgVol = recentVolBars.reduce((s, b) => s + (b.volume || 0), 0) / recentVolBars.length;
      const prevAvgVol = prevVolBars.length > 0
        ? prevVolBars.reduce((s, b) => s + (b.volume || 0), 0) / prevVolBars.length
        : 1;
      volumeRatio = prevAvgVol > 0 ? recentAvgVol / prevAvgVol : 0;
    }

    return {
      shouldEnter: true,
      reason: `ORB리테스트: range=${openRangeLow}~${openRangeHigh}, retest=${retestDepthPct.toFixed(2)}%`,
      entryMeta: {
        openRangeHigh,
        openRangeLow,
        openRangePct: Number(openRangePct.toFixed(2)),
        retestDepthPct: Number(retestDepthPct.toFixed(2)),
        volumeRatio: Number(volumeRatio.toFixed(2)),
      },
      triggerLevel: openRangeHigh,
      triggerDirection: 'above',
      armDurationMs: 8000,
    };
  },
};
