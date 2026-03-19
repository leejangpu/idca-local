/**
 * 전략 C: box_rebound_control — Baseline 대조군
 *
 * 기존 v2.2 박스 하단 반등 로직을 그대로 래핑.
 * positiveScore는 계산/기록만 하고 entry decision에는 불개입 (대조군 역할).
 */

import { type ScalpStrategy } from './strategyInterface';
import { type CandidateContext, type EntrySignal } from '../scalpTypes';
import { checkBoxEntry, calculatePositiveScore } from '../../../lib/momentumScalpCalculator';

const NO_ENTRY: EntrySignal = { shouldEnter: false, reason: '', entryMeta: {} };

export const boxReboundControl: ScalpStrategy = {
  id: 'box_rebound_control',
  label: '박스하단반등 (대조군)',
  version: '1.0',

  isActiveAt(currentMinute: number): boolean {
    // 09:05~15:15, 점심 제외 (11:30~13:00)
    if (currentMinute < 545 || currentMinute > 915) return false;
    if (currentMinute >= 690 && currentMinute < 780) return false;
    return true;
  },

  evaluate(ctx: CandidateContext): EntrySignal {
    const { minuteBars, currentPrice, askPrice, bidPrice, targetTicks } = ctx;

    if (minuteBars.length < 3) {
      return { ...NO_ENTRY, reason: '분봉 데이터 부족' };
    }

    // 박스 진입 체크 (기존 로직 그대로)
    const spreadPct = (askPrice - bidPrice) / currentPrice * 100;
    const boxResult = checkBoxEntry({
      minuteBars, currentPrice, spreadPct, targetTicks,
    });

    if (!boxResult.shouldEnter) {
      return { shouldEnter: false, reason: boxResult.reason, entryMeta: {} };
    }

    const boxRangePct = (boxResult.boxHigh - boxResult.boxLow) / currentPrice * 100;

    // positiveScore: 계산+기록만, 게이트 없음 (baseline 고정)
    const score = calculatePositiveScore({
      recentBars: minuteBars,
      entryBoxPos: boxResult.currentPosition,
      boxRangePct,
      targetTicks,
    });

    return {
      shouldEnter: true,
      reason: boxResult.reason,
      entryMeta: {
        entryBoxPos: boxResult.currentPosition,
        boxRangePct,
        boxHigh: boxResult.boxHigh,
        boxLow: boxResult.boxLow,
        positiveScore: score.score,
        positiveScoreDetails: score.details.join(','),
        recentMomentumPct: score.recentMomentumPct,
      },
    };
  },
};
