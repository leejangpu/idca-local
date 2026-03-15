/**
 * 실사오팔v2 타입 정의
 */

import { type MarketType, getMarketType } from '../../lib/marketUtils';

export interface RealtimeDdsobV2Config {
  tickers: RealtimeDdsobV2TickerConfig[];
  stopAfterCycleEnd: boolean;
  autoSelectEnabled?: boolean;
  autoSelectConfig?: AutoSelectConfig;
  autoSelectEnabledUS?: boolean;
  autoSelectConfigUS?: AutoSelectConfigUS;
}

export interface RealtimeDdsobV2_1Config {
  tickers: RealtimeDdsobV2TickerConfig[];
  stopAfterCycleEnd: boolean;
  autoSelectEnabledUS?: boolean;
  autoSelectConfigUS?: AutoSelectConfigUS;
}

export interface RealtimeDdsobV2TickerConfig {
  ticker: string;
  market: MarketType;
  stockName?: string;
  principal: number;
  splitCount: number;
  profitPercent: number;
  forceSellCandles: number;
  intervalMinutes: number;
  autoSelected?: boolean;
  autoStopLoss?: boolean;
  stopLossPercent?: number;
  exhaustionStopLoss?: boolean;
  stopLossMultiplier?: number;
  forceLiquidateAtClose?: boolean;
  minDropPercent?: number;
  peakCheckCandles?: number;
  exchangeCode?: string;
  selectionMode?: string;
  conditionName?: string;
  ascendingSplit?: boolean;
}

export interface AutoSelectConfig {
  principalMode: 'auto' | 'manual';
  principalPerTicker: number;
  stockCount: number;
  splitCount: number;
  profitPercent: number;
  forceSellCandles: number;
  intervalMinutes: number;
  selectionMode: 'mixed' | 'marketCapOnly' | 'volumeOnly' | 'sideways';
  maxStockPrice: number;
  htsUserId?: string;
  conditionName?: string;
  minMarketCap?: number;
  includeETF?: boolean;
  autoStopLoss?: boolean;
  stopLossPercent?: number;
  exhaustionStopLoss?: boolean;
  stopLossMultiplier?: number;
  minDropPercent?: number;
  peakCheckCandles?: number;
  spreadFilterEnabled?: boolean;
  ascendingSplit?: boolean;
}

export interface AutoSelectConfigUS {
  selectionMode?: 'tradingAmount';
  principalMode: 'auto' | 'manual';
  principalPerTicker: number;
  stockCount: number;
  splitCount: number;
  profitPercent: number;
  forceSellCandles: number;
  intervalMinutes: number;
  autoStopLoss?: boolean;
  stopLossPercent?: number;
  exhaustionStopLoss?: boolean;
  stopLossMultiplier?: number;
  minDropPercent?: number;
  peakCheckCandles?: number;
}

export interface IndicatorsState {
  rsi5m?: { state: { avgGain: number; avgLoss: number; prevClose: number; period: number } | null; value: number | null };
  rsi15m?: { state: { avgGain: number; avgLoss: number; prevClose: number; period: number } | null; value: number | null };
  ema9?: number | null;
  ema20?: number | null;
}

export const FIRST_BUY_TIMEOUT_CANDLES = 10;

/**
 * config에서 ticker 설정 추출 (배열/단일 호환)
 */
export function extractTickerConfigsV2(rdConfig: Record<string, unknown>): RealtimeDdsobV2TickerConfig[] {
  if (Array.isArray(rdConfig.tickers)) {
    return (rdConfig.tickers as RealtimeDdsobV2TickerConfig[]).map(t => ({
      ...t,
      market: t.market || getMarketType(t.ticker),
    }));
  }
  if (typeof rdConfig.ticker === 'string') {
    const ticker = rdConfig.ticker;
    const market = getMarketType(ticker);
    return [{
      ticker,
      market,
      principal: market === 'domestic' ? 5000000 : 5000,
      splitCount: (rdConfig.splitCount as number) ?? 10,
      profitPercent: (rdConfig.profitPercent as number) ?? 0.01,
      forceSellCandles: (rdConfig.forceSellCandles as number) ?? 10,
      intervalMinutes: (rdConfig.intervalMinutes as number) ?? 15,
    }];
  }
  return [];
}

/**
 * state 문서에서 tickerConfig 복원 (config에서 제거된 진행중 사이클용)
 */
export function buildTickerConfigFromStateV2(stateData: Record<string, unknown>): RealtimeDdsobV2TickerConfig {
  return {
    ticker: stateData.ticker as string,
    market: (stateData.market as MarketType) || 'overseas',
    principal: (stateData.principal as number) ?? 5000,
    splitCount: (stateData.splitCount as number) ?? 10,
    profitPercent: (stateData.profitPercent as number) ?? 0.01,
    forceSellCandles: (stateData.forceSellCandles as number) ?? 10,
    intervalMinutes: (stateData.intervalMinutes as number) ?? 15,
    stockName: (stateData.stockName as string) || (stateData.ticker as string),
    autoSelected: (stateData.autoSelected as boolean) ?? false,
    minDropPercent: (stateData.minDropPercent as number) ?? 0,
    exchangeCode: stateData.exchangeCode as string | undefined,
  };
}
