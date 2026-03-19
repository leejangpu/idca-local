/**
 * 단타 v1 — 로그 모듈
 *
 * 로그 컬렉션별 기록:
 * - dantaScanLogs: 조건검색 결과 & 후보 상태 변화
 * - dantaOrderLogs: 주문 기록 (매수/매도)
 * - dantaTradeLogs / dantaShadowLogs: 거래 완결 기록
 */

import * as localStore from '../../lib/localStore';
import { getKSTDateString } from '../../lib/marketUtils';
import { type AccountContext } from '../../lib/accountContext';
import {
  type OrderLogEntry,
  type TradeLogEntry,
  type DantaCandidate,
  type CandidatePhase,
  DANTA_TRADE_LOGS,
  DANTA_SHADOW_LOGS,
  DANTA_SCAN_LOGS,
  DANTA_ORDER_LOGS,
} from './dantaTypes';

const TAG = '[DantaV1]';

function getStore(ctx?: AccountContext) {
  return ctx?.store ?? localStore;
}

// ========================================
// 조건검색 결과 로그
// ========================================

export function logConditionResult(
  params: {
    conditionSeq: string;
    conditionName: string;
    totalCandidates: number;
    newCandidates: number;
    candidates: Array<{ code: string; name: string; price: string; tradeAmt: string }>;
  },
  ctx?: AccountContext,
): void {
  const store = getStore(ctx);
  store.appendLog(DANTA_SCAN_LOGS, getKSTDateString(), {
    type: 'CONDITION_RESULT',
    ...params,
    timestamp: new Date().toISOString(),
  });
  console.log(`${TAG} Scan: ${params.totalCandidates} found, ${params.newCandidates} new`);
}

// ========================================
// 후보 상태 전이 로그
// ========================================

export function logCandidatePhaseChange(
  candidate: DantaCandidate,
  fromPhase: CandidatePhase,
  toPhase: CandidatePhase | 'ENTERED' | 'EXPIRED',
  reason: string,
  ctx?: AccountContext,
): void {
  const store = getStore(ctx);
  store.appendLog(DANTA_SCAN_LOGS, getKSTDateString(), {
    type: 'PHASE_CHANGE',
    ticker: candidate.ticker,
    stockName: candidate.stockName,
    fromPhase,
    toPhase,
    reason,
    triggerHigh: candidate.triggerHigh,
    pullbackLow: candidate.pullbackLow,
    lastPrice: candidate.lastPrice,
    tradeAmt: candidate.tradeAmt,
    timestamp: new Date().toISOString(),
  });
  console.log(`${TAG} ${candidate.ticker} ${fromPhase} → ${toPhase}: ${reason}`);
}

// ========================================
// 주문 로그
// ========================================

export function logOrder(entry: OrderLogEntry, ctx?: AccountContext): void {
  const store = getStore(ctx);
  store.appendLog(DANTA_ORDER_LOGS, getKSTDateString(), entry);
  const mode = entry.shadowMode ? 'SHADOW' : 'REAL';
  console.log(`${TAG} [${mode}] ${entry.type} ${entry.ticker} ${entry.quantity}주 @ ${entry.price} (${entry.reason})`);
}

// ========================================
// 거래 완결 로그 (실전/쉐도우 분기)
// ========================================

export function logTradeComplete(entry: TradeLogEntry, ctx?: AccountContext): void {
  const store = getStore(ctx);
  const todayStr = getKSTDateString();
  const collection = entry.shadowMode ? DANTA_SHADOW_LOGS : DANTA_TRADE_LOGS;

  store.appendLog(collection, todayStr, {
    type: 'EXIT',
    ...entry,
  });

  const mode = entry.shadowMode ? 'SHADOW' : 'REAL';
  const sign = entry.profitRatePct >= 0 ? '+' : '';
  console.log(
    `${TAG} [${mode}] EXIT ${entry.ticker} ${entry.exitReason} ` +
    `${sign}${entry.profitRatePct}% (net ${sign}${entry.netPnlPct}%) ` +
    `${entry.holdTimeSec}s`,
  );
}

// ========================================
// 진입 상세 로그 (shadow 검증용)
// ========================================

export function logEntryDetail(
  params: {
    ticker: string;
    stockName: string;
    triggerHigh: number;
    breakoutLevel: number;
    pullbackLow: number;
    currentPrice: number;
    askPrice: number;
    bidPrice: number;
    bidQty1: number;
    entryPrice: number;
    quantity: number;
    targetPrice: number;
    stopLossPrice: number;
    candidateAgeMs: number;
    shadowMode: boolean;
  },
  ctx?: AccountContext,
): void {
  const store = getStore(ctx);
  store.appendLog(DANTA_ORDER_LOGS, getKSTDateString(), {
    type: 'ENTRY_DETAIL',
    ...params,
    timestamp: new Date().toISOString(),
  });
}

// ========================================
// 청산 상세 로그 (shadow 검증용)
// ========================================

export function logExitDetail(
  params: {
    ticker: string;
    exitReason: string;
    entryPrice: number;
    exitPrice: number;
    currentPrice: number;
    bidPrice: number;
    targetPrice: number;
    stopLossPrice: number;
    pullbackLow: number;
    triggerHigh: number;
    holdTimeMs: number;
    mfePct: number;
    maePct: number;
    hasReachedPlusOneTick: boolean;
    hasReachedPlusTwoTicks: boolean;
    kstMinute: number;
    shadowMode: boolean;
  },
  ctx?: AccountContext,
): void {
  const store = getStore(ctx);
  const collection = params.shadowMode ? DANTA_SHADOW_LOGS : DANTA_TRADE_LOGS;
  store.appendLog(collection, getKSTDateString(), {
    type: 'EXIT_DETAIL',
    ...params,
    timestamp: new Date().toISOString(),
  });
}

// ========================================
// 에러 로그
// ========================================

export function logError(component: string, error: unknown, ctx?: AccountContext): void {
  const store = getStore(ctx);
  const msg = error instanceof Error ? error.message : String(error);
  store.appendLog(DANTA_SCAN_LOGS, getKSTDateString(), {
    type: 'ERROR',
    component,
    message: msg,
    timestamp: new Date().toISOString(),
  });
  console.error(`${TAG} [${component}] ERROR:`, msg);
}

// ========================================
// 일일 요약
// ========================================

export function logDailySummary(
  summary: {
    totalTrades: number;
    wins: number;
    losses: number;
    totalPnl: number;
    netPnl: number;
    shadowMode: boolean;
  },
  ctx?: AccountContext,
): void {
  const store = getStore(ctx);
  store.appendLog(DANTA_SCAN_LOGS, getKSTDateString(), {
    type: 'DAILY_SUMMARY',
    ...summary,
    winRate: summary.totalTrades > 0
      ? Number((summary.wins / summary.totalTrades * 100).toFixed(1))
      : 0,
    timestamp: new Date().toISOString(),
  });
  const mode = summary.shadowMode ? 'SHADOW' : 'REAL';
  console.log(
    `${TAG} [${mode}] Daily: ${summary.wins}W/${summary.losses}L ` +
    `PnL=${summary.netPnl.toLocaleString()}원`,
  );
}
