/**
 * 단타 v1 — 주문 실행 레이어
 *
 * shadow mode: 가상 체결 시뮬레이션 (실제 주문 없음)
 * real mode: KIS API를 통한 실제 주문 (추후 구현)
 *
 * 두 모드 모두 동일한 인터페이스를 통해 접근하며,
 * 결과는 항상 OrderLogEntry로 기록된다.
 */

import { type AccountContext } from '../../lib/accountContext';
import { getOrRefreshToken } from '../../lib/kisApi';
import {
  type DantaV1State,
  type DantaV1Config,
  type ExitReason,
  DANTA_STATE_COLLECTION,
} from './dantaTypes';
import { logOrder, logTradeComplete } from './dantaLogger';

const TAG = '[DantaV1:Exec]';

// ========================================
// 매수 실행
// ========================================

export interface BuyResult {
  success: boolean;
  orderNo: string | null;
  filledPrice: number;
  filledQuantity: number;
  filledAt: string;
  error?: string;
}

export async function executeBuy(
  ctx: AccountContext,
  params: {
    ticker: string;
    stockName: string;
    price: number;        // 매수 지정가 (최우선 매도호가)
    quantity: number;
    targetPrice: number;
    stopLossPrice: number;
    pullbackLow: number;
    triggerHigh: number;
    allocatedAmount: number;
  },
  config: DantaV1Config,
): Promise<BuyResult> {
  const now = new Date().toISOString();

  if (config.shadowMode) {
    // Shadow: 즉시 가상 체결
    const state: DantaV1State = {
      ticker: params.ticker,
      stockName: params.stockName,
      market: 'domestic',
      status: 'active',
      entryPrice: params.price,
      entryQuantity: params.quantity,
      allocatedAmount: params.allocatedAmount,
      targetPrice: params.targetPrice,
      stopLossPrice: params.stopLossPrice,
      pullbackLow: params.pullbackLow,
      triggerHigh: params.triggerHigh,
      pendingOrderNo: null,
      sellOrderNo: null,
      enteredAt: now,
      filledAt: now,
      updatedAt: now,
      shadowMode: true,
      bestProfitPct: null,
      worstProfitPct: null,
      hasReachedPlusOneTick: false,
      hasReachedPlusTwoTicks: false,
    };

    ctx.store.setState(DANTA_STATE_COLLECTION, params.ticker, state);

    logOrder({
      type: 'BUY',
      ticker: params.ticker,
      stockName: params.stockName,
      price: params.price,
      quantity: params.quantity,
      amount: params.price * params.quantity,
      orderType: 'LIMIT',
      shadowMode: true,
      reason: 'breakout entry (shadow)',
      orderNo: null,
      timestamp: now,
    }, ctx);

    return {
      success: true,
      orderNo: null,
      filledPrice: params.price,
      filledQuantity: params.quantity,
      filledAt: now,
    };
  }

  // Real mode: KIS API 주문
  try {
    const { appKey, appSecret } = ctx.credentials;
    const accessToken = await getOrRefreshToken('', ctx.accountId, { appKey, appSecret }, ctx.kisClient);
    const accountNo = ctx.credentials.accountNo;

    const orderResult = await ctx.kisClient.submitDomesticOrder(
      appKey, appSecret, accessToken, accountNo,
      {
        ticker: params.ticker,
        side: 'BUY',
        orderType: 'LIMIT',
        price: params.price,
        quantity: params.quantity,
      },
    );

    const orderNo = orderResult.output?.ODNO ?? null;

    // pending_buy 상태로 저장 (체결 확인은 position-monitor에서)
    const state: DantaV1State = {
      ticker: params.ticker,
      stockName: params.stockName,
      market: 'domestic',
      status: 'pending_buy',
      entryPrice: params.price,
      entryQuantity: params.quantity,
      allocatedAmount: params.allocatedAmount,
      targetPrice: params.targetPrice,
      stopLossPrice: params.stopLossPrice,
      pullbackLow: params.pullbackLow,
      triggerHigh: params.triggerHigh,
      pendingOrderNo: orderNo,
      sellOrderNo: null,
      enteredAt: now,
      filledAt: null,
      updatedAt: now,
      shadowMode: false,
      bestProfitPct: null,
      worstProfitPct: null,
      hasReachedPlusOneTick: false,
      hasReachedPlusTwoTicks: false,
    };

    ctx.store.setState(DANTA_STATE_COLLECTION, params.ticker, state);

    logOrder({
      type: 'BUY',
      ticker: params.ticker,
      stockName: params.stockName,
      price: params.price,
      quantity: params.quantity,
      amount: params.price * params.quantity,
      orderType: 'LIMIT',
      shadowMode: false,
      reason: 'breakout entry (real)',
      orderNo,
      timestamp: now,
    }, ctx);

    return {
      success: true,
      orderNo,
      filledPrice: params.price,
      filledQuantity: params.quantity,
      filledAt: now,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`${TAG} BUY failed ${params.ticker}:`, msg);
    return { success: false, orderNo: null, filledPrice: 0, filledQuantity: 0, filledAt: now, error: msg };
  }
}

// ========================================
// 매도 실행
// ========================================

export interface SellResult {
  success: boolean;
  orderNo: string | null;
  filledPrice: number;
  error?: string;
}

export async function executeSell(
  ctx: AccountContext,
  position: DantaV1State,
  exitPrice: number,
  exitReason: ExitReason,
  config: DantaV1Config,
): Promise<SellResult> {
  const now = new Date().toISOString();

  // 거래 로그 기록 (shadow/real 공통)
  const entryAmount = position.entryPrice * position.entryQuantity;
  const exitAmount = exitPrice * position.entryQuantity;
  const profitAmount = exitAmount - entryAmount;
  const profitRatePct = Number(((exitPrice - position.entryPrice) / position.entryPrice * 100).toFixed(2));
  const netPnlPct = Number((profitRatePct - config.costRatePct).toFixed(2));
  const holdTimeSec = position.filledAt
    ? Math.round((Date.now() - new Date(position.filledAt).getTime()) / 1000)
    : 0;

  if (config.shadowMode) {
    // Shadow: 즉시 가상 체결, state 삭제
    ctx.store.deleteState(DANTA_STATE_COLLECTION, position.ticker);

    logOrder({
      type: 'SELL',
      ticker: position.ticker,
      stockName: position.stockName,
      price: exitPrice,
      quantity: position.entryQuantity,
      amount: exitAmount,
      orderType: 'LIMIT',
      shadowMode: true,
      reason: `${exitReason} (shadow)`,
      orderNo: null,
      timestamp: now,
    }, ctx);

    logTradeComplete({
      ticker: position.ticker,
      stockName: position.stockName,
      entryPrice: position.entryPrice,
      exitPrice,
      quantity: position.entryQuantity,
      entryAmount,
      exitAmount,
      profitAmount,
      profitRatePct,
      netPnlPct,
      exitReason,
      triggerHigh: position.triggerHigh,
      pullbackLow: position.pullbackLow,
      holdTimeSec,
      shadowMode: true,
      timestamp: now,
    }, ctx);

    return { success: true, orderNo: null, filledPrice: exitPrice };
  }

  // Real mode
  try {
    const { appKey, appSecret } = ctx.credentials;
    const accessToken = await getOrRefreshToken('', ctx.accountId, { appKey, appSecret }, ctx.kisClient);
    const accountNo = ctx.credentials.accountNo;

    const orderResult = await ctx.kisClient.submitDomesticOrder(
      appKey, appSecret, accessToken, accountNo,
      {
        ticker: position.ticker,
        side: 'SELL',
        orderType: 'LIMIT',
        price: exitPrice,
        quantity: position.entryQuantity,
      },
    );

    const orderNo = orderResult.output?.ODNO ?? null;

    // pending_sell 상태로 전환
    ctx.store.setState(DANTA_STATE_COLLECTION, position.ticker, {
      ...position,
      status: 'pending_sell' as const,
      sellOrderNo: orderNo,
      updatedAt: now,
    });

    logOrder({
      type: 'SELL',
      ticker: position.ticker,
      stockName: position.stockName,
      price: exitPrice,
      quantity: position.entryQuantity,
      amount: exitAmount,
      orderType: 'LIMIT',
      shadowMode: false,
      reason: `${exitReason} (real)`,
      orderNo,
      timestamp: now,
    }, ctx);

    logTradeComplete({
      ticker: position.ticker,
      stockName: position.stockName,
      entryPrice: position.entryPrice,
      exitPrice,
      quantity: position.entryQuantity,
      entryAmount,
      exitAmount,
      profitAmount,
      profitRatePct,
      netPnlPct,
      exitReason,
      triggerHigh: position.triggerHigh,
      pullbackLow: position.pullbackLow,
      holdTimeSec,
      shadowMode: false,
      timestamp: now,
    }, ctx);

    return { success: true, orderNo, filledPrice: exitPrice };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`${TAG} SELL failed ${position.ticker}:`, msg);
    return { success: false, orderNo: null, filledPrice: 0, error: msg };
  }
}
