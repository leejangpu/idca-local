/**
 * Quick Scalp v3 — 공통 타입 정의
 *
 * 전략 플러그인, 실행 엔진, 로거가 공유하는 인터페이스/상수.
 */

import { type MinuteBar } from '../../lib/rsiCalculator';

// ========================================
// 전략 ID & 버전
// ========================================

export type StrategyId =
  | 'trend_pullback_resume'       // A: 추세눌림재개
  | 'compression_pop'             // B: 압축후팝업
  | 'flush_reclaim'               // C: 플러시후리클레임
  | 'opening_range_break_retest'; // D: ORB리테스트

export type ExitReason =
  | 'target'
  | 'stop_loss'
  | 'timeout'
  | 'market_close_auction'
  | 'no_follow_through_30s';

export type FillModel = 'conservative' | 'optimistic';

// ========================================
// 설정
// ========================================

export interface StrategySlotConfig {
  enabled: boolean;
  maxSlots: number;
  amountPerStock?: number;  // 미지정 시 전역 amountPerStock 사용
}

export interface MomentumScalpConfigV3 {
  enabled: boolean;
  allocationMode: 'equal' | 'fixed';
  amountPerStock: number;           // 전략별 미지정 시 기본값
  htsUserId: string;
  conditionName: string;
  conditionSeq: string;
  cooldownEnabled?: boolean;
  shadowMode?: boolean;
  pendingBuyTtlMs?: number;

  // v3: 전략별 독립 슬롯/자본
  strategies: Record<StrategyId, StrategySlotConfig>;
}

// ========================================
// 상태
// ========================================

export interface MomentumScalpStateV3 {
  // 기존 필드
  ticker: string;
  stockName: string;
  market: 'domestic';
  status: 'armed' | 'active' | 'pending_buy' | 'pending_sell';
  entryPrice: number | null;
  entryQuantity: number | null;
  targetPrice: number | null;
  stopLossPrice: number | null;
  allocatedAmount: number;
  pendingOrderNo: string | null;
  enteredAt: string | null;
  updatedAt: string;
  sellOrderNo: string | null;
  sellExitReason: ExitReason | null;
  entryBoxPos: number | null;
  boxRangePct: number | null;
  spreadTicks: number | null;
  targetTicks: number | null;
  bestBidAtExit: number | null;
  shadowPendingAt: string | null;
  bestProfitPct: number | null;
  mfe30GateChecked: boolean;
  positiveScore: number | null;
  positiveScoreDetails: string | null;

  // v3.1 armed 상태 필드
  armedAt: string | null;
  armedTriggerLevel: number | null;
  armedTriggerDirection: 'above' | 'below' | null;
  armedDurationMs: number | null;
  armedSignalReason: string | null;

  // v3 추가 필드
  strategyId: StrategyId;
  strategyVersion: string;                    // e.g. "A-1.0", "C-1.0"
  entryMeta: Record<string, unknown> | null;  // 전략별 진입 근거
  mfe60Pct: number | null;                    // 60초 MFE
  mfe120Pct: number | null;                   // 120초 MFE
  mfe60Checked: boolean;
  mfe120Checked: boolean;
  candidateRank: number | null;               // 거래대금 순위 (1-based)
  signalMinuteBucket: string | null;          // 진입 시각 bucket e.g. "09:10"
  fillModel: FillModel | null;
}

// ========================================
// 후보 컨텍스트 (전략에 전달)
// ========================================

export interface CandidateContext {
  ticker: string;
  stockName: string;
  currentPrice: number;
  askPrice: number;
  bidPrice: number;
  spreadTicks: number;
  targetTicks: number;
  minuteBars: MinuteBar[];   // 엔진이 1회 fetch, 전 전략 공유
  currentMinute: number;     // KST 분 (540=09:00)
  todayStr: string;
  candidateRank: number;     // 거래대금 순위 (1-based)
}

// ========================================
// 진입 시그널 (전략 → 엔진)
// ========================================

export interface EntrySignal {
  shouldEnter: boolean;
  reason: string;
  entryMeta: Record<string, unknown>;
  // v3.1: armed 지원 확장
  triggerLevel?: number;                    // armed 확인용 가격
  triggerDirection?: 'above' | 'below';     // 'above' = bid >= triggerLevel 유지
  armDurationMs?: number;                   // armed 관찰 시간 (기본 7000ms)
  nearMiss?: boolean;                       // 진입 근접했으나 실패 (candidate moment 기록용)
}

// ========================================
// 로그 타입
// ========================================

export interface TradeLogEntry {
  type: 'EXIT';
  ticker: string;
  stockName: string;
  market: 'domestic';
  strategyId: StrategyId;
  strategyVersion: string;
  entryPrice: number;
  entryQuantity: number;
  entryAmount: number;
  enteredAt: string;
  allocatedAmount: number;
  exitPrice: number;
  exitAmount: number;
  exitedAt: string;
  exitReason: ExitReason;
  profitAmount: number;
  profitRate: number;
  profitRatePct: number;
  // 진입 조건
  entryBoxPos: number | null;
  boxRangePct: number | null;
  spreadTicks: number | null;
  targetTicks: number | null;
  candidateRank: number | null;
  signalMinuteBucket: string | null;
  fillModel: FillModel | null;
  // 실행 품질
  bestBidAtExit: number | null;
  currentPriceAtExit: number | null;
  timeToExitSec: number | null;
  priceTrail: Array<{ t: string; bid: number; cur: number }>;
  // MFE 추적
  mfe30Pct: number | null;
  mfe60Pct: number | null;
  mfe120Pct: number | null;
  bestProfitPct: number | null;
  // v2.2 호환
  mfe30Ticks: number | null;
  mfe30Gate: 'pass' | 'fail' | 'pending' | null;
  positiveScore: number | null;
  positiveScoreDetails: string | null;
  recentMomentumPct: number | null;
  // 전략별 진입 근거
  entryMeta: Record<string, unknown> | null;
  // v3.1 enriched flat fields (entryMeta에서 복사)
  signalTime: string | null;
  entryTriggerLevel: number | null;
  armElapsedMs: number | null;
  fillElapsedSec: number | null;
  recent3mMomentumPct: number | null;
  ema10DistancePct: number | null;
  ema10Slope: number | null;
  prevHighBreak: boolean | null;
  compression: number | null;
  reclaim: boolean | null;
  grossPnlPct: number | null;
  // 순손익 (수수료/세금 반영)
  netPnlPct: number | null;
  createdAt: string;
}

export interface PendingEntryLogEntry {
  type: 'PENDING_ENTRY';
  ticker: string;
  stockName: string;
  market: 'domestic';
  strategyId: StrategyId;
  strategyVersion: string;
  strategy: 'quickScalp';
  entryPrice: number;
  entryQuantity: number;
  entryAmount: number;
  allocatedAmount: number;
  targetPrice: number;
  stopLossPrice: number;
  shadowPending: boolean;
  candidateRank: number | null;
  signalMinuteBucket: string | null;
  // 진입 조건
  entryBoxPos: number | null;
  boxRangePct: number | null;
  boxHigh: number | null;
  boxLow: number | null;
  spreadTicks: number | null;
  targetTicks: number | null;
  currentPrice: number;
  askPrice: number;
  bidPrice: number;
  recentBars: MinuteBar[];
  entryMeta: Record<string, unknown> | null;
  createdAt: string;
}

// ========================================
// v3.1 Candidate Moment 로그
// ========================================

export interface CandidateMomentLogEntry {
  type: 'CANDIDATE_MOMENT';
  momentType: 'near_miss' | 'armed_fail' | 'armed_timeout';
  ticker: string;
  stockName: string;
  strategyId: StrategyId;
  strategyVersion: string;
  signalReason: string;
  currentPrice: number;
  askPrice: number;
  bidPrice: number;
  triggerLevel: number | null;
  recent3mMomentumPct: number | null;
  ema10DistancePct: number | null;
  ema10Slope: number | null;
  candidateRank: number | null;
  signalMinuteBucket: string | null;
  armElapsedMs: number | null;
  worstPriceDuringArm: number | null;
  createdAt: string;
}

// ========================================
// 상수
// ========================================

/** 왕복 비용 (수수료 + 세금) — 매도 0.23% 기준 */
export const ROUND_TRIP_COST_PCT = 0.0023;

/** 상태 키 생성: "{strategyId}_{ticker}" */
export function makeStateKey(strategyId: StrategyId, ticker: string): string {
  return `${strategyId}_${ticker}`;
}

/** 상태 키 파싱 */
export function parseStateKey(key: string): { strategyId: StrategyId; ticker: string } | null {
  const idx = key.lastIndexOf('_');
  if (idx < 0) {
    // 하위 호환: strategyId 없는 기존 키
    return { strategyId: 'trend_pullback_resume', ticker: key };
  }
  const prefix = key.substring(0, idx);
  const ticker = key.substring(idx + 1);
  const validIds: StrategyId[] = [
    'trend_pullback_resume', 'compression_pop',
    'flush_reclaim', 'opening_range_break_retest',
  ];
  if (validIds.includes(prefix as StrategyId)) {
    return { strategyId: prefix as StrategyId, ticker };
  }
  // 구 ID 하위 호환 → trend_pullback_resume fallback
  const legacyIds = ['opening_range_breakout', 'box_rebound_control'];
  if (legacyIds.includes(prefix)) {
    return { strategyId: 'trend_pullback_resume', ticker };
  }
  // 파싱 실패 시 전체를 ticker로 간주
  return { strategyId: 'trend_pullback_resume', ticker: key };
}

/** 분(minute) → "HH:MM" 5분 버킷 */
export function minuteToBucket(minute: number): string {
  const h = Math.floor(minute / 60);
  const m = Math.floor(minute / 5) * 5;
  const mm = m % 60;
  return `${String(h).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
}
