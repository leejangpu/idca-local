/**
 * 모멘텀 스캘핑 슬롯 배분 계산기 — 로컬 버전
 * Firestore → localStore 전환
 */

import { KisApiClient } from './kisApi';
import { isKRMarketOpen } from './marketUtils';
import { getUserTelegramChatId, sendTelegramMessage } from './telegram';
import * as localStore from './localStore';
import { type AccountStore } from './localStore';

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
  sellExitReason: 'target' | 'stop_loss' | 'timeout' | 'market_close_auction' | null;
  entryBoxPos: number | null;
  boxRangePct: number | null;
  spreadTicks: number | null;
  targetTicks: number | null;
  bestBidAtExit: number | null;
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
  store?: AccountStore
): void {
  (store ?? localStore).setState(STATE_COLLECTION, ticker, {
    ticker, stockName, market: 'domestic', status: 'pending_buy',
    entryPrice: null, entryQuantity: null, targetPrice: null, stopLossPrice: null,
    allocatedAmount, pendingOrderNo, enteredAt: null, sellOrderNo: null, sellExitReason: null,
    entryBoxPos: entryConditions?.entryBoxPos ?? null, boxRangePct: entryConditions?.boxRangePct ?? null,
    spreadTicks: entryConditions?.spreadTicks ?? null, targetTicks: entryConditions?.targetTicks ?? null,
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
  });
}

export function deleteMomentumScalpState(ticker: string, store?: AccountStore): void {
  (store ?? localStore).deleteState(STATE_COLLECTION, ticker);
}

export function updateMomentumScalpStateToPendingSell(
  ticker: string, sellOrderNo: string,
  sellExitReason: 'target' | 'stop_loss' | 'timeout' | 'market_close_auction',
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
