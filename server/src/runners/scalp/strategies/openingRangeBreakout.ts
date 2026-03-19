/**
 * 전략 B: opening_range_breakout
 *
 * 가설: 장초반은 반등형보다 돌파형이 유효하다.
 *       첫 10분 range 상단을 거래량 증가와 함께 돌파하면 follow-through가 붙는다.
 *       실패 시 30초 gate로 빠르게 정리.
 *
 * 조건:
 * - 09:15~09:40 KST 전용
 * - 첫 10분(09:00~09:10) range 상단 돌파
 * - 최근 2봉 거래량 > 이전 평균 1.3x 이상
 * - spreadTicks <= 2
 * - targetTicks 3~6
 */

import { type ScalpStrategy } from './strategyInterface';
import { type CandidateContext, type EntrySignal } from '../scalpTypes';

const NO_ENTRY: EntrySignal = { shouldEnter: false, reason: '', entryMeta: {} };

export const openingRangeBreakout: ScalpStrategy = {
  id: 'opening_range_breakout',
  label: '시초돌파',
  version: '1.0',

  isActiveAt(currentMinute: number): boolean {
    // 09:15~09:40 전용
    return currentMinute >= 555 && currentMinute <= 580;
  },

  evaluate(ctx: CandidateContext): EntrySignal {
    const { minuteBars, currentPrice, spreadTicks, targetTicks, currentMinute } = ctx;

    // 시간 재확인
    if (currentMinute < 555 || currentMinute > 580) {
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

    // 1) 첫 10분(09:00~09:10) range 산출
    // minuteBars의 time 필드: "HHMMSS" 형식
    const openBars = minuteBars.filter(b => {
      const t = parseInt(b.time || '0', 10);
      return t >= 90000 && t < 91000;
    });

    if (openBars.length < 3) {
      return { ...NO_ENTRY, reason: `시초 10분 봉 부족 (${openBars.length} < 3)` };
    }

    const openRangeHigh = Math.max(...openBars.map(b => b.high));
    const openRangeLow = Math.min(...openBars.map(b => b.low));
    const openRangePct = ((openRangeHigh - openRangeLow) / openRangeLow) * 100;

    // 2) 상단 돌파 확인
    if (currentPrice <= openRangeHigh) {
      return {
        shouldEnter: false,
        reason: `돌파 미달 (${currentPrice} <= rangeHigh ${openRangeHigh})`,
        entryMeta: {},
      };
    }

    // 3) 거래량 증가 체크
    // 최근 2봉 vs 이전 봉 평균 (volume이 있는 봉만)
    const barsWithVol = minuteBars.filter(b => b.volume != null && b.volume > 0);
    let volumeRatio = 0;

    if (barsWithVol.length >= 4) {
      const recentBars = barsWithVol.slice(-2);
      const prevBars = barsWithVol.slice(-5, -2);
      const recentAvgVol = recentBars.reduce((s, b) => s + (b.volume || 0), 0) / recentBars.length;
      const prevAvgVol = prevBars.length > 0
        ? prevBars.reduce((s, b) => s + (b.volume || 0), 0) / prevBars.length
        : 1;
      volumeRatio = prevAvgVol > 0 ? recentAvgVol / prevAvgVol : 0;

      if (volumeRatio < 1.3) {
        return {
          shouldEnter: false,
          reason: `거래량 증가 부족 (${volumeRatio.toFixed(2)}x < 1.3x)`,
          entryMeta: {},
        };
      }
    }
    // volume 데이터 없으면 거래량 체크 skip (KIS API에서 volume 미제공 시)

    // 돌파 크기
    const breakoutPct = ((currentPrice - openRangeHigh) / openRangeHigh) * 100;

    return {
      shouldEnter: true,
      reason: `시초돌파: range=${openRangeLow}~${openRangeHigh}, breakout=${breakoutPct.toFixed(2)}%`,
      entryMeta: {
        openRangeHigh,
        openRangeLow,
        openRangePct: Number(openRangePct.toFixed(2)),
        openingRangeBreak: true,
        breakoutPct: Number(breakoutPct.toFixed(2)),
        volumeRatio: Number(volumeRatio.toFixed(2)),
        openBarCount: openBars.length,
      },
    };
  },
};
