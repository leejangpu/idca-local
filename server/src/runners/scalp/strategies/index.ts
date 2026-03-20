/**
 * Quick Scalp v3.1 — 전략 레지스트리 (4-Strategy Parallel)
 */

import { type ScalpStrategy } from './strategyInterface';
import { type StrategyId } from '../scalpTypes';
import { trendPullbackResume } from './trendPullbackResume';
import { compressionPop } from './compressionPop';
import { flushReclaim } from './flushReclaim';
import { openingRangeBreakRetest } from './openingRangeBreakRetest';

export { type ScalpStrategy } from './strategyInterface';

/** 전략 ID → 구현체 맵 */
const strategyMap: Record<StrategyId, ScalpStrategy> = {
  trend_pullback_resume: trendPullbackResume,
  compression_pop: compressionPop,
  flush_reclaim: flushReclaim,
  opening_range_break_retest: openingRangeBreakRetest,
};

/** 전체 전략 목록 반환 */
export function getAllStrategies(): ScalpStrategy[] {
  return Object.values(strategyMap);
}

/** ID로 전략 조회 */
export function getStrategy(id: StrategyId): ScalpStrategy | undefined {
  return strategyMap[id];
}

/** 활성 전략만 필터 (config 기반) */
export function getEnabledStrategies(
  strategyConfigs: Partial<Record<StrategyId, { enabled: boolean }>>,
): ScalpStrategy[] {
  return getAllStrategies().filter(s => {
    const conf = strategyConfigs[s.id];
    return conf?.enabled !== false; // 미설정 시 기본 활성
  });
}
