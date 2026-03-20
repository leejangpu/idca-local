/**
 * Quick Scalp v3 — 로그 기록 모듈
 *
 * scalpTradeLogs, scalpShadowLogs 기록을 공통화.
 * 기존 momentumScalp.ts의 writeTradeLog / writeShadowTradeLog를 분리.
 */

import * as localStore from '../../lib/localStore';
import { getKSTDateString } from '../../lib/marketUtils';
import { type AccountContext } from '../../lib/accountContext';
import {
  type StrategyId,
  type ExitReason,
  type FillModel,
  type TradeLogEntry,
  type CandidateMomentLogEntry,
  ROUND_TRIP_COST_PCT,
} from './scalpTypes';

// 보유 중 가격 궤적 — 전략별 키 "{strategyId}_{ticker}"
const priceTrails = new Map<string, Array<{ t: string; bid: number; cur: number }>>();

// ========================================
// Price Trail 관리
// ========================================

export function getTrailKey(strategyId: StrategyId, ticker: string): string {
  return `${strategyId}_${ticker}`;
}

export function recordPriceTrail(
  strategyId: StrategyId, ticker: string,
  timeStr: string, bid: number, cur: number,
): void {
  const key = getTrailKey(strategyId, ticker);
  if (!priceTrails.has(key)) priceTrails.set(key, []);
  priceTrails.get(key)!.push({ t: timeStr, bid, cur });
}

export function getPriceTrail(strategyId: StrategyId, ticker: string): Array<{ t: string; bid: number; cur: number }> {
  return priceTrails.get(getTrailKey(strategyId, ticker)) || [];
}

export function clearPriceTrail(strategyId: StrategyId, ticker: string): void {
  priceTrails.delete(getTrailKey(strategyId, ticker));
}

// ========================================
// 실전 TradeLog 기록 (scalpTradeLogs)
// ========================================

export function writeTradeLog(
  params: {
    ticker: string;
    stockName: string;
    strategyId: StrategyId;
    strategyVersion: string;
    entryPrice: number;
    entryQuantity: number;
    exitPrice: number;
    exitQuantity: number;
    exitReason: ExitReason;
    allocatedAmount: number;
    enteredAt: string | null;
    entryBoxPos?: number | null;
    boxRangePct?: number | null;
    spreadTicks?: number | null;
    targetTicks?: number | null;
    bestBidAtExit?: number | null;
    mfe30Ticks?: number | null;
    mfe30Gate?: string | null;
    positiveScore?: number | null;
    positiveScoreDetails?: string | null;
    bestProfitPct?: number | null;
    mfe60Pct?: number | null;
    mfe120Pct?: number | null;
    candidateRank?: number | null;
    signalMinuteBucket?: string | null;
    fillModel?: FillModel | null;
    entryMeta?: Record<string, unknown> | null;
  },
  ctx?: AccountContext,
): void {
  const {
    ticker, stockName, strategyId, strategyVersion,
    entryPrice, entryQuantity, exitPrice, exitQuantity,
    exitReason, allocatedAmount, enteredAt,
  } = params;

  const entryAmount = entryPrice * entryQuantity;
  const exitAmount = exitPrice * exitQuantity;
  const profitAmount = exitAmount - entryAmount;
  const profitRate = (exitPrice - entryPrice) / entryPrice;
  const profitRatePct = Number((profitRate * 100).toFixed(2));
  const netPnlPct = Number((profitRatePct - ROUND_TRIP_COST_PCT * 100).toFixed(2));

  let timeToExitSec: number | null = null;
  if (enteredAt) {
    timeToExitSec = Math.round((Date.now() - new Date(enteredAt).getTime()) / 1000);
  }

  const todayStr = getKSTDateString();
  const store = ctx?.store ?? localStore;
  store.appendLog('scalpTradeLogs', todayStr, {
    ticker, stockName, market: 'domestic',
    strategyId, strategyVersion,
    strategy: 'quickScalp',
    entryPrice, entryQuantity, entryAmount,
    enteredAt: enteredAt || new Date().toISOString(),
    allocatedAmount,
    exitPrice, exitQuantity, exitAmount,
    exitedAt: new Date().toISOString(),
    exitReason, profitAmount, profitRate, profitRatePct,
    netPnlPct,
    entryBoxPos: params.entryBoxPos ?? null,
    boxRangePct: params.boxRangePct ?? null,
    spreadTicks: params.spreadTicks ?? null,
    targetTicks: params.targetTicks ?? null,
    candidateRank: params.candidateRank ?? null,
    signalMinuteBucket: params.signalMinuteBucket ?? null,
    fillModel: params.fillModel ?? null,
    bestBidAtExit: params.bestBidAtExit ?? null,
    timeToExitSec,
    mfe30Ticks: params.mfe30Ticks ?? null,
    mfe30Gate: params.mfe30Gate ?? null,
    positiveScore: params.positiveScore ?? null,
    positiveScoreDetails: params.positiveScoreDetails ?? null,
    bestProfitPct: params.bestProfitPct ?? null,
    mfe60Pct: params.mfe60Pct ?? null,
    mfe120Pct: params.mfe120Pct ?? null,
    entryMeta: params.entryMeta ?? null,
    createdAt: new Date().toISOString(),
  });

  console.log(`[QuickScalp:${strategyId}] TradeLog: ${ticker} ${exitReason} ${profitRatePct}% (${timeToExitSec}s)`);
}

// ========================================
// Candidate Moment 로그 (scalpCandidateLogs)
// ========================================

// near_miss 볼륨 제어: 사이클당 전략별 최대 5건
const nearMissCounters = new Map<string, number>();

export function resetNearMissCounters(): void {
  nearMissCounters.clear();
}

export function writeCandidateMomentLog(
  entry: CandidateMomentLogEntry,
  ctx?: AccountContext,
): void {
  // near_miss 볼륨 제어
  if (entry.momentType === 'near_miss') {
    const key = entry.strategyId;
    const count = nearMissCounters.get(key) ?? 0;
    if (count >= 5) return;
    nearMissCounters.set(key, count + 1);
  }

  const store = ctx?.store ?? localStore;
  const todayStr = getKSTDateString();
  store.appendLog('scalpCandidateLogs', todayStr, entry);
}

// ========================================
// Shadow TradeLog 기록 (scalpShadowLogs)
// ========================================

export function writeShadowExitLog(
  params: {
    ticker: string;
    stockName: string;
    strategyId: StrategyId;
    strategyVersion: string;
    entryPrice: number;
    entryQuantity: number;
    exitPrice: number;
    exitReason: ExitReason;
    allocatedAmount: number;
    enteredAt: string | null;
    entryBoxPos?: number | null;
    boxRangePct?: number | null;
    spreadTicks?: number | null;
    targetTicks?: number | null;
    bestBidAtExit?: number | null;
    currentPriceAtExit?: number | null;
    mfe30Ticks?: number | null;
    mfe30Gate?: 'pass' | 'fail' | 'pending' | null;
    positiveScore?: number | null;
    positiveScoreDetails?: string | null;
    recentMomentumPct?: number | null;
    bestProfitPct?: number | null;
    mfe60Pct?: number | null;
    mfe120Pct?: number | null;
    candidateRank?: number | null;
    signalMinuteBucket?: string | null;
    fillModel?: FillModel | null;
    entryMeta?: Record<string, unknown> | null;
  },
  ctx?: AccountContext,
): void {
  const {
    ticker, stockName, strategyId, strategyVersion,
    entryPrice, entryQuantity, exitPrice, exitReason,
    allocatedAmount, enteredAt,
  } = params;

  const entryAmount = entryPrice * entryQuantity;
  const exitAmount = exitPrice * entryQuantity;
  const profitAmount = exitAmount - entryAmount;
  const profitRate = (exitPrice - entryPrice) / entryPrice;
  const profitRatePct = Number((profitRate * 100).toFixed(2));
  const netPnlPct = Number((profitRatePct - ROUND_TRIP_COST_PCT * 100).toFixed(2));

  let timeToExitSec: number | null = null;
  if (enteredAt) {
    timeToExitSec = Math.round((Date.now() - new Date(enteredAt).getTime()) / 1000);
  }

  const todayStr = getKSTDateString();
  const store = ctx?.store ?? localStore;
  const trail = getPriceTrail(strategyId, ticker);

  // enriched flat fields from entryMeta
  const meta = params.entryMeta ?? {};

  const entry: TradeLogEntry = {
    type: 'EXIT',
    ticker, stockName, market: 'domestic',
    strategyId, strategyVersion,
    entryPrice, entryQuantity, entryAmount,
    enteredAt: enteredAt || new Date().toISOString(),
    allocatedAmount,
    exitPrice, exitAmount,
    exitedAt: new Date().toISOString(),
    exitReason, profitAmount, profitRate, profitRatePct, netPnlPct,
    entryBoxPos: params.entryBoxPos ?? null,
    boxRangePct: params.boxRangePct ?? null,
    spreadTicks: params.spreadTicks ?? null,
    targetTicks: params.targetTicks ?? null,
    candidateRank: params.candidateRank ?? null,
    signalMinuteBucket: params.signalMinuteBucket ?? null,
    fillModel: params.fillModel ?? null,
    bestBidAtExit: params.bestBidAtExit ?? null,
    currentPriceAtExit: params.currentPriceAtExit ?? null,
    timeToExitSec,
    priceTrail: trail,
    mfe30Pct: null,
    mfe60Pct: params.mfe60Pct ?? null,
    mfe120Pct: params.mfe120Pct ?? null,
    bestProfitPct: params.bestProfitPct ?? null,
    mfe30Ticks: params.mfe30Ticks ?? null,
    mfe30Gate: params.mfe30Gate ?? null,
    positiveScore: params.positiveScore ?? null,
    positiveScoreDetails: params.positiveScoreDetails ?? null,
    recentMomentumPct: params.recentMomentumPct ?? null,
    entryMeta: params.entryMeta ?? null,
    // v3.1 enriched flat fields
    signalTime: (meta.signalTime as string) ?? enteredAt ?? null,
    entryTriggerLevel: (meta.pullbackBarHigh as number) ?? (meta.compressionTop as number) ?? (meta.openRangeHigh as number) ?? null,
    armElapsedMs: (meta.armElapsedMs as number) ?? null,
    fillElapsedSec: timeToExitSec !== null ? null : null, // filled via shadow entry log
    recent3mMomentumPct: (meta.recentMomentumPct as number) ?? null,
    ema10DistancePct: (meta.ema10DistancePct as number) ?? null,
    ema10Slope: (meta.ema10Slope as number) ?? null,
    prevHighBreak: (meta.prevHighBreak as boolean) ?? null,
    compression: (meta.compressionRatio as number) ?? null,
    reclaim: (meta.ema10Reclaim as boolean) ?? null,
    grossPnlPct: profitRatePct,
    createdAt: new Date().toISOString(),
  };

  store.appendLog('scalpShadowLogs', todayStr, entry);

  // 가격 궤적 정리
  clearPriceTrail(strategyId, ticker);

  console.log(`[QuickScalp:${strategyId}] ShadowExit: ${ticker} ${exitReason} ${profitRatePct}% (${timeToExitSec}s)`);
}

// ========================================
// Shadow 진입 로그
// ========================================

export function writeShadowPendingEntryLog(
  params: {
    ticker: string;
    stockName: string;
    strategyId: StrategyId;
    strategyVersion: string;
    entryPrice: number;
    entryQuantity: number;
    allocatedAmount: number;
    targetPrice: number;
    stopLossPrice: number;
    entryBoxPos: number | null;
    boxRangePct: number | null;
    boxHigh: number | null;
    boxLow: number | null;
    spreadTicks: number | null;
    targetTicks: number | null;
    currentPrice: number;
    askPrice: number;
    bidPrice: number;
    recentBars: { t: string; o: number; h: number; l: number; c: number }[];
    candidateRank: number | null;
    signalMinuteBucket: string | null;
    entryMeta: Record<string, unknown> | null;
  },
  ctx?: AccountContext,
): void {
  const store = ctx?.store ?? localStore;
  const todayStr = getKSTDateString();

  store.appendLog('scalpShadowLogs', todayStr, {
    type: 'PENDING_ENTRY',
    ticker: params.ticker,
    stockName: params.stockName,
    market: 'domestic',
    strategyId: params.strategyId,
    strategyVersion: params.strategyVersion,
    strategy: 'quickScalp',
    entryPrice: params.entryPrice,
    entryQuantity: params.entryQuantity,
    entryAmount: params.entryPrice * params.entryQuantity,
    allocatedAmount: params.allocatedAmount,
    targetPrice: params.targetPrice,
    stopLossPrice: params.stopLossPrice,
    shadowPending: true,
    candidateRank: params.candidateRank,
    signalMinuteBucket: params.signalMinuteBucket,
    entryBoxPos: params.entryBoxPos,
    boxRangePct: params.boxRangePct,
    boxHigh: params.boxHigh,
    boxLow: params.boxLow,
    spreadTicks: params.spreadTicks,
    targetTicks: params.targetTicks,
    currentPrice: params.currentPrice,
    askPrice: params.askPrice,
    bidPrice: params.bidPrice,
    recentBars: params.recentBars,
    entryMeta: params.entryMeta,
    createdAt: new Date().toISOString(),
  });
}

// ========================================
// Shadow 체결/취소 로그
// ========================================

export function writeShadowEntryLog(
  params: {
    ticker: string;
    stockName: string;
    strategyId: StrategyId;
    strategyVersion: string;
    entryPrice: number;
    entryQuantity: number;
    allocatedAmount: number;
    targetPrice: number;
    stopLossPrice: number;
    fillElapsedSec: number;
    fillBid: number;
    fillAsk: number;
    fillModel: FillModel;
    fillOptimisticWouldFill: boolean;
    entryBoxPos: number | null;
    boxRangePct: number | null;
    spreadTicks: number | null;
    targetTicks: number | null;
    entryMeta: Record<string, unknown> | null;
  },
  ctx?: AccountContext,
): void {
  const store = ctx?.store ?? localStore;
  const todayStr = getKSTDateString();

  store.appendLog('scalpShadowLogs', todayStr, {
    type: 'ENTRY',
    ticker: params.ticker,
    stockName: params.stockName,
    market: 'domestic',
    strategyId: params.strategyId,
    strategyVersion: params.strategyVersion,
    strategy: 'quickScalp',
    entryPrice: params.entryPrice,
    entryQuantity: params.entryQuantity,
    entryAmount: params.entryPrice * params.entryQuantity,
    allocatedAmount: params.allocatedAmount,
    targetPrice: params.targetPrice,
    stopLossPrice: params.stopLossPrice,
    shadowFilled: true,
    fillElapsedSec: params.fillElapsedSec,
    fillBid: params.fillBid,
    fillAsk: params.fillAsk,
    fillModel: params.fillModel,
    fillOptimisticWouldFill: params.fillOptimisticWouldFill,
    entryBoxPos: params.entryBoxPos,
    boxRangePct: params.boxRangePct,
    spreadTicks: params.spreadTicks,
    targetTicks: params.targetTicks,
    entryMeta: params.entryMeta,
    createdAt: new Date().toISOString(),
  });
}

export function writeShadowCancelLog(
  params: {
    ticker: string;
    stockName: string;
    strategyId: StrategyId;
    strategyVersion: string;
    reason: string;
    elapsedSec: number;
    entryPrice: number;
    currentBid: number;
    lastAsk: number;
    fillConservativeAtCancel: boolean;
    fillOptimisticAtCancel: boolean;
    allocatedAmount: number;
  },
  ctx?: AccountContext,
): void {
  const store = ctx?.store ?? localStore;
  const todayStr = getKSTDateString();

  store.appendLog('scalpShadowLogs', todayStr, {
    type: 'CANCEL',
    ticker: params.ticker,
    stockName: params.stockName,
    market: 'domestic',
    strategyId: params.strategyId,
    strategyVersion: params.strategyVersion,
    strategy: 'quickScalp',
    reason: params.reason,
    elapsedSec: params.elapsedSec,
    entryPrice: params.entryPrice,
    currentBid: params.currentBid,
    lastAsk: params.lastAsk,
    fillConservativeAtCancel: params.fillConservativeAtCancel,
    fillOptimisticAtCancel: params.fillOptimisticAtCancel,
    allocatedAmount: params.allocatedAmount,
    createdAt: new Date().toISOString(),
  });
}
