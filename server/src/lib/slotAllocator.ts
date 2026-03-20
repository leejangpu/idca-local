/**
 * 모멘텀 스캘핑 슬롯 배분 계산기 — 로컬 버전
 * Firestore → localStore 전환
 *
 * v3: strategyId 기반 composite key 지원 추가
 *     상태 키: "{strategyId}_{ticker}" (하위 호환: 기존 "{ticker}" 키도 읽기 가능)
 */

import { KisApiClient } from './kisApi';
import { isKRMarketOpen } from './marketUtils';
import { getUserTelegramChatId, sendTelegramMessage } from './telegram';
import * as localStore from './localStore';
import { type AccountStore } from './localStore';
import {
  type StrategyId,
  type MomentumScalpStateV3,
  type StrategySlotConfig,
  makeStateKey,
  parseStateKey,
} from '../runners/scalp/scalpTypes';

// ========================================
// 타입 정의
// ========================================

export interface SlotAllocationParams {
  slotCount: number;
  occupiedTickers: string[];
  availableCash: number;
  allocationMode: 'equal' | 'fixed';
  amountPerStock: number;
}

export interface SlotAllocationResult {
  emptySlotCount: number;
  occupiedSlotCount: number;
  amountPerSlot: number;
  fillableSlotCount: number;
  skippedReason: string | null;
}

export interface MomentumScalpConfig {
  enabled: boolean;
  slotCount: number;
  allocationMode: 'equal' | 'fixed';
  amountPerStock: number;
  htsUserId: string;
  conditionName: string;
  conditionSeq: string;
  cooldownEnabled?: boolean;
  shadowMode?: boolean;
  // v2.2
  pendingBuyTtlMs?: number;           // pending_buy TTL (ms), 기본 15000
  positiveScoreGateEnabled?: boolean;  // score >= 3 하드 게이트 ON/OFF, 기본 false
  positiveScoreMinimum?: number;       // 하드 게이트 최소 점수, 기본 3
}

export interface MomentumScalpState {
  ticker: string;
  stockName: string;
  market: 'domestic';
  status: 'active' | 'pending_buy' | 'pending_sell';
  entryPrice: number | null;
  entryQuantity: number | null;
  targetPrice: number | null;
  stopLossPrice: number | null;
  allocatedAmount: number;
  pendingOrderNo: string | null;
  enteredAt: string | null;
  updatedAt: string;
  sellOrderNo: string | null;
  sellExitReason: 'target' | 'stop_loss' | 'timeout' | 'market_close_auction' | 'no_follow_through_30s' | null;
  entryBoxPos: number | null;
  boxRangePct: number | null;
  spreadTicks: number | null;
  targetTicks: number | null;
  bestBidAtExit: number | null;
  // v2.1
  shadowPendingAt: string | null;  // shadow pending_buy 생성 시각
  bestProfitPct: number | null;    // MFE 추적 (보유 중 최대 수익률 %)
  // v2.2
  mfe30GateChecked: boolean;       // 30초 MFE 게이트 평가 완료 여부
  positiveScore: number | null;    // 진입 전 positive selection 점수
  positiveScoreDetails: string | null;  // 점수 세부 사항
}

export interface SlotRefillResult {
  fillableSlotCount: number;
  amountPerSlot: number;
  occupiedTickers: string[];
  skippedReason: string | null;
}

const STATE_COLLECTION = 'momentumScalpState';

// ========================================
// calculateSlotAllocation — 순수 함수
// ========================================

export function calculateSlotAllocation(params: SlotAllocationParams): SlotAllocationResult {
  const { slotCount, occupiedTickers, availableCash, allocationMode, amountPerStock } = params;
  const occupiedSlotCount = occupiedTickers.length;
  const emptySlotCount = Math.max(0, slotCount - occupiedSlotCount);

  if (emptySlotCount <= 0) {
    return { emptySlotCount: 0, occupiedSlotCount, amountPerSlot: 0, fillableSlotCount: 0, skippedReason: null };
  }

  if (allocationMode === 'equal') {
    const amountPerSlot = Math.floor(availableCash / emptySlotCount);
    if (amountPerSlot < 10000) {
      return { emptySlotCount, occupiedSlotCount, amountPerSlot: 0, fillableSlotCount: 0,
        skippedReason: `예수금(${availableCash.toLocaleString()}원) 부족 (슬롯당 최소 10,000원 필요)` };
    }
    return { emptySlotCount, occupiedSlotCount, amountPerSlot, fillableSlotCount: emptySlotCount, skippedReason: null };
  }

  const fillableSlotCount = Math.min(emptySlotCount, Math.floor(availableCash / amountPerStock));
  if (fillableSlotCount <= 0) {
    return { emptySlotCount, occupiedSlotCount, amountPerSlot: 0, fillableSlotCount: 0,
      skippedReason: `예수금(${availableCash.toLocaleString()}원) 부족 (종목당 ${amountPerStock.toLocaleString()}원 필요)` };
  }
  return { emptySlotCount, occupiedSlotCount, amountPerSlot: amountPerStock, fillableSlotCount, skippedReason: null };
}

// ========================================
// 예수금 조회
// ========================================

export async function queryAvailableCash(
  kisClient: KisApiClient, appKey: string, appSecret: string, accessToken: string, accountNo: string
): Promise<number> {
  const maxRetries = 3;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const balanceResp = await kisClient.getDomesticBalance(appKey, appSecret, accessToken, accountNo);
      const cashStr = balanceResp.output2?.[0]?.dnca_tot_amt;
      if (!cashStr) throw new Error('예수금 필드(dnca_tot_amt)가 응답에 없습니다');
      return parseInt(cashStr, 10);
    } catch (err) {
      console.error(`[MomentumScalp] 예수금 조회 실패 (${attempt}/${maxRetries}):`, err);
      if (attempt === maxRetries) throw new Error(`예수금 조회 ${maxRetries}회 실패: ${err instanceof Error ? err.message : String(err)}`);
      await new Promise(resolve => setTimeout(resolve, 500));
    }
  }
  throw new Error('예수금 조회 실패');
}

// ========================================
// State CRUD — localStore 기반
// ========================================

export function getOccupiedTickers(store?: AccountStore): string[] {
  const all = (store ?? localStore).getAllStates<MomentumScalpState>(STATE_COLLECTION);
  const result: string[] = [];
  for (const [, s] of all) {
    if (['active', 'pending_buy', 'pending_sell'].includes(s.status)) {
      result.push(s.ticker);
    }
  }
  return result;
}

export function createMomentumScalpState(
  ticker: string, stockName: string, allocatedAmount: number,
  pendingOrderNo: string | null,
  entryConditions?: { entryBoxPos: number | null; boxRangePct: number | null; spreadTicks: number | null; targetTicks: number | null },
  store?: AccountStore,
  shadowPendingAt?: string | null
): void {
  (store ?? localStore).setState(STATE_COLLECTION, ticker, {
    ticker, stockName, market: 'domestic', status: 'pending_buy',
    entryPrice: null, entryQuantity: null, targetPrice: null, stopLossPrice: null,
    allocatedAmount, pendingOrderNo, enteredAt: null, sellOrderNo: null, sellExitReason: null,
    entryBoxPos: entryConditions?.entryBoxPos ?? null, boxRangePct: entryConditions?.boxRangePct ?? null,
    spreadTicks: entryConditions?.spreadTicks ?? null, targetTicks: entryConditions?.targetTicks ?? null,
    shadowPendingAt: shadowPendingAt ?? null, bestProfitPct: null,
    mfe30GateChecked: false, positiveScore: null, positiveScoreDetails: null,
  });
}

export function updateMomentumScalpStateToActive(
  ticker: string, entryPrice: number, entryQuantity: number,
  targetPrice: number | null, stopLossPrice: number | null,
  store?: AccountStore
): void {
  (store ?? localStore).updateState(STATE_COLLECTION, ticker, {
    status: 'active', entryPrice, entryQuantity, targetPrice, stopLossPrice,
    pendingOrderNo: null, enteredAt: new Date().toISOString(),
    shadowPendingAt: null, bestProfitPct: 0, mfe30GateChecked: false,
  });
}

export function deleteMomentumScalpState(ticker: string, store?: AccountStore): void {
  (store ?? localStore).deleteState(STATE_COLLECTION, ticker);
}

export function updateMomentumScalpStateToPendingSell(
  ticker: string, sellOrderNo: string,
  sellExitReason: 'target' | 'stop_loss' | 'timeout' | 'market_close_auction' | 'no_follow_through_30s',
  bestBidAtExit?: number | null,
  store?: AccountStore
): void {
  (store ?? localStore).updateState(STATE_COLLECTION, ticker, {
    status: 'pending_sell', sellOrderNo, sellExitReason, bestBidAtExit: bestBidAtExit ?? null,
  });
}

export function revertMomentumScalpStateToActive(ticker: string, store?: AccountStore): void {
  (store ?? localStore).updateState(STATE_COLLECTION, ticker, {
    status: 'active', sellOrderNo: null, sellExitReason: null,
  });
}

export function getMomentumScalpStateByTicker(ticker: string, store?: AccountStore): MomentumScalpState | null {
  return (store ?? localStore).getState<MomentumScalpState>(STATE_COLLECTION, ticker);
}

// ========================================
// processSlotRefill — 통합 함수
// ========================================

export async function processSlotRefill(
  config: MomentumScalpConfig, kisClient: KisApiClient,
  appKey: string, appSecret: string, accessToken: string, accountNo: string,
  store?: AccountStore
): Promise<SlotRefillResult> {
  const occupiedTickers = getOccupiedTickers(store);

  if (occupiedTickers.length >= config.slotCount) {
    return { fillableSlotCount: 0, amountPerSlot: 0, occupiedTickers, skippedReason: null };
  }

  if (!isKRMarketOpen()) {
    return { fillableSlotCount: 0, amountPerSlot: 0, occupiedTickers, skippedReason: '장마감 후 리필 방지' };
  }

  let availableCash: number;
  try {
    availableCash = await queryAvailableCash(kisClient, appKey, appSecret, accessToken, accountNo);
  } catch (err) {
    await sendSlotRefillAlert('예수금 조회 실패', `${err instanceof Error ? err.message : String(err)}`);
    return { fillableSlotCount: 0, amountPerSlot: 0, occupiedTickers, skippedReason: '예수금 조회 실패' };
  }

  const allocation = calculateSlotAllocation({
    slotCount: config.slotCount, occupiedTickers, availableCash,
    allocationMode: config.allocationMode || 'fixed', amountPerStock: config.amountPerStock,
  });

  if (allocation.skippedReason) {
    await sendSlotRefillAlert('슬롯 리필 건너뜀', allocation.skippedReason);
  }

  return {
    fillableSlotCount: allocation.fillableSlotCount, amountPerSlot: allocation.amountPerSlot,
    occupiedTickers, skippedReason: allocation.skippedReason,
  };
}

// ========================================
// 텔레그램 알림
// ========================================

async function sendSlotRefillAlert(title: string, detail: string): Promise<void> {
  try {
    const chatId = await getUserTelegramChatId();
    if (chatId) {
      await sendTelegramMessage(chatId, `⚠️ <b>[모멘텀 스캘핑] ${title}</b>\n\n${detail}`, 'HTML');
    }
  } catch (err) {
    console.error('[MomentumScalp] 텔레그램 알림 발송 실패:', err);
  }
}

// ========================================
// v3: 전략별 독립 슬롯 관리
// ========================================

/**
 * 특정 전략의 점유 상태키 목록 반환
 * 키 형식: "{strategyId}_{ticker}"
 */
export function getOccupiedStateKeysByStrategy(
  strategyId: StrategyId, store?: AccountStore,
): string[] {
  const all = (store ?? localStore).getAllStates<MomentumScalpStateV3>(STATE_COLLECTION);
  const result: string[] = [];
  for (const [key, s] of all) {
    if (!['armed', 'active', 'pending_buy', 'pending_sell'].includes(s.status)) continue;
    const parsed = parseStateKey(key);
    if (parsed && parsed.strategyId === strategyId) {
      result.push(key);
    }
  }
  return result;
}

/**
 * 특정 전략의 점유 ticker 목록 (raw ticker)
 */
export function getOccupiedTickersByStrategy(
  strategyId: StrategyId, store?: AccountStore,
): string[] {
  return getOccupiedStateKeysByStrategy(strategyId, store).map(key => {
    const parsed = parseStateKey(key);
    return parsed ? parsed.ticker : key;
  });
}

/**
 * 전 전략 통합 점유 ticker Set (타 전략 중복 체크용)
 * momentumScalp 내 모든 전략의 활성 종목을 반환
 */
export function getAllScalpOccupiedTickers(store?: AccountStore): Set<string> {
  const all = (store ?? localStore).getAllStates<MomentumScalpStateV3>(STATE_COLLECTION);
  const result = new Set<string>();
  for (const [key, s] of all) {
    if (!['armed', 'active', 'pending_buy', 'pending_sell'].includes(s.status)) continue;
    const parsed = parseStateKey(key);
    result.add(parsed ? parsed.ticker : key);
  }
  return result;
}

/**
 * v3 전략별 슬롯 여유 계산 (shadow 독립 — 전략별 가상 계정)
 * shadow에서는 예수금 무제한, 슬롯만 전략별 maxSlots 기준 체크
 */
export function calculateStrategySlotAvailability(
  strategyId: StrategyId,
  strategyConfig: StrategySlotConfig,
  globalAmountPerStock: number,
  isShadow: boolean,
  store?: AccountStore,
): { fillable: boolean; occupiedCount: number; maxSlots: number; amountPerSlot: number } {
  const occupiedKeys = getOccupiedStateKeysByStrategy(strategyId, store);
  const occupiedCount = occupiedKeys.length;
  const maxSlots = strategyConfig.maxSlots;
  const amountPerSlot = strategyConfig.amountPerStock ?? globalAmountPerStock;

  if (occupiedCount >= maxSlots) {
    return { fillable: false, occupiedCount, maxSlots, amountPerSlot };
  }

  // shadow에서는 항상 진입 가능 (가상 자본)
  return { fillable: true, occupiedCount, maxSlots, amountPerSlot };
}

/**
 * v3 상태 생성 — composite key "{strategyId}_{ticker}"
 */
export function createMomentumScalpStateV3(
  strategyId: StrategyId,
  strategyVersion: string,
  ticker: string,
  stockName: string,
  allocatedAmount: number,
  pendingOrderNo: string | null,
  entryConditions?: {
    entryBoxPos: number | null;
    boxRangePct: number | null;
    spreadTicks: number | null;
    targetTicks: number | null;
  },
  entryMeta?: Record<string, unknown> | null,
  extraFields?: {
    candidateRank?: number | null;
    signalMinuteBucket?: string | null;
    fillModel?: string | null;
  },
  store?: AccountStore,
  shadowPendingAt?: string | null,
): void {
  const stateKey = makeStateKey(strategyId, ticker);
  (store ?? localStore).setState(STATE_COLLECTION, stateKey, {
    ticker,
    stockName,
    market: 'domestic',
    status: 'pending_buy',
    strategyId,
    strategyVersion,
    entryPrice: null,
    entryQuantity: null,
    targetPrice: null,
    stopLossPrice: null,
    allocatedAmount,
    pendingOrderNo,
    enteredAt: null,
    updatedAt: new Date().toISOString(),
    sellOrderNo: null,
    sellExitReason: null,
    entryBoxPos: entryConditions?.entryBoxPos ?? null,
    boxRangePct: entryConditions?.boxRangePct ?? null,
    spreadTicks: entryConditions?.spreadTicks ?? null,
    targetTicks: entryConditions?.targetTicks ?? null,
    bestBidAtExit: null,
    shadowPendingAt: shadowPendingAt ?? null,
    bestProfitPct: null,
    mfe30GateChecked: false,
    mfe60Pct: null,
    mfe120Pct: null,
    mfe60Checked: false,
    mfe120Checked: false,
    positiveScore: null,
    positiveScoreDetails: null,
    entryMeta: entryMeta ?? null,
    candidateRank: extraFields?.candidateRank ?? null,
    signalMinuteBucket: extraFields?.signalMinuteBucket ?? null,
    fillModel: (extraFields?.fillModel as MomentumScalpStateV3['fillModel']) ?? null,
    // v3.1 armed fields
    armedAt: null,
    armedTriggerLevel: null,
    armedTriggerDirection: null,
    armedDurationMs: null,
    armedSignalReason: null,
  } satisfies MomentumScalpStateV3);
}

/**
 * v3 상태 → active 전환
 */
export function updateScalpStateToActiveV3(
  strategyId: StrategyId,
  ticker: string,
  entryPrice: number,
  entryQuantity: number,
  targetPrice: number | null,
  stopLossPrice: number | null,
  fillModel?: string | null,
  store?: AccountStore,
): void {
  const stateKey = makeStateKey(strategyId, ticker);
  (store ?? localStore).updateState(STATE_COLLECTION, stateKey, {
    status: 'active',
    entryPrice,
    entryQuantity,
    targetPrice,
    stopLossPrice,
    pendingOrderNo: null,
    enteredAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    shadowPendingAt: null,
    bestProfitPct: 0,
    mfe30GateChecked: false,
    mfe60Pct: null,
    mfe120Pct: null,
    mfe60Checked: false,
    mfe120Checked: false,
    fillModel: fillModel ?? null,
  });
}

/**
 * v3 상태 삭제
 */
export function deleteScalpStateV3(
  strategyId: StrategyId, ticker: string, store?: AccountStore,
): void {
  const stateKey = makeStateKey(strategyId, ticker);
  (store ?? localStore).deleteState(STATE_COLLECTION, stateKey);
}

/**
 * v3 상태 조회
 */
export function getScalpStateV3(
  strategyId: StrategyId, ticker: string, store?: AccountStore,
): MomentumScalpStateV3 | null {
  const stateKey = makeStateKey(strategyId, ticker);
  return (store ?? localStore).getState<MomentumScalpStateV3>(STATE_COLLECTION, stateKey);
}

/**
 * v3 상태 → pending_sell 전환
 */
export function updateScalpStateToPendingSellV3(
  strategyId: StrategyId,
  ticker: string,
  sellOrderNo: string,
  sellExitReason: 'target' | 'stop_loss' | 'timeout' | 'market_close_auction' | 'no_follow_through_30s',
  bestBidAtExit?: number | null,
  store?: AccountStore,
): void {
  const stateKey = makeStateKey(strategyId, ticker);
  (store ?? localStore).updateState(STATE_COLLECTION, stateKey, {
    status: 'pending_sell',
    sellOrderNo,
    sellExitReason,
    bestBidAtExit: bestBidAtExit ?? null,
    updatedAt: new Date().toISOString(),
  });
}

/**
 * v3 상태 → active 복귀 (pending_sell 실패 시)
 */
export function revertScalpStateToActiveV3(
  strategyId: StrategyId, ticker: string, store?: AccountStore,
): void {
  const stateKey = makeStateKey(strategyId, ticker);
  (store ?? localStore).updateState(STATE_COLLECTION, stateKey, {
    status: 'active',
    sellOrderNo: null,
    sellExitReason: null,
    updatedAt: new Date().toISOString(),
  });
}

/**
 * v3 전체 상태 순회 — sell loop에서 사용
 * 모든 momentumScalpState를 순회하며 v3 필드 포함 반환
 */
export function getAllScalpStatesV3(store?: AccountStore): Map<string, MomentumScalpStateV3> {
  const all = (store ?? localStore).getAllStates<MomentumScalpStateV3>(STATE_COLLECTION);
  // 하위 호환: strategyId 없는 기존 상태에 기본값 부여
  for (const [, state] of all) {
    if (!state.strategyId) {
      state.strategyId = 'trend_pullback_resume';
      state.strategyVersion = '0.0';
    }
    if (state.entryMeta === undefined) state.entryMeta = null;
    if (state.mfe60Pct === undefined) state.mfe60Pct = null;
    if (state.mfe120Pct === undefined) state.mfe120Pct = null;
    if (state.mfe60Checked === undefined) state.mfe60Checked = false;
    if (state.mfe120Checked === undefined) state.mfe120Checked = false;
    if (state.candidateRank === undefined) (state as any).candidateRank = null;
    if (state.signalMinuteBucket === undefined) (state as any).signalMinuteBucket = null;
    if (state.fillModel === undefined) (state as any).fillModel = null;
    // v3.1 armed fields
    if (state.armedAt === undefined) state.armedAt = null;
    if (state.armedTriggerLevel === undefined) state.armedTriggerLevel = null;
    if (state.armedTriggerDirection === undefined) state.armedTriggerDirection = null;
    if (state.armedDurationMs === undefined) state.armedDurationMs = null;
    if (state.armedSignalReason === undefined) state.armedSignalReason = null;
  }
  return all;
}

/**
 * v3.1 armed 상태 생성
 */
export function createArmedScalpStateV3(
  strategyId: StrategyId,
  strategyVersion: string,
  ticker: string,
  stockName: string,
  allocatedAmount: number,
  triggerLevel: number,
  triggerDirection: 'above' | 'below',
  armDurationMs: number,
  signalReason: string,
  entryConditions?: {
    entryBoxPos: number | null;
    boxRangePct: number | null;
    spreadTicks: number | null;
    targetTicks: number | null;
  },
  entryMeta?: Record<string, unknown> | null,
  extraFields?: {
    candidateRank?: number | null;
    signalMinuteBucket?: string | null;
    fillModel?: string | null;
    entryPrice?: number | null;
    entryQuantity?: number | null;
    targetPrice?: number | null;
    stopLossPrice?: number | null;
  },
  store?: AccountStore,
): void {
  const stateKey = makeStateKey(strategyId, ticker);
  (store ?? localStore).setState(STATE_COLLECTION, stateKey, {
    ticker,
    stockName,
    market: 'domestic',
    status: 'armed',
    strategyId,
    strategyVersion,
    entryPrice: extraFields?.entryPrice ?? null,
    entryQuantity: extraFields?.entryQuantity ?? null,
    targetPrice: extraFields?.targetPrice ?? null,
    stopLossPrice: extraFields?.stopLossPrice ?? null,
    allocatedAmount,
    pendingOrderNo: null,
    enteredAt: null,
    updatedAt: new Date().toISOString(),
    sellOrderNo: null,
    sellExitReason: null,
    entryBoxPos: entryConditions?.entryBoxPos ?? null,
    boxRangePct: entryConditions?.boxRangePct ?? null,
    spreadTicks: entryConditions?.spreadTicks ?? null,
    targetTicks: entryConditions?.targetTicks ?? null,
    bestBidAtExit: null,
    shadowPendingAt: null,
    bestProfitPct: null,
    mfe30GateChecked: false,
    mfe60Pct: null,
    mfe120Pct: null,
    mfe60Checked: false,
    mfe120Checked: false,
    positiveScore: null,
    positiveScoreDetails: null,
    entryMeta: entryMeta ?? null,
    candidateRank: extraFields?.candidateRank ?? null,
    signalMinuteBucket: extraFields?.signalMinuteBucket ?? null,
    fillModel: (extraFields?.fillModel as MomentumScalpStateV3['fillModel']) ?? null,
    // armed fields
    armedAt: new Date().toISOString(),
    armedTriggerLevel: triggerLevel,
    armedTriggerDirection: triggerDirection,
    armedDurationMs: armDurationMs,
    armedSignalReason: signalReason,
  } satisfies MomentumScalpStateV3);
}

/**
 * v3.1 armed → pending_buy 전환
 */
export function transitionArmedToPendingBuy(
  strategyId: StrategyId,
  ticker: string,
  store?: AccountStore,
): void {
  const stateKey = makeStateKey(strategyId, ticker);
  (store ?? localStore).updateState(STATE_COLLECTION, stateKey, {
    status: 'pending_buy',
    shadowPendingAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
}

/**
 * v3 MFE60/MFE120 업데이트 (sell loop에서 시점별 기록)
 */
export function updateScalpStateMFE(
  strategyId: StrategyId,
  ticker: string,
  updates: {
    bestProfitPct?: number;
    mfe60Pct?: number;
    mfe60Checked?: boolean;
    mfe120Pct?: number;
    mfe120Checked?: boolean;
    mfe30GateChecked?: boolean;
  },
  store?: AccountStore,
): void {
  const stateKey = makeStateKey(strategyId, ticker);
  (store ?? localStore).updateState(STATE_COLLECTION, stateKey, {
    ...updates,
    updatedAt: new Date().toISOString(),
  });
}
