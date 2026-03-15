/**
 * 실사오팔v2 전량매도 및 추적종료 모듈
 * Firebase 의존성 제거 → localStore + config 기반
 */

import { config } from '../../config';
import * as localStore from '../../lib/localStore';
import { KisApiClient, getOrRefreshToken, isTokenExpiredError } from '../../lib/kisApi';
import { AccountContext } from '../../lib/accountContext';
import {
  getMarketStrategyConfig,
  setMarketStrategyConfig,
  type AccountStrategy,
  type MarketType,
} from '../../lib/configHelper';
import { getKSTDateString } from '../../lib/marketUtils';
import {
  type RealtimeDdsobV2Config,
  extractTickerConfigsV2,
} from './types';

// ==================== 자격증명 헬퍼 ====================

function getCredentialsAndClient(ctx?: AccountContext): { credentials: { appKey: string; appSecret: string; accountNo: string }; kisClient: KisApiClient } {
  if (ctx) {
    return {
      credentials: { appKey: ctx.credentials.appKey, appSecret: ctx.credentials.appSecret, accountNo: ctx.credentials.accountNo },
      kisClient: ctx.kisClient,
    };
  }
  return {
    credentials: {
      appKey: config.kis.appKey,
      appSecret: config.kis.appSecret,
      accountNo: config.kis.accountNo,
    },
    kisClient: new KisApiClient(),
  };
}

// ==================== 전량매도 + 추적종료 ====================

/**
 * 실사오팔v2 특정 종목 전량매도 + 추적종료
 * 원본: forceStopRealtimeDdsobV2Ticker
 */
export async function forceStopRealtimeDdsobV2Ticker(
  ticker: string,
  market: MarketType,
  reason: 'force_stop' | 'auto_stop_loss' | 'exhaustion_stop_loss' | 'force_sell_candles' = 'force_stop',
  strategyId: AccountStrategy = 'realtimeDdsobV2',
  ctx?: AccountContext,
): Promise<{ success: boolean; soldQty: number; message: string }> {
  const tag = market === 'domestic' ? 'KR' : 'US';
  console.log(`[ForceStop:${tag}] ticker=${ticker}`);

  // 1. credentials & accessToken
  const { credentials, kisClient } = getCredentialsAndClient(ctx);
  let accessToken = await getOrRefreshToken('', ctx?.accountId ?? config.accountId, credentials, kisClient);

  // 2. state 조회 (exchangeCode 확인 + 보유수량 계산 겸용)
  const state = localStore.getState<Record<string, unknown>>('realtimeDdsobV2State', ticker);

  // 해외 거래소 코드: state에 저장된 값 우선, 없으면 ticker 기반 자동 판별
  const fsQuoteExcd = state?.exchangeCode as string | undefined;
  const fsOrderExcd = fsQuoteExcd ? KisApiClient.quoteToOrderExchangeCode(fsQuoteExcd) : KisApiClient.getExchangeCode(ticker);

  // 3. 미체결 주문 취소
  try {
    if (market === 'overseas') {
      const pendingResp = await kisClient.getPendingOrders(
        credentials.appKey, credentials.appSecret, accessToken, credentials.accountNo, fsOrderExcd
      );
      const unfilled = (pendingResp.output || []).filter(
        (o: { pdno: string; nccs_qty: string }) => o.pdno === ticker && parseInt(o.nccs_qty) > 0
      );
      for (const uf of unfilled) {
        try {
          await kisClient.cancelOrder(
            credentials.appKey, credentials.appSecret, accessToken, credentials.accountNo,
            { orderNo: uf.odno, ticker, exchange: fsOrderExcd }
          );
        } catch (e) { console.error(`[ForceStop:${tag}] Cancel failed ODNO=${uf.odno}:`, e); }
        await new Promise(resolve => setTimeout(resolve, 300));
      }
    } else {
      const todayKST = getKSTDateString();
      const pendingResp = await kisClient.getDomesticPendingOrders(
        credentials.appKey, credentials.appSecret, accessToken, credentials.accountNo, todayKST, ticker
      );
      const unfilled = (pendingResp.output1 || []).filter(
        (o: { pdno: string; rmn_qty: string }) => o.pdno === ticker && parseInt(o.rmn_qty) > 0
      );
      for (const uf of unfilled) {
        try {
          await kisClient.cancelDomesticOrder(
            credentials.appKey, credentials.appSecret, accessToken, credentials.accountNo,
            { orderNo: uf.odno, orgNo: uf.orgn_odno, ticker }
          );
        } catch (e) { console.error(`[ForceStop:${tag}] Cancel failed ODNO=${uf.odno}:`, e); }
        await new Promise(resolve => setTimeout(resolve, 300));
      }
    }
  } catch (err) {
    if (isTokenExpiredError(err)) {
      console.log(`[ForceStop:${tag}] Token expired, refreshing...`);
      accessToken = await getOrRefreshToken('', ctx?.accountId ?? config.accountId, credentials, kisClient, true);
    } else {
      console.error(`[ForceStop:${tag}] Unfilled cleanup error:`, err);
    }
  }

  if (!state) {
    // state 없으면 config에서만 제거
    await removeTickerFromConfig(ticker, market, strategyId);
    return { success: true, soldQty: 0, message: '보유 없음, 추적종료 완료' };
  }

  const buyRecords = (state.buyRecords as Array<{ quantity: number; buyAmount: number }>) || [];
  const totalQty = buyRecords.reduce((sum, br) => sum + br.quantity, 0);
  const totalBuyAmount = buyRecords.reduce((sum, br) => sum + br.buyAmount, 0);

  // 4. 시장가 매도
  let soldQty = 0;
  if (totalQty > 0) {
    await new Promise(resolve => setTimeout(resolve, 300));

    if (market === 'overseas') {
      // 해외: 현재가 조회 후 LIMIT 매도 (5% 버퍼로 체결 확보)
      const priceData = await kisClient.getCurrentPrice(
        credentials.appKey, credentials.appSecret, accessToken, ticker, fsQuoteExcd
      );
      const currentPrice = parseFloat(priceData.output?.last || '0');
      if (currentPrice <= 0) {
        return { success: false, soldQty: 0, message: '현재가 조회 실패' };
      }
      const sellPrice = Math.round(currentPrice * 0.95 * 100) / 100;
      console.log(`[ForceStop:${tag}] ${ticker} currentPrice=$${currentPrice} → sellPrice=$${sellPrice} (5% buffer)`);

      const sellResult = await kisClient.submitOrder(
        credentials.appKey, credentials.appSecret, accessToken, credentials.accountNo,
        { ticker, side: 'SELL', orderType: 'LIMIT', price: sellPrice, quantity: totalQty, exchange: fsOrderExcd }
      );
      if (sellResult.rt_cd !== '0') {
        return { success: false, soldQty: 0, message: `매도 실패: ${sellResult.msg1}` };
      }
      soldQty = totalQty;
    } else {
      // 국내: 시장가 매도
      const sellResult = await kisClient.submitDomesticOrder(
        credentials.appKey, credentials.appSecret, accessToken, credentials.accountNo,
        { ticker, side: 'SELL', orderType: 'MARKET', price: 0, quantity: totalQty }
      );
      if (sellResult.rt_cd !== '0') {
        return { success: false, soldQty: 0, message: `매도 실패: ${sellResult.msg1}` };
      }
      soldQty = totalQty;
    }
  }

  // 5. cycleHistory 기록
  const estimatedPrice = (state.previousPrice as number) || 0;
  const estimatedProfit = ((state.totalRealizedProfit as number) || 0) + (estimatedPrice * totalQty - totalBuyAmount);

  localStore.addCycleHistory({
    ticker,
    market,
    strategy: strategyId,
    stockName: (state.stockName as string) || ticker,
    cycleNumber: (state.cycleNumber as number) || 1,
    autoSelected: state.autoSelected || false,
    eodAction: reason,
    startedAt: state.startedAt,
    completedAt: new Date().toISOString(),
    principal: state.principal,
    splitCount: state.splitCount,
    profitPercent: state.profitPercent,
    amountPerRound: state.amountPerRound,
    forceSellCandles: state.forceSellCandles,
    intervalMinutes: state.intervalMinutes,
    minDropPercent: (state.minDropPercent as number) || 0,
    peakCheckCandles: (state.peakCheckCandles as number) ?? 0,
    bufferPercent: 0.01,
    autoStopLoss: state.autoStopLoss || false,
    stopLossPercent: (state.stopLossPercent as number) ?? -5,
    exhaustionStopLoss: state.exhaustionStopLoss || false,
    stopLossMultiplier: (state.stopLossMultiplier as number) ?? 3,
    exchangeCode: state.exchangeCode || '',
    selectionMode: state.selectionMode || '',
    conditionName: state.conditionName || '',
    totalBuyAmount: (state.totalBuyAmount as number) || 0,
    totalSellAmount: ((state.totalSellAmount as number) || 0) + estimatedPrice * totalQty,
    totalRealizedProfit: estimatedProfit,
    finalProfitRate: (state.principal as number) > 0 ? estimatedProfit / (state.principal as number) : 0,
    maxRoundsAtEnd: (state.maxRounds as number) || (state.splitCount as number),
    candlesSinceCycleStart: (state.candlesSinceCycleStart as number) || 0,
    totalForceSellCount: (state.totalForceSellCount as number) || 0,
    totalForceSellLoss: (state.totalForceSellLoss as number) || 0,
    forceStopSoldQuantity: totalQty,
  });

  // 6. state 삭제
  localStore.deleteState('realtimeDdsobV2State', ticker);

  // 7. config에서 종목 제거
  await removeTickerFromConfig(ticker, market, strategyId);

  console.log(`[ForceStop:${tag}] Completed: ${ticker} ${soldQty}주 매도, 추적종료`);
  return { success: true, soldQty, message: `${ticker} ${soldQty}주 매도 완료, 추적종료` };
}

// ==================== config에서 종목 제거 ====================

/**
 * config의 tickers 배열에서 특정 종목 제거
 * 원본: removeTickerFromConfig
 */
export async function removeTickerFromConfig(
  ticker: string,
  market: MarketType,
  strategyId: AccountStrategy = 'realtimeDdsobV2'
): Promise<void> {
  const strategyConfig = getMarketStrategyConfig<RealtimeDdsobV2Config>(market, strategyId);
  if (strategyConfig) {
    const allTickers = extractTickerConfigsV2(strategyConfig as unknown as Record<string, unknown>);
    if (allTickers.some(t => t.ticker === ticker)) {
      const remaining = allTickers.filter(t => t.ticker !== ticker);
      const currentConfig = getMarketStrategyConfig<Record<string, unknown>>(market, strategyId) || {};
      setMarketStrategyConfig(market, strategyId, {
        ...currentConfig,
        tickers: remaining,
      });
    }
  }
}
