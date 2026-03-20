/**
 * 전략 B: compression_pop
 *
 * 가설: 변동성 압축(직전 3봉 range < 이전 3봉 range × 0.6) 후
 *       상단 돌파 + 거래량 증가 시 빠른 팝업이 발생한다.
 *
 * 조건:
 * - 09:15~15:15 (점심 제외)
 * - bars[-3~-1] 평균 range < bars[-6~-4] 평균 range × 0.6 (40%+ 압축)
 * - currentPrice > compressionTop (max high of bars[-3~-1])
 * - 최근 2봉 거래량 >= 이전 3봉 평균 × 1.5
 * - armed: triggerLevel = compressionTop, 7초, direction=above
 */

import { type ScalpStrategy } from './strategyInterface';
import { type CandidateContext, type EntrySignal } from '../scalpTypes';

const NO_ENTRY: EntrySignal = { shouldEnter: false, reason: '', entryMeta: {} };

export const compressionPop: ScalpStrategy = {
  id: 'compression_pop',
  label: '압축후팝업',
  version: '1.0',

  isActiveAt(currentMinute: number): boolean {
    if (currentMinute < 555 || currentMinute > 915) return false;
    if (currentMinute >= 690 && currentMinute < 780) return false;
    return true;
  },

  evaluate(ctx: CandidateContext): EntrySignal {
    const { minuteBars, currentPrice, spreadTicks, targetTicks } = ctx;

    if (minuteBars.length < 7) {
      return { ...NO_ENTRY, reason: '분봉 부족 (< 7)' };
    }

    if (spreadTicks > 2) {
      return { ...NO_ENTRY, reason: `spreadTicks 초과 (${spreadTicks} > 2)` };
    }

    if (targetTicks < 4 || targetTicks > 6) {
      return { ...NO_ENTRY, reason: `targetTicks 범위 밖 (${targetTicks})` };
    }

    // bars[-3~-1]: 최근 3봉 (직전봉 포함)
    const recentBars = minuteBars.slice(-3);
    // bars[-6~-4]: 이전 3봉
    const prevBars = minuteBars.slice(-6, -3);

    if (prevBars.length < 3) {
      return { ...NO_ENTRY, reason: '이전 봉 부족 (< 3)' };
    }

    // 평균 range 계산
    const recentAvgRange = recentBars.reduce((s, b) => s + (b.high - b.low), 0) / recentBars.length;
    const prevAvgRange = prevBars.reduce((s, b) => s + (b.high - b.low), 0) / prevBars.length;

    if (prevAvgRange <= 0) {
      return { ...NO_ENTRY, reason: '이전 봉 range 0' };
    }

    const compressionRatio = recentAvgRange / prevAvgRange;

    // 40%+ 압축: ratio < 0.6
    if (compressionRatio >= 0.6) {
      return { ...NO_ENTRY, reason: `압축 부족 (ratio=${compressionRatio.toFixed(2)} >= 0.6)` };
    }

    // compressionTop = max high of recent 3 bars
    const compressionTop = Math.max(...recentBars.map(b => b.high));
    const compressionLow = Math.min(...recentBars.map(b => b.low));

    // 돌파 확인
    if (currentPrice <= compressionTop) {
      // nearMiss: 가격이 compressionTop의 0.1% 이내
      const gap = ((compressionTop - currentPrice) / compressionTop) * 100;
      if (gap < 0.1) {
        return {
          shouldEnter: false,
          reason: `압축 상단 근접 (gap=${gap.toFixed(3)}%)`,
          entryMeta: { compressionRatio: Number(compressionRatio.toFixed(3)), compressionTop },
          nearMiss: true,
        };
      }
      return { ...NO_ENTRY, reason: `돌파 미달 (${currentPrice} <= ${compressionTop})` };
    }

    // 거래량 체크
    const barsWithVol = minuteBars.filter(b => b.volume != null && b.volume > 0);
    let volumeRatio = 0;
    if (barsWithVol.length >= 5) {
      const recentVolBars = barsWithVol.slice(-2);
      const prevVolBars = barsWithVol.slice(-5, -2);
      const recentAvgVol = recentVolBars.reduce((s, b) => s + (b.volume || 0), 0) / recentVolBars.length;
      const prevAvgVol = prevVolBars.length > 0
        ? prevVolBars.reduce((s, b) => s + (b.volume || 0), 0) / prevVolBars.length
        : 1;
      volumeRatio = prevAvgVol > 0 ? recentAvgVol / prevAvgVol : 0;

      if (volumeRatio < 1.5) {
        return { ...NO_ENTRY, reason: `거래량 부족 (${volumeRatio.toFixed(2)}x < 1.5x)` };
      }
    }
    // volume 데이터 없으면 skip

    // 3분 모멘텀 (분석용)
    const closes = minuteBars.map(b => b.close);
    const c3ago = closes.length >= 4 ? closes[closes.length - 4] : closes[0];
    const cNow = closes[closes.length - 1];
    const recentMomentumPct = c3ago > 0 ? ((cNow - c3ago) / c3ago) * 100 : 0;

    return {
      shouldEnter: true,
      reason: `압축팝업: ratio=${compressionRatio.toFixed(2)}, vol=${volumeRatio.toFixed(1)}x`,
      entryMeta: {
        compressionRatio: Number(compressionRatio.toFixed(3)),
        compressionTop,
        compressionLow,
        volumeRatio: Number(volumeRatio.toFixed(2)),
        recentMomentumPct: Number(recentMomentumPct.toFixed(2)),
      },
      triggerLevel: compressionTop,
      triggerDirection: 'above',
      armDurationMs: 7000,
    };
  },
};
