/**
 * 실사오팔v2 핵심 매매 로직 모듈
 *
 * 원본: idca-functions/src/functions/realtimeV2.ts (processRealtimeDdsobV2Trading + 헬퍼)
 * 변경: Firestore → localStore, admin.firestore 타입 제거
 */

import { config } from '../../config';
import {
  KisApiClient,
  getOrRefreshToken,
  isTokenExpiredError,
} from '../../lib/kisApi';
import { AccountContext } from '../../lib/accountContext';
import {
  type AccountStrategy,
  getMarketStrategyConfig,
  setMarketStrategyConfig,
} from '../../lib/configHelper';
import {
  sendTelegramMessage,
  getUserTelegramChatId,
} from '../../lib/telegram';
import {
  calculateRealtimeDdsobV2,
  generateRealtimeBuyRecordIdV2,
  getAscendingAmountForRound,
  type RealtimeBuyRecordV2,
} from '../../lib/realtimeDdsobV2Calculator';
import {
  calculateRSI,
  aggregateMinuteBars,
  type MinuteBar,
  calculateEMA,
  updateEMA,
  calculateRSIState,
  updateRSIState,
  getRSIFromState,
  type RSIState,
} from '../../lib/rsiCalculator';
import {
  type MarketType,
  formatPrice as marketFormatPrice,
  getKSTDateString,
} from '../../lib/marketUtils';
import * as localStore from '../../lib/localStore';
import {
  type RealtimeDdsobV2Config,
  type RealtimeDdsobV2TickerConfig,
  FIRST_BUY_TIMEOUT_CANDLES,
  extractTickerConfigsV2,
} from './types';

// ==================== RSI 관련 타입 ====================

interface RSIResult {
  rsi5m: number | null;
  rsi15m: number | null;
  rsi5mBars: number;
  rsi15mBars: number;
}

// ==================== EMA/RSI 실시간 추적 인프라 ====================

/** 실시간 지표 추적 상태 (state.indicators에 저장) */
interface IndicatorsState {
  ema9_1m: number | null;
  ema20_5m: number | null;
  rsi14_1m: number | null;
  rsi14_5m: number | null;
  rsiState_1m: RSIState | null;
  rsiState_5m: RSIState | null;
  pending5mCloses: number[];
  initialized: boolean;
  barsAccumulated_1m: number;
  barsAccumulated_5m: number;
}

function emptyIndicators(): IndicatorsState {
  return {
    ema9_1m: null, ema20_5m: null,
    rsi14_1m: null, rsi14_5m: null,
    rsiState_1m: null, rsiState_5m: null,
    pending5mCloses: [],
    initialized: false,
    barsAccumulated_1m: 0, barsAccumulated_5m: 0,
  };
}

// ==================== RSI 조회 헬퍼 ====================

async function fetchRSIAtBuyTime(
  kisClient: KisApiClient,
  appKey: string,
  appSecret: string,
  accessToken: string,
  ticker: string,
  market: MarketType,
  tag: string,
): Promise<RSIResult> {
  const empty: RSIResult = { rsi5m: null, rsi15m: null, rsi5mBars: 0, rsi15mBars: 0 };
  try {
    if (market === 'overseas') {
      await new Promise(resolve => setTimeout(resolve, 300));
      const [resp5m, resp15m] = await Promise.all([
        kisClient.getOverseasMinuteBars(appKey, appSecret, accessToken, ticker, 5, 20),
        new Promise(resolve => setTimeout(resolve, 300)).then(() =>
          kisClient.getOverseasMinuteBars(appKey, appSecret, accessToken, ticker, 15, 20)
        ),
      ]);

      const closes5m = (resp5m.output2 || [])
        .map((b: { last: string }) => parseFloat(b.last))
        .filter((v: number) => v > 0)
        .reverse();
      const closes15m = (resp15m.output2 || [])
        .map((b: { last: string }) => parseFloat(b.last))
        .filter((v: number) => v > 0)
        .reverse();

      const rsi5m = calculateRSI(closes5m);
      const rsi15m = calculateRSI(closes15m);
      console.log(`[RealtimeDdsobV2:${tag}] RSI at buy: 5m=${rsi5m}, 15m=${rsi15m} (data: 5m=${closes5m.length}건, 15m=${closes15m.length}건)`);
      return { rsi5m, rsi15m, rsi5mBars: closes5m.length, rsi15mBars: closes15m.length };
    } else {
      // 국내: 1분봉 조회 후 5분/15분봉으로 집계
      const now = new Date();
      const kstHour = (now.getUTCHours() + 9) % 24;
      const kstMinute = now.getUTCMinutes();

      const currentTotalMin = kstHour * 60 + kstMinute;
      const windows: string[] = [];
      for (let t = currentTotalMin; t >= 9 * 60 && windows.length < 8; t -= 30) {
        const h = Math.floor(t / 60);
        const m = t % 60;
        windows.push(`${String(h).padStart(2, '0')}${String(m).padStart(2, '0')}00`);
      }

      const allBars: MinuteBar[] = [];
      const seen = new Set<string>();

      for (const hour of windows) {
        await new Promise(resolve => setTimeout(resolve, 300));
        try {
          const resp = await kisClient.getDomesticMinuteBars(
            appKey, appSecret, accessToken, ticker, hour
          );
          for (const item of (resp.output2 || [])) {
            const key = `${item.stck_bsop_date}_${item.stck_cntg_hour}`;
            if (seen.has(key)) continue;
            seen.add(key);
            const close = parseInt(item.stck_prpr);
            const open = parseInt(item.stck_oprc);
            if (open === 0 && close === 0) continue;
            allBars.push({
              date: item.stck_bsop_date,
              time: item.stck_cntg_hour,
              open,
              high: parseInt(item.stck_hgpr),
              low: parseInt(item.stck_lwpr),
              close,
            });
          }
        } catch (err) {
          console.warn(`[RealtimeDdsobV2:${tag}] Minute bar fetch failed for window ${hour}:`, err);
        }
      }

      allBars.sort((a, b) => {
        const ka = `${a.date}_${a.time}`;
        const kb = `${b.date}_${b.time}`;
        return ka.localeCompare(kb);
      });

      const bars5m = aggregateMinuteBars(allBars, 5);
      const bars15m = aggregateMinuteBars(allBars, 15);

      const rsi5m = calculateRSI(bars5m.map(b => b.close));
      const rsi15m = calculateRSI(bars15m.map(b => b.close));
      console.log(`[RealtimeDdsobV2:${tag}] RSI at buy: 5m=${rsi5m}, 15m=${rsi15m} (1m=${allBars.length}건 → 5m=${bars5m.length}건, 15m=${bars15m.length}건)`);
      return { rsi5m, rsi15m, rsi5mBars: bars5m.length, rsi15mBars: bars15m.length };
    }
  } catch (err) {
    console.error(`[RealtimeDdsobV2:${tag}] RSI fetch failed:`, err);
    return empty;
  }
}

// ==================== 지표 초기화 ====================

/**
 * 종목 선택 시 과거 분봉 데이터로 EMA/RSI 초기화
 */
async function fetchIndicatorsAtStartup(
  kisClient: KisApiClient,
  appKey: string,
  appSecret: string,
  accessToken: string,
  ticker: string,
  market: MarketType,
  tag: string,
): Promise<{ indicators: IndicatorsState; recentCloses1m: number[] }> {
  const indicators = emptyIndicators();
  let recentCloses1m: number[] = [];
  try {
    if (market === 'overseas') {
      await new Promise(resolve => setTimeout(resolve, 300));
      const [resp1m, resp5m] = await Promise.all([
        kisClient.getOverseasMinuteBars(appKey, appSecret, accessToken, ticker, 1, 20),
        new Promise(resolve => setTimeout(resolve, 300)).then(() =>
          kisClient.getOverseasMinuteBars(appKey, appSecret, accessToken, ticker, 5, 25)
        ),
      ]);

      const closes1m = (resp1m.output2 || [])
        .map((b: { last: string }) => parseFloat(b.last))
        .filter((v: number) => v > 0)
        .reverse();

      const closes5m = (resp5m.output2 || [])
        .map((b: { last: string }) => parseFloat(b.last))
        .filter((v: number) => v > 0)
        .reverse();

      // 1분봉 지표
      if (closes1m.length >= 9) {
        indicators.ema9_1m = calculateEMA(closes1m, 9);
      }
      const rsiState1m = calculateRSIState(closes1m, 14);
      if (rsiState1m) {
        indicators.rsiState_1m = rsiState1m;
        indicators.rsi14_1m = getRSIFromState(rsiState1m);
      }

      // 5분봉 지표
      if (closes5m.length >= 20) {
        indicators.ema20_5m = calculateEMA(closes5m, 20);
      }
      const rsiState5m = calculateRSIState(closes5m, 14);
      if (rsiState5m) {
        indicators.rsiState_5m = rsiState5m;
        indicators.rsi14_5m = getRSIFromState(rsiState5m);
      }

      indicators.initialized = true;
      indicators.barsAccumulated_1m = closes1m.length;
      indicators.barsAccumulated_5m = closes5m.length;
      recentCloses1m = closes1m;
      console.log(`[RealtimeDdsobV2:${tag}] Indicators initialized (overseas): EMA9(1m)=${indicators.ema9_1m?.toFixed(2)}, EMA20(5m)=${indicators.ema20_5m?.toFixed(2)}, RSI(1m)=${indicators.rsi14_1m}, RSI(5m)=${indicators.rsi14_5m} (1m=${closes1m.length}bars, 5m=${closes5m.length}bars)`);

    } else {
      // 국내: 1분봉 수집 → 5분봉 집계
      const now = new Date();
      const kstHour = (now.getUTCHours() + 9) % 24;
      const kstMinute = now.getUTCMinutes();
      const currentTotalMin = kstHour * 60 + kstMinute;

      const windows: string[] = [];
      for (let t = currentTotalMin; t >= 9 * 60 && windows.length < 5; t -= 30) {
        const h = Math.floor(t / 60);
        const m = t % 60;
        windows.push(`${String(h).padStart(2, '0')}${String(m).padStart(2, '0')}00`);
      }

      const allBars: MinuteBar[] = [];
      const seen = new Set<string>();

      for (const hour of windows) {
        await new Promise(resolve => setTimeout(resolve, 300));
        try {
          const resp = await kisClient.getDomesticMinuteBars(
            appKey, appSecret, accessToken, ticker, hour
          );
          for (const item of (resp.output2 || [])) {
            const key = `${item.stck_bsop_date}_${item.stck_cntg_hour}`;
            if (seen.has(key)) continue;
            seen.add(key);
            const close = parseInt(item.stck_prpr);
            const open = parseInt(item.stck_oprc);
            if (open === 0 && close === 0) continue;
            allBars.push({
              date: item.stck_bsop_date,
              time: item.stck_cntg_hour,
              open,
              high: parseInt(item.stck_hgpr),
              low: parseInt(item.stck_lwpr),
              close,
            });
          }
        } catch (err) {
          console.warn(`[RealtimeDdsobV2:${tag}] Indicator bar fetch failed for window ${hour}:`, err);
        }
      }

      allBars.sort((a, b) => {
        const ka = `${a.date}_${a.time}`;
        const kb = `${b.date}_${b.time}`;
        return ka.localeCompare(kb);
      });

      const closes1m = allBars.map(b => b.close);

      // 1분봉 지표
      if (closes1m.length >= 9) {
        indicators.ema9_1m = calculateEMA(closes1m, 9);
      }
      const rsiState1m = calculateRSIState(closes1m, 14);
      if (rsiState1m) {
        indicators.rsiState_1m = rsiState1m;
        indicators.rsi14_1m = getRSIFromState(rsiState1m);
      }

      // 5분봉 집계 → 지표
      const bars5m = aggregateMinuteBars(allBars, 5);
      const closes5m = bars5m.map(b => b.close);

      if (closes5m.length >= 20) {
        indicators.ema20_5m = calculateEMA(closes5m, 20);
      }
      const rsiState5m = calculateRSIState(closes5m, 14);
      if (rsiState5m) {
        indicators.rsiState_5m = rsiState5m;
        indicators.rsi14_5m = getRSIFromState(rsiState5m);
      }

      indicators.initialized = true;
      indicators.barsAccumulated_1m = closes1m.length;
      indicators.barsAccumulated_5m = closes5m.length;
      recentCloses1m = closes1m;
      console.log(`[RealtimeDdsobV2:${tag}] Indicators initialized (domestic): EMA9(1m)=${indicators.ema9_1m?.toFixed(0)}, EMA20(5m)=${indicators.ema20_5m?.toFixed(0)}, RSI(1m)=${indicators.rsi14_1m}, RSI(5m)=${indicators.rsi14_5m} (1m=${closes1m.length}bars, 5m=${closes5m.length}bars)`);
    }
  } catch (err) {
    console.error(`[RealtimeDdsobV2:${tag}] Indicators initialization failed (non-blocking):`, err);
  }
  return { indicators, recentCloses1m };
}

// ==================== 지표 갱신 ====================

/**
 * 매 틱 EMA/RSI 갱신
 */
function updateIndicatorsOnTick(
  indicators: IndicatorsState,
  currentPrice: number,
  intervalMinutes: number,
): void {
  if (!indicators.initialized) return;

  // 1분봉 EMA9 갱신
  if (indicators.ema9_1m !== null) {
    indicators.ema9_1m = updateEMA(indicators.ema9_1m, currentPrice, 9);
  }

  // 1분봉 RSI14 갱신
  if (indicators.rsiState_1m !== null) {
    const { rsiState, rsi } = updateRSIState(indicators.rsiState_1m, currentPrice);
    indicators.rsiState_1m = rsiState;
    indicators.rsi14_1m = rsi;
  }
  indicators.barsAccumulated_1m++;

  // 5분봉 지표: interval에 따라 집계
  if (intervalMinutes < 5) {
    indicators.pending5mCloses.push(currentPrice);
    const barsPerCandle = Math.round(5 / intervalMinutes);
    if (indicators.pending5mCloses.length >= barsPerCandle) {
      const bar5mClose = indicators.pending5mCloses[indicators.pending5mCloses.length - 1];

      if (indicators.ema20_5m !== null) {
        indicators.ema20_5m = updateEMA(indicators.ema20_5m, bar5mClose, 20);
      }
      if (indicators.rsiState_5m !== null) {
        const { rsiState, rsi } = updateRSIState(indicators.rsiState_5m, bar5mClose);
        indicators.rsiState_5m = rsiState;
        indicators.rsi14_5m = rsi;
      }
      indicators.barsAccumulated_5m++;
      indicators.pending5mCloses = [];
    }
  } else {
    if (indicators.ema20_5m !== null) {
      indicators.ema20_5m = updateEMA(indicators.ema20_5m, currentPrice, 20);
    }
    if (indicators.rsiState_5m !== null) {
      const { rsiState, rsi } = updateRSIState(indicators.rsiState_5m, currentPrice);
      indicators.rsiState_5m = rsiState;
      indicators.rsi14_5m = rsi;
    }
    indicators.barsAccumulated_5m++;
  }
}

// ==================== 스프레드 / 잔량 / 상한가 여유 필터 ====================

const MAX_SPREAD_TICKS = 1;
const MAX_SPREAD_TICKS_RELAXED = 2;
const MIN_TP_TICKS_FOR_RELAXED = 6;
const MIN_TP_TICKS = 3;
const LIQUIDITY_MULTIPLIER = 10;
const UPPER_ROOM_BUFFER_BPS = 20;

/** 한국 주식 호가단위 (KRX 기준) */
export function getDomesticTickSize(price: number): number {
  if (price < 2000) return 1;
  if (price < 5000) return 5;
  if (price < 20000) return 10;
  if (price < 50000) return 50;
  if (price < 200000) return 100;
  if (price < 500000) return 500;
  return 1000;
}

/** 국내주식 호가 조회 → 틱 기반 스프레드 + 잔량 + 기준가 */
interface DomesticOrderbookInfo {
  spreadTicks: number;
  spreadAbs: number;
  tick: number;
  tpTicks: number;
  askQty: number;
  bidQty: number;
  currentPrice: number;
  basePrice: number;
}

export async function getDomesticOrderbookInfo(
  kisClient: KisApiClient,
  appKey: string, appSecret: string, accessToken: string,
  ticker: string,
  profitPercent: number
): Promise<DomesticOrderbookInfo> {
  const resp = await kisClient.getDomesticAskingPrice(appKey, appSecret, accessToken, ticker);

  if (resp.rt_cd !== '0') {
    throw new Error(`Asking price API error: ${resp.msg1} (rt_cd=${resp.rt_cd})`);
  }

  const askp1 = parseInt(resp.output1?.askp1 || '0');
  const bidp1 = parseInt(resp.output1?.bidp1 || '0');
  const askQty = parseInt(resp.output1?.askp_rsqn1 || '0');
  const bidQty = parseInt(resp.output1?.bidp_rsqn1 || '0');
  const currentPrice = parseInt(resp.output2?.stck_prpr || '0');
  const basePrice = parseInt(resp.output2?.stck_sdpr || '0');

  const tick = getDomesticTickSize(currentPrice || askp1);
  const spreadAbs = askp1 > 0 && bidp1 > 0 ? askp1 - bidp1 : Infinity;
  const spreadTicks = spreadAbs === Infinity ? Infinity : Math.round(spreadAbs / tick);
  const tpAbs = currentPrice * profitPercent;
  const tpTicks = tick > 0 ? tpAbs / tick : 0;

  return { spreadTicks, spreadAbs, tick, tpTicks, askQty, bidQty, currentPrice, basePrice };
}

/**
 * 틱 기반 스프레드 + TP 틱수 + 잔량 필터 판정
 */
export function checkTickFilter(
  info: DomesticOrderbookInfo,
  orderQty: number
): { pass: boolean; reason?: string } {
  if (info.spreadTicks > MAX_SPREAD_TICKS_RELAXED) {
    return { pass: false, reason: `spread ${info.spreadTicks}tick > ${MAX_SPREAD_TICKS_RELAXED}tick` };
  }
  if (info.spreadTicks > MAX_SPREAD_TICKS && info.tpTicks < MIN_TP_TICKS_FOR_RELAXED) {
    return { pass: false, reason: `spread ${info.spreadTicks}tick, TP ${info.tpTicks.toFixed(1)}tick < ${MIN_TP_TICKS_FOR_RELAXED}tick` };
  }

  if (info.tpTicks < MIN_TP_TICKS) {
    return { pass: false, reason: `TP ${info.tpTicks.toFixed(1)}tick < ${MIN_TP_TICKS}tick` };
  }

  if (orderQty > 0) {
    const minQty = orderQty * LIQUIDITY_MULTIPLIER;
    if (info.askQty < minQty) {
      return { pass: false, reason: `ask잔량 ${info.askQty} < ${minQty} (${orderQty}×${LIQUIDITY_MULTIPLIER})` };
    }
    if (info.bidQty < minQty) {
      return { pass: false, reason: `bid잔량 ${info.bidQty} < ${minQty} (${orderQty}×${LIQUIDITY_MULTIPLIER})` };
    }
  }

  return { pass: true };
}

/** 상한가 여유가 TP + 버퍼 이상인지 확인 */
export function hasEnoughUpperRoom(currentPrice: number, upperLimit: number, profitPercent: number): boolean {
  if (upperLimit <= 0 || currentPrice <= 0) return true;
  const tpBps = profitPercent * 10000;
  const upperRoomBps = (upperLimit - currentPrice) / currentPrice * 10000;
  return upperRoomBps >= tpBps + UPPER_ROOM_BUFFER_BPS;
}

/**
 * 선정 단계: 틱 스프레드 + 잔량 + 상한가 여유 필터
 */
export async function selectWithSpreadFilter(
  candidates: Array<{ ticker: string; name: string; price: number }>,
  slotsToFill: number,
  profitPercent: number,
  kisClient: KisApiClient,
  appKey: string, appSecret: string, accessToken: string,
  amountPerRound?: number,
  spreadFilterEnabled: boolean = true
): Promise<Array<{ ticker: string; name: string; price: number }>> {
  const tpBps = profitPercent * 10000;
  const selected: typeof candidates = [];

  if (!spreadFilterEnabled) {
    console.log('[AutoSelect] Spread filter disabled, selecting top candidates');
    return candidates.slice(0, slotsToFill);
  }

  for (const candidate of candidates) {
    if (selected.length >= slotsToFill) break;
    try {
      await new Promise(resolve => setTimeout(resolve, 300));
      const info = await getDomesticOrderbookInfo(
        kisClient, appKey, appSecret, accessToken, candidate.ticker, profitPercent
      );
      const price = info.currentPrice || candidate.price;

      const estimatedQty = amountPerRound && price > 0 ? Math.floor(amountPerRound / price) : 0;

      const { pass, reason } = checkTickFilter(info, estimatedQty);
      if (!pass) {
        console.log(`[AutoSelect] ${candidate.name}(${candidate.ticker}) ${reason} → SKIP`);
        continue;
      }

      const estimatedUpperLimit = info.basePrice > 0 ? Math.round(info.basePrice * 1.30) : 0;
      if (estimatedUpperLimit > 0 && !hasEnoughUpperRoom(price, estimatedUpperLimit, profitPercent)) {
        const upperRoomBps = (estimatedUpperLimit - price) / price * 10000;
        console.log(`[AutoSelect] ${candidate.name}(${candidate.ticker}) upper room ${upperRoomBps.toFixed(0)}bps < ${(tpBps + UPPER_ROOM_BUFFER_BPS).toFixed(0)}bps → SKIP`);
        continue;
      }

      console.log(`[AutoSelect] ${candidate.name}(${candidate.ticker}) spread=${info.spreadTicks}tick, TP=${info.tpTicks.toFixed(1)}tick, ask=${info.askQty}, bid=${info.bidQty} → OK`);
      selected.push(candidate);
    } catch (err) {
      console.error(`[AutoSelect] Spread check failed for ${candidate.ticker}, skipping:`, err);
      continue;
    }
  }

  return selected;
}

// ==================== v2.1 해외주식 지표 기반 필터 ====================

interface AutoSelectConfigV2_1 {
  principalMode: 'auto' | 'manual';
  principalPerTicker: number;
  stockCount: number;
  splitCount: number;
  profitPercent: number;
  forceSellCandles: number;
  intervalMinutes: number;
  priceMin?: number;
  priceMax?: number;
  changeRateMin?: number;
  changeRateMax?: number;
  indicatorFilterEnabled?: boolean;
  indicatorTimeframe?: number;
  ema20Filter?: boolean;
  ema5Filter?: boolean;
  ema20DisparityMin?: number;
  ema20DisparityMax?: number;
  rsiFilterEnabled?: boolean;
  rsiMin?: number;
  rsiMax?: number;
  autoStopLoss?: boolean;
  stopLossPercent?: number;
  exhaustionStopLoss?: boolean;
  stopLossMultiplier?: number;
  minDropPercent?: number;
  peakCheckCandles?: number;
  ascendingSplit?: boolean;
}

export async function applyIndicatorFiltersUS(
  candidates: Array<{ ticker: string; name: string; price: number; tamt: number; rate: number; excd: string }>,
  config: AutoSelectConfigV2_1,
  kisClient: KisApiClient,
  appKey: string,
  appSecret: string,
  accessToken: string,
  targetCount: number,
): Promise<typeof candidates> {
  const passed: typeof candidates = [];
  const ema20On = config.ema20Filter !== false;
  const ema5On = config.ema5Filter !== false;
  const disparityMin = config.ema20DisparityMin ?? 100;
  const disparityMax = config.ema20DisparityMax ?? 103;
  const rsiOn = config.rsiFilterEnabled !== false;
  const rsiMin = config.rsiMin ?? 40;
  const rsiMax = config.rsiMax ?? 65;
  const nmin = config.indicatorTimeframe ?? 5;

  console.log(`[V2.1:IndicatorFilter:US] EMA20=${ema20On}, EMA5=${ema5On}, 이격도=${disparityMin}~${disparityMax}%, RSI=${rsiOn ? `${rsiMin}~${rsiMax}` : 'OFF'}, 목표=${targetCount}개, ${nmin}분봉`);

  let checked = 0;
  for (const c of candidates) {
    if (passed.length >= targetCount) {
      console.log(`[V2.1:IndicatorFilter:US] 목표 ${targetCount}개 달성, 조기 종료 (${checked}/${candidates.length} 체크)`);
      break;
    }

    checked++;
    const rank = checked;

    try {
      await new Promise(resolve => setTimeout(resolve, 300));
      const barResp = await kisClient.getOverseasMinuteBars(
        appKey, appSecret, accessToken, c.ticker, nmin, 30, c.excd
      );

      if (!barResp.output2 || barResp.output2.length < 21) {
        console.log(`[V2.1:IndicatorFilter:US] #${rank} ${c.ticker}: 캔들부족(${barResp.output2?.length || 0}개) → SKIP`);
        continue;
      }

      const closes = barResp.output2
        .map((b: { last: string }) => parseFloat(b.last))
        .filter((v: number) => v > 0)
        .reverse();

      if (closes.length < 21) {
        console.log(`[V2.1:IndicatorFilter:US] #${rank} ${c.ticker}: 유효캔들부족(${closes.length}개) → SKIP`);
        continue;
      }

      const currentPrice = closes[closes.length - 1];

      // EMA20 check
      const ema20 = calculateEMA(closes, 20);
      if (ema20 === null) continue;
      if (ema20On && currentPrice <= ema20) {
        console.log(`[V2.1:IndicatorFilter:US] #${rank} ${c.ticker} ($${c.price}, ${c.rate.toFixed(1)}%): 현재가 ≤ EMA20 → SKIP`);
        continue;
      }

      // Disparity check
      const disparity = (currentPrice / ema20) * 100;
      if (disparity < disparityMin || disparity > disparityMax) {
        console.log(`[V2.1:IndicatorFilter:US] #${rank} ${c.ticker} ($${c.price}, ${c.rate.toFixed(1)}%): 이격도${disparity.toFixed(1)}% → SKIP`);
        continue;
      }

      // EMA5 check
      if (ema5On) {
        const ema5 = calculateEMA(closes, 5);
        if (ema5 === null || currentPrice <= ema5) {
          console.log(`[V2.1:IndicatorFilter:US] #${rank} ${c.ticker}: EMA5 미통과 → SKIP`);
          continue;
        }
      }

      // RSI check
      if (rsiOn) {
        const rsi = calculateRSI(closes, 14);
        if (rsi === null || rsi < rsiMin || rsi > rsiMax) {
          console.log(`[V2.1:IndicatorFilter:US] #${rank} ${c.ticker} ($${c.price}, ${c.rate.toFixed(1)}%): RSI(${rsi}) 범위 밖 → SKIP`);
          continue;
        }
      }

      console.log(`[V2.1:IndicatorFilter:US] #${rank} ${c.ticker} ($${c.price}, ${c.rate.toFixed(1)}%, 이격도${disparity.toFixed(1)}%): PASS [${passed.length + 1}/${targetCount}]`);
      passed.push(c);
    } catch (err) {
      console.warn(`[V2.1:IndicatorFilter:US] #${rank} ${c.ticker}: API에러 → SKIP`, err instanceof Error ? err.message : '');
    }
  }

  console.log(`[V2.1:IndicatorFilter:US] 결과: ${checked}개 체크 → ${passed.length}개 통과`);
  return passed;
}

// ==================== forceStop 헬퍼 ====================

/**
 * config의 tickers 배열에서 특정 종목 제거
 */
function removeTickerFromConfig(
  ticker: string,
  market: MarketType,
  strategyId: AccountStrategy = 'realtimeDdsobV2'
): void {
  const strategyConfig = getMarketStrategyConfig<RealtimeDdsobV2Config>(market, strategyId);
  if (strategyConfig) {
    const allTickers = extractTickerConfigsV2(strategyConfig as unknown as Record<string, unknown>);
    if (allTickers.some(t => t.ticker === ticker)) {
      const remaining = allTickers.filter(t => t.ticker !== ticker);
      setMarketStrategyConfig(market, strategyId, {
        ...strategyConfig,
        tickers: remaining,
      });
    }
  }
}

/**
 * 특정 종목 전량매도 + 추적종료 (forceStop)
 */
export async function forceStopRealtimeDdsobV2Ticker(
  ticker: string,
  market: MarketType,
  reason: 'force_stop' | 'auto_stop_loss' | 'exhaustion_stop_loss' | 'force_sell_candles' = 'force_stop',
  strategyId: AccountStrategy = 'realtimeDdsobV2',
  ctx?: AccountContext,
): Promise<{ success: boolean; soldQty: number; message: string }> {
  const store = ctx?.store ?? localStore;
  const tag = market === 'domestic' ? 'KR' : 'US';
  console.log(`[ForceStop:${tag}] ticker=${ticker}`);

  // 1. credentials & accessToken
  const credentials = ctx
    ? { appKey: ctx.credentials.appKey, appSecret: ctx.credentials.appSecret, accountNo: ctx.credentials.accountNo }
    : localStore.getCredentials<{ appKey: string; appSecret: string; accountNo: string }>();
  if (!credentials) {
    return { success: false, soldQty: 0, message: '자격증명을 찾을 수 없습니다' };
  }
  const kisClient = ctx?.kisClient ?? new KisApiClient();
  let accessToken = await getOrRefreshToken('', ctx?.accountId ?? config.accountId, credentials, kisClient);

  // 2. state 조회
  const state = store.getState<Record<string, unknown>>('realtimeDdsobV2State', ticker);

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
    removeTickerFromConfig(ticker, market, strategyId);
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

  store.addCycleHistory({
    ticker,
    market,
    strategy: strategyId,
    stockName: (state.stockName as string) || ticker,
    cycleNumber: (state.cycleNumber as number) || 1,
    autoSelected: (state.autoSelected as boolean) || false,
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
    autoStopLoss: (state.autoStopLoss as boolean) || false,
    stopLossPercent: (state.stopLossPercent as number) ?? -5,
    exhaustionStopLoss: (state.exhaustionStopLoss as boolean) || false,
    stopLossMultiplier: (state.stopLossMultiplier as number) ?? 3,
    exchangeCode: (state.exchangeCode as string) || '',
    selectionMode: (state.selectionMode as string) || '',
    conditionName: (state.conditionName as string) || '',
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
  store.deleteState('realtimeDdsobV2State', ticker);

  // 7. config에서 종목 제거
  removeTickerFromConfig(ticker, market, strategyId);

  console.log(`[ForceStop:${tag}] Completed: ${ticker} ${soldQty}주 매도, 추적종료`);
  return { success: true, soldQty, message: `${ticker} ${soldQty}주 매도 완료, 추적종료` };
}

// ==================== 메인 매매 처리 함수 ====================

/**
 * 실사오팔v2 매매 처리 함수 (국내/해외 통합)
 * 매 N분마다 호출되어 미체결 정리 → 계산 → 주문 제출 → 상태 갱신
 */
export async function processRealtimeDdsobV2Trading(
  userId: string,
  accountId: string,
  tickerConfig: RealtimeDdsobV2TickerConfig,
  globalConfig: Record<string, unknown>,
  market: MarketType,
  options?: { sellOnly?: boolean; strategyId?: AccountStrategy },
  ctx?: AccountContext,
): Promise<void> {
  const store = ctx?.store ?? localStore;
  const strategyId: AccountStrategy = options?.strategyId || 'realtimeDdsobV2';
  const sellOnly = options?.sellOnly ?? false;
  const { ticker, splitCount, profitPercent, intervalMinutes, principal: configPrincipal, minDropPercent, forceSellCandles } = tickerConfig;
  const stopAfterCycleEnd = (globalConfig.stopAfterCycleEnd as boolean) || false;
  const bufferPercent = 0.01;
  const tag = market === 'domestic' ? 'KR' : 'US';
  const fp = (p: number) => marketFormatPrice(p, market);

  console.log(`[RealtimeDdsobV2:${tag}] Processing ${userId}/${accountId} ticker=${ticker} interval=${intervalMinutes}min${sellOnly ? ' [SELL-ONLY]' : ''}`);

  // 자격증명 & 토큰
  const credentials = ctx
    ? { appKey: ctx.credentials.appKey, appSecret: ctx.credentials.appSecret, accountNo: ctx.credentials.accountNo }
    : localStore.getCredentials<{ appKey: string; appSecret: string; accountNo: string }>();
  if (!credentials) {
    console.log(`[RealtimeDdsobV2:${tag}] No credentials found`);
    return;
  }
  const kisClient = ctx?.kisClient ?? new KisApiClient();
  let accessToken = await getOrRefreshToken('', ctx?.accountId ?? accountId, credentials, kisClient);
  const chatId = await getUserTelegramChatId(userId);

  // 해외 거래소 코드
  const quoteExcd = tickerConfig.exchangeCode;
  const orderExcd = quoteExcd ? KisApiClient.quoteToOrderExchangeCode(quoteExcd) : KisApiClient.getExchangeCode(ticker);

  // ======== 0단계: 미체결 주문 정리 ========
  try {
    if (market === 'overseas') {
      const pendingOrdersResp = await kisClient.getPendingOrders(
        credentials.appKey, credentials.appSecret, accessToken, credentials.accountNo, orderExcd
      );
      const unfilledOrders = (pendingOrdersResp.output || []).filter(
        (o: { pdno: string; nccs_qty: string }) => o.pdno === ticker && parseInt(o.nccs_qty) > 0
      );
      if (unfilledOrders.length > 0) {
        console.log(`[RealtimeDdsobV2:${tag}] Canceling ${unfilledOrders.length} unfilled orders for ${ticker}`);
        for (const uf of unfilledOrders) {
          try {
            const cancelResult = await kisClient.cancelOrder(
              credentials.appKey, credentials.appSecret, accessToken, credentials.accountNo,
              { orderNo: uf.odno, ticker, exchange: orderExcd }
            );
            console.log(`[RealtimeDdsobV2:${tag}] Cancel ODNO=${uf.odno}: rt_cd=${cancelResult.rt_cd}`);
          } catch (cancelErr) {
            console.error(`[RealtimeDdsobV2:${tag}] Failed to cancel ODNO=${uf.odno}:`, cancelErr);
          }
          await new Promise(resolve => setTimeout(resolve, 300));
        }
      }
    } else {
      const todayKST = getKSTDateString();
      const pendingResp = await kisClient.getDomesticPendingOrders(
        credentials.appKey, credentials.appSecret, accessToken, credentials.accountNo,
        todayKST, ticker
      );
      const unfilledOrders = (pendingResp.output1 || []).filter(
        (o: { pdno: string; rmn_qty: string }) => o.pdno === ticker && parseInt(o.rmn_qty) > 0
      );
      if (unfilledOrders.length > 0) {
        console.log(`[RealtimeDdsobV2:${tag}] Canceling ${unfilledOrders.length} unfilled orders for ${ticker}`);
        for (const uf of unfilledOrders) {
          try {
            const cancelResult = await kisClient.cancelDomesticOrder(
              credentials.appKey, credentials.appSecret, accessToken, credentials.accountNo,
              { orderNo: uf.odno, orgNo: uf.orgn_odno, ticker }
            );
            console.log(`[RealtimeDdsobV2:${tag}] Cancel ODNO=${uf.odno}: rt_cd=${cancelResult.rt_cd}`);
          } catch (cancelErr) {
            console.error(`[RealtimeDdsobV2:${tag}] Failed to cancel ODNO=${uf.odno}:`, cancelErr);
          }
          await new Promise(resolve => setTimeout(resolve, 300));
        }
      }
    }
  } catch (err) {
    if (isTokenExpiredError(err)) {
      console.log(`[RealtimeDdsobV2:${tag}] Token expired in step 0, refreshing...`);
      accessToken = await getOrRefreshToken('', ctx?.accountId ?? accountId, credentials, kisClient, true);
    } else {
      console.error(`[RealtimeDdsobV2:${tag}] Error in unfilled order cleanup:`, err);
    }
  }

  // ======== 체결 내역 확인 & state 동기화 ========
  let state = store.getState<Record<string, unknown>>('realtimeDdsobV2State', ticker);

  // 전일 EOD 매도 미체결 잔여 정리
  if (state?.eodSellPending) {
    console.warn(`[RealtimeDdsobV2:${tag}] Clearing stale eodSellPending for ${ticker} (previous day leftover)`);
    store.updateState('realtimeDdsobV2State', ticker, {
      eodSellPending: null,
      eodSellOrderNo: null,
      eodSellDate: null,
    });
    delete state.eodSellPending;
    delete state.eodSellOrderNo;
  }

  // 동시 실행 방지
  if (state?.lastCheckedAt) {
    const lastCheckedStr = state.lastCheckedAt as string;
    const lastChecked = new Date(lastCheckedStr);
    const elapsedMs = Date.now() - lastChecked.getTime();
    const guardMs = Math.max(30 * 1000, (intervalMinutes - 1) * 60 * 1000);
    if (elapsedMs < guardMs) {
      console.log(`[RealtimeDdsobV2:${tag}] Skipping ${ticker}: processed ${Math.round(elapsedMs / 1000)}s ago (guard=${intervalMinutes - 1}min)`);
      return;
    }
  }

  // 오늘 날짜 계산 (마켓별)
  const todayStr = market === 'domestic'
    ? getKSTDateString()
    : (() => {
        const now = new Date();
        const estOffset = -5; const edtOffset = -4;
        const year = now.getUTCFullYear();
        const marchSecondSunday = new Date(year, 2, 8 + (7 - new Date(year, 2, 1).getDay()) % 7);
        const novFirstSunday = new Date(year, 10, 1 + (7 - new Date(year, 10, 1).getDay()) % 7);
        const isDST = now >= marchSecondSunday && now < novFirstSunday;
        const usTime = new Date(now.getTime() + (isDST ? edtOffset : estOffset) * 60 * 60 * 1000);
        return `${usTime.getUTCFullYear()}${String(usTime.getUTCMonth() + 1).padStart(2, '0')}${String(usTime.getUTCDate()).padStart(2, '0')}`;
      })();

  // 이전 주기 이후 체결된 주문 확인
  let fillCheckFailed = false;
  if (state && state.lastOrderNumbers && (state.lastOrderNumbers as string[]).length > 0) {
    try {
      await new Promise(resolve => setTimeout(resolve, 300));

      const queryStartDate = (state.lastOrderDate as string) || todayStr;

      let filledOrders: Array<{ odno: string; sll_buy_dvsn_cd: string; qty: number; price: number; amount: number }> = [];

      if (market === 'overseas') {
        const histResp = await kisClient.getOrderHistory(
          credentials.appKey, credentials.appSecret, accessToken, credentials.accountNo,
          queryStartDate, todayStr, ticker, '00', '01'
        );
        if (histResp.rt_cd !== '0') {
          throw new Error(`Order history API error: rt_cd=${histResp.rt_cd}, msg=${histResp.msg1}`);
        }
        filledOrders = (histResp.output || [])
          .filter((o: { odno: string; ft_ccld_qty: string }) => (state!.lastOrderNumbers as string[]).includes(o.odno) && parseInt(o.ft_ccld_qty) > 0)
          .map((o: { odno: string; sll_buy_dvsn_cd: string; ft_ccld_qty: string; ft_ccld_unpr3: string; ft_ccld_amt3: string }) => ({
            odno: o.odno,
            sll_buy_dvsn_cd: o.sll_buy_dvsn_cd,
            qty: parseInt(o.ft_ccld_qty),
            price: parseFloat(o.ft_ccld_unpr3),
            amount: parseFloat(o.ft_ccld_amt3) || parseFloat(o.ft_ccld_unpr3) * parseInt(o.ft_ccld_qty),
          }));
      } else {
        const histResp = await kisClient.getDomesticOrderHistory(
          credentials.appKey, credentials.appSecret, accessToken, credentials.accountNo,
          queryStartDate, todayStr, '01', '00', ticker
        );
        if (histResp.rt_cd !== '0') {
          throw new Error(`Domestic order history API error: rt_cd=${histResp.rt_cd}, msg=${histResp.msg1}`);
        }
        filledOrders = (histResp.output1 || [])
          .filter((o: { odno: string; tot_ccld_qty: string }) => (state!.lastOrderNumbers as string[]).includes(o.odno) && parseInt(o.tot_ccld_qty) > 0)
          .map((o: { odno: string; sll_buy_dvsn_cd: string; tot_ccld_qty: string; avg_prvs: string; tot_ccld_amt: string }) => ({
            odno: o.odno,
            sll_buy_dvsn_cd: o.sll_buy_dvsn_cd,
            qty: parseInt(o.tot_ccld_qty),
            price: parseFloat(o.avg_prvs),
            amount: parseFloat(o.tot_ccld_amt) || parseFloat(o.avg_prvs) * parseInt(o.tot_ccld_qty),
          }));
      }

      let buyRecords: RealtimeBuyRecordV2[] = (state.buyRecords as RealtimeBuyRecordV2[]) || [];
      let hadTrade = false;
      let totalRealizedProfit = (state.totalRealizedProfit as number) || 0;
      let totalBuyAmount = (state.totalBuyAmount as number) || 0;
      let totalSellAmount = (state.totalSellAmount as number) || 0;
      let maxRounds = (state.maxRounds as number) ?? splitCount;

      // 재시도 헬퍼: localStore 상태 업데이트 (최대 2회)
      const retryStateUpdate = async (data: Record<string, unknown>, label: string): Promise<boolean> => {
        for (let attempt = 1; attempt <= 2; attempt++) {
          try {
            store.updateState('realtimeDdsobV2State', ticker, data);
            return true;
          } catch (err) {
            console.error(`[RealtimeDdsobV2:${tag}] ${label} attempt ${attempt}/2 failed:`, err);
            if (attempt < 2) await new Promise(r => setTimeout(r, 500));
          }
        }
        return false;
      };

      // FIFO 매도 체결 처리
      const consumeBuyRecordsFIFO = (filledQty: number, _filledAmount: number): { consumedCost: number; consumedQty: number } => {
        let remainQty = filledQty;
        let consumedCost = 0;
        let consumedQty = 0;

        while (remainQty > 0 && buyRecords.length > 0) {
          const oldest = buyRecords[0];
          if (oldest.quantity <= remainQty) {
            consumedCost += oldest.buyAmount;
            consumedQty += oldest.quantity;
            remainQty -= oldest.quantity;
            buyRecords.splice(0, 1);
          } else {
            const ratio = remainQty / oldest.quantity;
            const partialCost = oldest.buyAmount * ratio;
            consumedCost += partialCost;
            consumedQty += remainQty;
            buyRecords[0] = {
              ...oldest,
              quantity: oldest.quantity - remainQty,
              buyAmount: oldest.buyAmount - partialCost,
            };
            remainQty = 0;
          }
        }

        if (remainQty > 0) {
          console.warn(`[RealtimeDdsobV2:${tag}] FIFO: ${remainQty}주 unmatched (no more buyRecords)`);
        }

        return { consumedCost, consumedQty };
      };

      const newBuyRecordIds: string[] = [];
      for (const filled of filledOrders) {
        const isBuy = filled.sll_buy_dvsn_cd === '02';

        if (isBuy) {
          const newId = generateRealtimeBuyRecordIdV2();
          buyRecords.push({
            id: newId,
            buyPrice: filled.price,
            quantity: filled.qty,
            buyAmount: filled.amount,
            buyDate: new Date().toISOString(),
          });
          newBuyRecordIds.push(newId);
          totalBuyAmount += filled.amount;
          hadTrade = true;
          console.log(`[RealtimeDdsobV2:${tag}] Buy filled: ${filled.qty}주 @ ${fp(filled.price)}`);
        } else {
          const { consumedCost, consumedQty } = consumeBuyRecordsFIFO(filled.qty, filled.amount);
          if (consumedQty === 0) {
            console.warn(`[RealtimeDdsobV2:${tag}] Sell ODNO=${filled.odno}: no buyRecords to consume (already empty)`);
            continue;
          }
          const profit = filled.amount - consumedCost;
          totalSellAmount += filled.amount;
          totalRealizedProfit += profit;
          hadTrade = true;
          console.log(`[RealtimeDdsobV2:${tag}] Sell filled (FIFO): ${filled.qty}주 @ ${fp(filled.price)}, cost=${fp(consumedCost)}, profit=${fp(profit)}, remaining=${buyRecords.length} records`);
        }
      }

      // ======== 매수 체결 시 저장된 RSI를 buyRecord에 첨부 ========
      if (newBuyRecordIds.length > 0 && state.pendingRsiData) {
        const rsiData = state.pendingRsiData as RSIResult;
        for (let i = 0; i < buyRecords.length; i++) {
          if (newBuyRecordIds.includes(buyRecords[i].id)) {
            buyRecords[i] = {
              ...buyRecords[i],
              rsi5m: rsiData.rsi5m,
              rsi15m: rsiData.rsi15m,
              rsi5mBars: rsiData.rsi5mBars,
              rsi15mBars: rsiData.rsi15mBars,
            };
          }
        }
        console.log(`[RealtimeDdsobV2:${tag}] RSI attached to ${newBuyRecordIds.length} buyRecord(s): 5m=${rsiData.rsi5m}, 15m=${rsiData.rsi15m}`);
      }

      // ======== 상태 저장 ========
      const fillStateData: Record<string, unknown> = {
        buyRecords,
        candlesSinceCycleStart: ((state.candlesSinceCycleStart as number) || 0) + 1,
        maxRounds,
        totalRealizedProfit,
        totalBuyAmount,
        totalSellAmount,
        lastOrderNumbers: [] as string[],
        lastSellInfo: [] as unknown[],
        lastOrderDate: '',
        pendingRsiData: null, // FieldValue.delete() → null
        updatedAt: new Date().toISOString(),
      };

      // 사이클 완료 체크
      if (buyRecords.length === 0 && hadTrade && filledOrders.some(f => f.sll_buy_dvsn_cd === '01')) {
        console.log(`[RealtimeDdsobV2:${tag}] Cycle completed for ${userId}/${accountId}/${ticker}`);

        // 1) 상태 업데이트 먼저
        const completedData: Record<string, unknown> = {
          ...fillStateData,
          candlesSinceCycleStart: 0,
          status: 'completed',
          indicators: null,
          completedAt: new Date().toISOString(),
        };
        const success = await retryStateUpdate(completedData, 'Cycle completion');
        if (!success) throw new Error('Cycle completion state update failed after retries');

        // 2) 사이클 이력 저장 (중복 방지: localStore에서는 단순 추가)
        try {
          store.addCycleHistory({
            ticker,
            market,
            strategy: strategyId,
            stockName: (tickerConfig.stockName as string) || ticker,
            cycleNumber: (state.cycleNumber as number) || 1,
            autoSelected: (state.autoSelected as boolean) || false,
            startedAt: state.startedAt,
            completedAt: new Date().toISOString(),
            principal: state.principal,
            splitCount,
            profitPercent,
            amountPerRound: state.amountPerRound,
            intervalMinutes,
            forceSellCandles: (state.forceSellCandles as number) || 0,
            minDropPercent: (state.minDropPercent as number) || 0,
            peakCheckCandles: (state.peakCheckCandles as number) ?? 0,
            bufferPercent: 0.01,
            autoStopLoss: (state.autoStopLoss as boolean) || false,
            stopLossPercent: (state.stopLossPercent as number) ?? -5,
            exhaustionStopLoss: (state.exhaustionStopLoss as boolean) || false,
            stopLossMultiplier: (state.stopLossMultiplier as number) ?? 3,
            exchangeCode: (state.exchangeCode as string) || '',
            selectionMode: (state.selectionMode as string) || '',
            conditionName: (state.conditionName as string) || '',
            totalBuyAmount,
            totalSellAmount,
            totalRealizedProfit,
            finalProfitRate: (state.principal as number) > 0 ? totalRealizedProfit / (state.principal as number) : 0,
            maxRoundsAtEnd: maxRounds,
            candlesSinceCycleStart: (state.candlesSinceCycleStart as number) || 0,
            totalForceSellCount: (state.totalForceSellCount as number) || 0,
            totalForceSellLoss: (state.totalForceSellLoss as number) || 0,
          });
        } catch (histErr) {
          console.error(`[RealtimeDdsobV2:${tag}] Failed to save cycle history (non-critical):`, histErr);
        }

        console.log(`[RealtimeDdsobV2:${tag}] Cycle completed telegram skipped (reported at market close)`);

        if (stopAfterCycleEnd) {
          console.log(`[RealtimeDdsobV2:${tag}] stopAfterCycleEnd=true, stopping`);
          if (chatId) {
            await sendTelegramMessage(chatId,
              `ℹ️ <b>${tickerConfig.stockName || ticker} 실사오팔v2 사이클 종료됨</b>\n\n` +
              `사이클 종료 후 자동 재시작이 비활성화되어 있습니다.\n설정에서 재시작하세요.`,
              'HTML'
            );
          }
          return;
        }

        state = null;
        try { store.deleteState('realtimeDdsobV2State', ticker); } catch (e) {
          console.warn(`[RealtimeDdsobV2:${tag}] state delete failed (will be handled on next tick):`, e);
        }

        // autoSelected 종목: 사이클 종료 시 config에서 제거
        if (tickerConfig.autoSelected) {
          try {
            const latestConfig = getMarketStrategyConfig<RealtimeDdsobV2Config>(market, strategyId);
            if (latestConfig) {
              const latestTickers = extractTickerConfigsV2(latestConfig as unknown as Record<string, unknown>);
              const remaining = latestTickers.filter(t => !(t.ticker === ticker && t.autoSelected));
              setMarketStrategyConfig(market, strategyId, {
                ...latestConfig,
                tickers: remaining,
              });
              console.log(`[RealtimeDdsobV2:${tag}] Removed completed autoSelected ticker ${ticker} from config (${latestTickers.length} → ${remaining.length})`);
            }
          } catch (e) {
            console.error(`[RealtimeDdsobV2:${tag}] Failed to remove ticker ${ticker} from config:`, e);
          }
          return;
        }

        // config에서 제거된 종목(orphaned): 사이클 완료 후 새 사이클 시작하지 않음
        {
          const latestConfig = getMarketStrategyConfig<RealtimeDdsobV2Config>(market, strategyId);
          if (latestConfig) {
            const latestTickers = extractTickerConfigsV2(latestConfig as unknown as Record<string, unknown>);
            const stillInConfig = latestTickers.some(t => t.ticker === ticker);
            if (!stillInConfig) {
              console.log(`[RealtimeDdsobV2:${tag}] Orphaned ticker ${ticker} cycle completed. Not restarting (removed from config).`);
              return;
            }
          }
        }
      } else if (hadTrade) {
        const success = await retryStateUpdate(fillStateData, 'Fill state update');
        if (!success) throw new Error('Fill state update failed after retries');
        state = store.getState<Record<string, unknown>>('realtimeDdsobV2State', ticker);
      } else {
        // 체결 없음: lastOrderNumbers 클리어만
        const cleared = await retryStateUpdate({
          lastOrderNumbers: [],
          lastSellInfo: [],
          lastOrderDate: '',
        }, 'Clear order tracking');
        if (cleared && state) {
          state.lastOrderNumbers = [];
          state.lastSellInfo = [];
        }
      }
    } catch (histErr) {
      if (isTokenExpiredError(histErr)) {
        console.log(`[RealtimeDdsobV2:${tag}] Token expired in fill check, refreshing and retrying...`);
        try {
          accessToken = await getOrRefreshToken('', ctx?.accountId ?? accountId, credentials, kisClient, true);
          const queryStartDate = (state!.lastOrderDate as string) || todayStr;
          if (market === 'overseas') {
            const retryResp = await kisClient.getOrderHistory(
              credentials.appKey, credentials.appSecret, accessToken, credentials.accountNo,
              queryStartDate, todayStr, ticker, '00', '01'
            );
            if (retryResp.rt_cd !== '0') throw new Error(`Retry failed: ${retryResp.msg1}`);
            console.log(`[RealtimeDdsobV2:${tag}] Token refreshed, will process fills next tick`);
          } else {
            const retryResp = await kisClient.getDomesticOrderHistory(
              credentials.appKey, credentials.appSecret, accessToken, credentials.accountNo,
              queryStartDate, todayStr, '01', '00', ticker
            );
            if (retryResp.rt_cd !== '0') throw new Error(`Retry failed: ${retryResp.msg1}`);
            console.log(`[RealtimeDdsobV2:${tag}] Token refreshed, will process fills next tick`);
          }
          fillCheckFailed = true;
        } catch (retryErr) {
          console.error(`[RealtimeDdsobV2:${tag}] Fill check retry failed:`, retryErr);
          fillCheckFailed = true;
        }
      } else {
        console.error(`[RealtimeDdsobV2:${tag}] Error checking order history:`, histErr);
        fillCheckFailed = true;
      }
    }
  }

  // 체결 체크 실패 시 새 주문 제출 금지
  if (fillCheckFailed) {
    console.error(`[RealtimeDdsobV2:${tag}] Skipping order submission due to fill check failure. Will retry next tick.`);
    return;
  }

  // ======== 1단계: 현재가 조회 ========
  await new Promise(resolve => setTimeout(resolve, 300));
  let currentPrice: number;
  let domesticUpperLimit = 0;
  let domesticLowerLimit = 0;
  let domesticTickSize: number | undefined;

  if (market === 'overseas') {
    try {
      const priceData = await kisClient.getCurrentPrice(
        credentials.appKey, credentials.appSecret, accessToken, ticker, quoteExcd
      );
      currentPrice = parseFloat(priceData.output?.last || '0');
    } catch (priceErr) {
      if (isTokenExpiredError(priceErr)) {
        console.log(`[RealtimeDdsobV2:${tag}] Token expired at getCurrentPrice, refreshing and retrying...`);
        accessToken = await getOrRefreshToken('', ctx?.accountId ?? accountId, credentials, kisClient, true);
        const retryData = await kisClient.getCurrentPrice(
          credentials.appKey, credentials.appSecret, accessToken, ticker, quoteExcd
        );
        currentPrice = parseFloat(retryData.output?.last || '0');
      } else {
        throw priceErr;
      }
    }
  } else {
    const priceData = await kisClient.getDomesticCurrentPrice(
      credentials.appKey, credentials.appSecret, accessToken, ticker
    );
    currentPrice = parseInt(priceData.output?.stck_prpr || '0');
    domesticUpperLimit = parseInt(priceData.output?.stck_mxpr || '0');
    domesticLowerLimit = parseInt(priceData.output?.stck_llam || '0');
    const asprUnit = parseInt(priceData.output?.aspr_unit || '0');
    if (asprUnit > 0) domesticTickSize = asprUnit;
  }

  if (currentPrice <= 0) {
    console.log(`[RealtimeDdsobV2:${tag}] Invalid price for ${ticker}: ${currentPrice}`);
    return;
  }

  // ======== 직전 캔들 종가 조회 ========
  let prevCandleClose: number | null = null;
  try {
    await new Promise(resolve => setTimeout(resolve, 300));
    if (market === 'overseas') {
      const minuteData = await kisClient.getOverseasMinuteBars(
        credentials.appKey, credentials.appSecret, accessToken, ticker, 1, 2, quoteExcd
      );
      const prevBar = minuteData.output2?.[1];
      if (prevBar) {
        prevCandleClose = parseFloat(prevBar.last || '0');
      }
    } else {
      const now = new Date(Date.now() + 9 * 60 * 60 * 1000); // KST
      const hourStr = `${String(now.getUTCHours()).padStart(2, '0')}${String(now.getUTCMinutes()).padStart(2, '0')}00`;
      const minuteData = await kisClient.getDomesticMinuteBars(
        credentials.appKey, credentials.appSecret, accessToken, ticker, hourStr
      );
      const prevBar = minuteData.output2?.[1];
      if (prevBar) {
        prevCandleClose = parseInt(prevBar.stck_prpr || '0');
      }
    }
    if (prevCandleClose && prevCandleClose > 0) {
      console.log(`[RealtimeDdsobV2:${tag}] ${ticker} prevCandleClose=${prevCandleClose} (currentPrice=${currentPrice})`);
    }
  } catch (err) {
    console.warn(`[RealtimeDdsobV2:${tag}] Failed to fetch prev candle close for ${ticker}, falling back to state.previousPrice:`, (err as Error).message);
  }

  // ======== 종목명 보완 (국내주식, stockName 미설정 시 1회) ========
  if (market === 'domestic' && !tickerConfig.stockName) {
    try {
      const infoResp = await kisClient.getDomesticStockInfo(
        credentials.appKey, credentials.appSecret, accessToken, ticker
      );
      const stockName = infoResp.output1?.hts_kor_isnm;
      if (stockName) {
        const strategyConfig = getMarketStrategyConfig<RealtimeDdsobV2Config>(market, strategyId);
        const tickers = strategyConfig?.tickers as RealtimeDdsobV2TickerConfig[] | undefined;
        if (tickers) {
          const updatedTickers = tickers.map(t =>
            t.ticker === ticker ? { ...t, stockName } : t
          );
          setMarketStrategyConfig(market, strategyId, {
            ...strategyConfig,
            tickers: updatedTickers,
          });
          console.log(`[RealtimeDdsobV2:${tag}] Updated stockName for ${ticker}: ${stockName}`);
        }
      }
    } catch (err) {
      console.error(`[RealtimeDdsobV2:${tag}] Failed to fetch stockName for ${ticker}:`, err);
    }
  }

  // ======== 상태 초기화 (신규 사이클) ========
  if (!state) {
    if (sellOnly) {
      console.log(`[RealtimeDdsobV2:${tag}] [SELL-ONLY] No active state for ${ticker}, skipping new cycle`);
      return;
    }
    const principal = configPrincipal;
    const amountPerRound = principal / splitCount;

    // 이전 사이클 번호 조회 — localStore에서 cycleHistory 검색
    const allCycles = store.getAllCycleHistory<Record<string, unknown>>();
    const matchingCycles = allCycles
      .filter(c => c.ticker === ticker && c.strategy === strategyId)
      .sort((a, b) => ((b.cycleNumber as number) || 0) - ((a.cycleNumber as number) || 0));
    const lastCycleNumber = matchingCycles.length > 0 ? ((matchingCycles[0].cycleNumber as number) || 0) : 0;

    state = {
      ticker,
      market,
      status: 'active',
      stockName: tickerConfig.stockName || ticker,
      autoSelected: tickerConfig.autoSelected || false,
      exchangeCode: tickerConfig.exchangeCode || '',
      cycleNumber: lastCycleNumber + 1,
      principal,
      splitCount,
      maxRounds: splitCount,
      amountPerRound,
      profitPercent,
      forceSellCandles: forceSellCandles || 0,
      minDropPercent: minDropPercent || 0,
      peakCheckCandles: tickerConfig.peakCheckCandles ?? 0,
      intervalMinutes,
      autoStopLoss: tickerConfig.autoStopLoss || false,
      stopLossPercent: tickerConfig.stopLossPercent ?? -5,
      exhaustionStopLoss: tickerConfig.exhaustionStopLoss || false,
      stopLossMultiplier: tickerConfig.stopLossMultiplier ?? 3,
      selectionMode: tickerConfig.selectionMode || '',
      conditionName: tickerConfig.conditionName || '',
      buyRecords: [],
      candlesSinceCycleStart: 0,
      candlesBeforeFirstBuy: 0,
      previousPrice: currentPrice,
      totalRealizedProfit: 0,
      totalBuyAmount: 0,
      totalSellAmount: 0,
      lastOrderNumbers: [],
      lastSellInfo: [],
      lastOrderDate: '',
      lastCheckedAt: new Date().toISOString(),
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    // EMA/RSI 지표 초기화
    const { indicators, recentCloses1m } = await fetchIndicatorsAtStartup(
      kisClient, credentials.appKey, credentials.appSecret,
      accessToken, ticker, market, tag
    );
    state.indicators = indicators;
    const peakCandles = tickerConfig.peakCheckCandles ?? 10;
    state.recentPrices = peakCandles > 0 ? recentCloses1m.slice(-peakCandles) : [];

    store.setState('realtimeDdsobV2State', ticker, state);
    console.log(`[RealtimeDdsobV2:${tag}] New cycle started: principal=${fp(principal)}, amountPerRound=${fp(amountPerRound)}, previousPrice=${fp(currentPrice)}`);

    if (chatId) {
      await sendTelegramMessage(chatId,
        `📋 <b>새 사이클 시작</b> [${tickerConfig.stockName || ticker}]\n\n` +
        `투자원금: ${fp(principal)}\n` +
        `1회분: ${fp(amountPerRound)}\n` +
        `기준가: ${fp(currentPrice)}\n` +
        `첫 매수 즉시 진행...`,
        'HTML'
      );
    }

    // 새 사이클 생성 후 바로 아래 계산·매수 단계로 진행
  }

  // 완료 상태면 재시작 또는 종료
  if (state.status === 'completed') {
    if (stopAfterCycleEnd) {
      console.log(`[RealtimeDdsobV2:${tag}] Cycle completed, stopAfterCycleEnd=true`);
      return;
    }
    store.deleteState('realtimeDdsobV2State', ticker);
    console.log(`[RealtimeDdsobV2:${tag}] Auto-restart: deleted completed state`);
    return;
  }

  // ======== EMA/RSI 지표 갱신 (매 틱) ========
  if ((state.indicators as IndicatorsState)?.initialized) {
    updateIndicatorsOnTick(state.indicators as IndicatorsState, currentPrice, intervalMinutes);
    const ind = state.indicators as IndicatorsState;
    console.log(`[RealtimeDdsobV2:${tag}] ${ticker} indicators: EMA9(1m)=${ind.ema9_1m !== null ? (market === 'overseas' ? ind.ema9_1m.toFixed(2) : ind.ema9_1m.toFixed(0)) : 'N/A'} EMA20(5m)=${ind.ema20_5m !== null ? (market === 'overseas' ? ind.ema20_5m.toFixed(2) : ind.ema20_5m.toFixed(0)) : 'N/A'} RSI(1m)=${ind.rsi14_1m ?? 'N/A'} RSI(5m)=${ind.rsi14_5m ?? 'N/A'}`);
  }

  // ======== 2단계: 계산 ========
  const buyRecords: RealtimeBuyRecordV2[] = (state.buyRecords as RealtimeBuyRecordV2[]) || [];
  const isFirstBuy = buyRecords.length === 0;
  const previousPrice = (prevCandleClose && prevCandleClose > 0) ? prevCandleClose : ((state.previousPrice as number) || currentPrice);
  let maxRounds = (state.maxRounds as number) ?? splitCount;

  if (isFirstBuy && maxRounds < splitCount) {
    console.log(`[RealtimeDdsobV2:${tag}] Resetting maxRounds from ${maxRounds} to ${splitCount}`);
    maxRounds = splitCount;
    store.updateState('realtimeDdsobV2State', ticker, { maxRounds: splitCount });
  }

  // ======== KIS API 잔고 조회 (평단가 기반 매도용) ========
  let kisAvgPrice = 0;
  let kisHoldingQty = 0;
  if (buyRecords.length > 0) {
    try {
      await new Promise(resolve => setTimeout(resolve, 300));
      if (market === 'overseas') {
        const balanceData = await kisClient.getBalance(
          credentials.appKey, credentials.appSecret, accessToken, credentials.accountNo
        );
        const holdingsArray = Array.isArray(balanceData.output1) ? balanceData.output1 : [];
        const holdingData = holdingsArray.find((h: { ovrs_pdno: string }) => h.ovrs_pdno === ticker);
        if (holdingData) {
          kisAvgPrice = parseFloat(holdingData.pchs_avg_pric || '0');
          kisHoldingQty = parseInt(holdingData.ovrs_cblc_qty || '0');
        }
      } else {
        const balanceData = await kisClient.getDomesticBalance(
          credentials.appKey, credentials.appSecret, accessToken, credentials.accountNo
        );
        const holdingsArray = Array.isArray(balanceData.output1) ? balanceData.output1 : [];
        const holdingData = holdingsArray.find((h: { pdno: string }) => h.pdno === ticker);
        if (holdingData) {
          kisAvgPrice = parseFloat(holdingData.pchs_avg_pric || '0');
          kisHoldingQty = parseInt(holdingData.hldg_qty || '0');
        }
      }
      console.log(`[RealtimeDdsobV2:${tag}] KIS holdings: ${ticker} avgPrice=${fp(kisAvgPrice)}, qty=${kisHoldingQty}`);
    } catch (balanceErr) {
      if (isTokenExpiredError(balanceErr)) {
        accessToken = await getOrRefreshToken('', ctx?.accountId ?? accountId, credentials, kisClient, true);
        try {
          if (market === 'overseas') {
            const balanceData = await kisClient.getBalance(
              credentials.appKey, credentials.appSecret, accessToken, credentials.accountNo
            );
            const holdingsArray = Array.isArray(balanceData.output1) ? balanceData.output1 : [];
            const holdingData = holdingsArray.find((h: { ovrs_pdno: string }) => h.ovrs_pdno === ticker);
            if (holdingData) {
              kisAvgPrice = parseFloat(holdingData.pchs_avg_pric || '0');
              kisHoldingQty = parseInt(holdingData.ovrs_cblc_qty || '0');
            }
          } else {
            const balanceData = await kisClient.getDomesticBalance(
              credentials.appKey, credentials.appSecret, accessToken, credentials.accountNo
            );
            const holdingsArray = Array.isArray(balanceData.output1) ? balanceData.output1 : [];
            const holdingData = holdingsArray.find((h: { pdno: string }) => h.pdno === ticker);
            if (holdingData) {
              kisAvgPrice = parseFloat(holdingData.pchs_avg_pric || '0');
              kisHoldingQty = parseInt(holdingData.hldg_qty || '0');
            }
          }
          console.log(`[RealtimeDdsobV2:${tag}] KIS holdings (retry): ${ticker} avgPrice=${fp(kisAvgPrice)}, qty=${kisHoldingQty}`);
        } catch (retryErr) {
          console.error(`[RealtimeDdsobV2:${tag}] KIS balance retry failed:`, retryErr);
        }
      } else {
        console.error(`[RealtimeDdsobV2:${tag}] KIS balance failed:`, balanceErr);
      }
    }
  }

  const equalAmountPerRound = (state.amountPerRound as number) || (state.principal as number) / splitCount;
  const effectiveAmountPerRound = tickerConfig.ascendingSplit
    ? getAscendingAmountForRound((state.principal as number), splitCount, buyRecords.length, currentPrice)
    : equalAmountPerRound;

  const calcResult = calculateRealtimeDdsobV2({
    ticker,
    market,
    currentPrice,
    previousPrice,
    buyRecords,
    splitCount,
    profitPercent,
    amountPerRound: effectiveAmountPerRound,
    isFirstBuy,
    candlesSinceCycleStart: (state.candlesSinceCycleStart as number) || 0,
    maxRounds,
    bufferPercent,
    kisAvgPrice,
    kisHoldingQty,
    tickSize: domesticTickSize,
    minDropPercent,
    recentPrices: state.recentPrices as number[] | undefined,
    peakCheckCandles: tickerConfig.peakCheckCandles,
  });

  console.log(`[RealtimeDdsobV2:${tag}] Calc result: action=${calcResult.action}, reason=${calcResult.actionReason}, buys=${calcResult.buyOrders.length}, sells=${calcResult.sellOrders.length}`);

  if (calcResult.action === 'hold') {
    // sell-only 모드: 매수 관련 hold 로직 스킵, 상태만 갱신
    if (sellOnly) {
      const holdUpdate: Record<string, unknown> = {
        previousPrice: currentPrice,
        lastCheckedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      if (buyRecords.length > 0) {
        holdUpdate.candlesSinceCycleStart = ((state.candlesSinceCycleStart as number) || 0) + 1;
      }
      if (state.indicators) {
        holdUpdate.indicators = state.indicators;
      }
      const holdPeakCandles = tickerConfig.peakCheckCandles ?? 10;
      if (holdPeakCandles > 0) {
        const holdRecentPrices = [...((state.recentPrices as number[]) || []), currentPrice];
        if (holdRecentPrices.length > holdPeakCandles) {
          holdRecentPrices.splice(0, holdRecentPrices.length - holdPeakCandles);
        }
        holdUpdate.recentPrices = holdRecentPrices;
      }
      store.updateState('realtimeDdsobV2State', ticker, holdUpdate);
      return;
    }

    // ======== 1회분 매수금 부족 감지 ========
    if (isFirstBuy && calcResult.buyOrders.length === 0 && calcResult.analysis.availableRounds > 0) {
      const amountPerRound = (state.amountPerRound as number) || (state.principal as number) / splitCount;
      console.log(`[RealtimeDdsobV2:${tag}] ${ticker} 1회분 매수금(${fp(amountPerRound)}) < 주가(${fp(currentPrice)}) → 매수 불가, 종목 제외`);

      if (buyRecords.length > 0) {
        const result = await forceStopRealtimeDdsobV2Ticker(ticker, market, 'force_stop', strategyId);
        if (chatId) {
          await sendTelegramMessage(chatId,
            `⚠️ <b>매수금 부족 → 청산</b> [${tickerConfig.stockName || ticker}]\n\n` +
            `1회분 ${fp(amountPerRound)} < 주가 ${fp(currentPrice)}\n` +
            `${result.success ? `전량 매도 ${result.soldQty}주` : `매도 실패: ${result.message}`}`,
            'HTML'
          );
        }
      } else {
        store.deleteState('realtimeDdsobV2State', ticker);
        if (tickerConfig.autoSelected) {
          const latestConfig = getMarketStrategyConfig<RealtimeDdsobV2Config>(market, strategyId);
          if (latestConfig) {
            const latestTickers = extractTickerConfigsV2(latestConfig as unknown as Record<string, unknown>);
            const remaining = latestTickers.filter(t => !(t.ticker === ticker && t.autoSelected));
            setMarketStrategyConfig(market, strategyId, {
              ...latestConfig,
              tickers: remaining,
            });
            console.log(`[RealtimeDdsobV2:${tag}] Removed unaffordable autoSelected ticker ${ticker} from config (${latestTickers.length} → ${remaining.length})`);
          }
        }
        if (chatId) {
          await sendTelegramMessage(chatId,
            `⚠️ <b>매수금 부족 → 종목 제외</b> [${tickerConfig.stockName || ticker}]\n\n` +
            `1회분 ${fp(amountPerRound)} < 주가 ${fp(currentPrice)}\n` +
            `다음 틱에서 새 종목 재선정`,
            'HTML'
          );
        }
      }
      return;
    }

    // ======== 첫 매수 타임아웃: autoSelected 종목 ========
    if (isFirstBuy && tickerConfig.autoSelected) {
      const newCandlesBeforeFirstBuy = ((state.candlesBeforeFirstBuy as number) || 0) + 1;
      if (newCandlesBeforeFirstBuy >= FIRST_BUY_TIMEOUT_CANDLES) {
        console.log(`[RealtimeDdsobV2:${tag}] First buy timeout: ${ticker} no buy in ${newCandlesBeforeFirstBuy} candles (${newCandlesBeforeFirstBuy * intervalMinutes}min) → removing`);
        store.deleteState('realtimeDdsobV2State', ticker);
        const latestConfig = getMarketStrategyConfig<RealtimeDdsobV2Config>(market, strategyId);
        if (latestConfig) {
          const latestTickers = extractTickerConfigsV2(latestConfig as unknown as Record<string, unknown>);
          const remaining = latestTickers.filter(t => !(t.ticker === ticker && t.autoSelected));
          setMarketStrategyConfig(market, strategyId, {
            ...latestConfig,
            tickers: remaining,
          });
          console.log(`[RealtimeDdsobV2:${tag}] Removed timed-out autoSelected ticker ${ticker} from config (${latestTickers.length} → ${remaining.length})`);
        }
        if (chatId) {
          await sendTelegramMessage(chatId,
            `⏰ <b>첫 매수 타임아웃</b> [${tickerConfig.stockName || ticker}]\n\n` +
            `${newCandlesBeforeFirstBuy}캔들(${newCandlesBeforeFirstBuy * intervalMinutes}분) 동안 매수 미발생\n` +
            `종목 제외 → 새 종목 재선정`,
            'HTML'
          );
        }
        return;
      }
    }

    const holdUpdate: Record<string, unknown> = {
      previousPrice: currentPrice,
      candlesSinceCycleStart: ((state.candlesSinceCycleStart as number) || 0) + (buyRecords.length > 0 ? 1 : 0),
      lastCheckedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    if (isFirstBuy && tickerConfig.autoSelected) {
      holdUpdate.candlesBeforeFirstBuy = ((state.candlesBeforeFirstBuy as number) || 0) + 1;
    }
    if (state.indicators) {
      holdUpdate.indicators = state.indicators;
    }
    const holdPeakCandles = tickerConfig.peakCheckCandles ?? 10;
    if (holdPeakCandles > 0) {
      const holdRecentPrices = [...((state.recentPrices as number[]) || []), currentPrice];
      if (holdRecentPrices.length > holdPeakCandles) {
        holdRecentPrices.splice(0, holdRecentPrices.length - holdPeakCandles);
      }
      holdUpdate.recentPrices = holdRecentPrices;
    }
    store.updateState('realtimeDdsobV2State', ticker, holdUpdate);
    return;
  }

  // ======== 국내주식 상한가/하한가 검증 & 가격 클램핑 ========
  if (market === 'domestic' && (domesticUpperLimit <= 0 || domesticLowerLimit <= 0)) {
    console.warn(`[RealtimeDdsobV2:${tag}] Missing price limits for ${ticker} (upper=${domesticUpperLimit}, lower=${domesticLowerLimit}), skipping order submission`);
    const limitUpdate: Record<string, unknown> = {
      previousPrice: currentPrice,
      lastCheckedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    if (state.indicators) {
      limitUpdate.indicators = state.indicators;
    }
    store.updateState('realtimeDdsobV2State', ticker, limitUpdate);
    return;
  }
  if (market === 'domestic' && domesticUpperLimit > 0 && domesticLowerLimit > 0) {
    for (const order of calcResult.buyOrders) {
      if (order.price > domesticUpperLimit) {
        console.log(`[RealtimeDdsobV2:${tag}] Buy price ${order.price} clamped to upper limit ${domesticUpperLimit}`);
        order.price = domesticUpperLimit;
        order.amount = order.price * order.quantity;
      }
    }
    for (const order of calcResult.sellOrders) {
      if (order.price < domesticLowerLimit) {
        console.log(`[RealtimeDdsobV2:${tag}] Sell price ${order.price} clamped to lower limit ${domesticLowerLimit}`);
        order.price = domesticLowerLimit;
        order.amount = order.price * order.quantity;
      }
      if (order.price > domesticUpperLimit) {
        console.log(`[RealtimeDdsobV2:${tag}] Sell price ${order.price} clamped to upper limit ${domesticUpperLimit}`);
        order.price = domesticUpperLimit;
        order.amount = order.price * order.quantity;
      }
    }
  }

  // ======== 3~5단계: 주문 제출 (마켓별 분기) ========
  const orderNumbers: string[] = [];
  const sellInfo: Array<{ orderNo: string; quantity: number; targetPrice: number }> = [];
  let failedOrderCount = 0;

  // 매도 주문
  for (const sellOrder of calcResult.sellOrders) {
    try {
      await new Promise(resolve => setTimeout(resolve, 300));
      let result;

      if (market === 'overseas') {
        result = await kisClient.submitOrder(
          credentials.appKey, credentials.appSecret, accessToken, credentials.accountNo,
          { ticker, side: 'SELL', orderType: 'LIMIT', price: sellOrder.price, quantity: sellOrder.quantity, exchange: orderExcd }
        );
      } else {
        result = await kisClient.submitDomesticOrder(
          credentials.appKey, credentials.appSecret, accessToken, credentials.accountNo,
          { ticker, side: 'SELL', orderType: 'LIMIT', price: sellOrder.price, quantity: sellOrder.quantity }
        );
      }

      if (result.rt_cd === '0' && result.output?.ODNO) {
        orderNumbers.push(result.output.ODNO);
        sellInfo.push({
          orderNo: result.output.ODNO,
          quantity: sellOrder.quantity,
          targetPrice: sellOrder.price,
        });
        console.log(`[RealtimeDdsobV2:${tag}] Sell submitted: ODNO=${result.output.ODNO}, ${sellOrder.quantity}주 @ ${fp(sellOrder.price)}`);
      } else {
        console.error(`[RealtimeDdsobV2:${tag}] Sell failed: ${result.msg1} | accountId=${accountId} accountNo=${credentials.accountNo} appKey=${credentials.appKey?.slice(0, 8)}...`);
        failedOrderCount++;
      }
    } catch (err) {
      if (isTokenExpiredError(err)) {
        console.log(`[RealtimeDdsobV2:${tag}] Token expired at sell order, refreshing and retrying...`);
        try {
          accessToken = await getOrRefreshToken('', ctx?.accountId ?? accountId, credentials, kisClient, true);
          await new Promise(resolve => setTimeout(resolve, 300));
          const retryResult = market === 'overseas'
            ? await kisClient.submitOrder(credentials.appKey, credentials.appSecret, accessToken, credentials.accountNo,
                { ticker, side: 'SELL', orderType: 'LIMIT', price: sellOrder.price, quantity: sellOrder.quantity, exchange: orderExcd })
            : await kisClient.submitDomesticOrder(credentials.appKey, credentials.appSecret, accessToken, credentials.accountNo,
                { ticker, side: 'SELL', orderType: 'LIMIT', price: sellOrder.price, quantity: sellOrder.quantity });
          if (retryResult.rt_cd === '0' && retryResult.output?.ODNO) {
            orderNumbers.push(retryResult.output.ODNO);
            sellInfo.push({ orderNo: retryResult.output.ODNO, quantity: sellOrder.quantity, targetPrice: sellOrder.price });
            console.log(`[RealtimeDdsobV2:${tag}] Sell submitted (after token refresh): ODNO=${retryResult.output.ODNO}`);
          } else {
            console.error(`[RealtimeDdsobV2:${tag}] Sell retry failed: ${retryResult.msg1}`);
            failedOrderCount++;
          }
        } catch (retryErr) {
          console.error(`[RealtimeDdsobV2:${tag}] Sell retry error:`, retryErr);
          failedOrderCount++;
        }
      } else {
        console.error(`[RealtimeDdsobV2:${tag}] Sell error:`, err);
        failedOrderCount++;
      }
    }
  }

  // ======== sell-only 모드: 매수 전체 스킵 ========
  if (sellOnly && calcResult.buyOrders.length > 0) {
    console.log(`[RealtimeDdsobV2:${tag}] [SELL-ONLY] Skipping ${calcResult.buyOrders.length} buy order(s) for ${ticker}`);
  }

  const buyCutoff = sellOnly;

  // ======== RSI 선조회 (매수 주문 전) ========
  let pendingRsiData: RSIResult | null = null;
  if (calcResult.buyOrders.length > 0 && !buyCutoff && !tickerConfig.autoSelected) {
    try {
      pendingRsiData = await fetchRSIAtBuyTime(
        kisClient, credentials.appKey, credentials.appSecret,
        accessToken, ticker, market, tag
      );
      console.log(`[RealtimeDdsobV2:${tag}] RSI pre-check: 5m=${pendingRsiData.rsi5m}, 15m=${pendingRsiData.rsi15m} (5m=${pendingRsiData.rsi5mBars}bars, 15m=${pendingRsiData.rsi15mBars}bars)`);
    } catch (err) {
      console.error(`[RealtimeDdsobV2:${tag}] RSI pre-check failed (non-blocking):`, err);
    }
  }

  // ======== RSI 매수 필터 (임시 비활성화) ========
  const rsiBlocked = false;

  const forceFirstBuy = !sellOnly && isFirstBuy && tickerConfig.autoSelected === true;
  if (forceFirstBuy && rsiBlocked) {
    console.log(`[RealtimeDdsobV2:${tag}] Force first buy: ${ticker} skipping RSI filter (rsiBlocked=${rsiBlocked})`);
  }

  // 매수 주문
  for (const buyOrder of (buyCutoff || (!forceFirstBuy && rsiBlocked) ? [] : calcResult.buyOrders)) {
    try {
      await new Promise(resolve => setTimeout(resolve, 300));
      let result;

      if (market === 'overseas') {
        result = await kisClient.submitOrder(
          credentials.appKey, credentials.appSecret, accessToken, credentials.accountNo,
          { ticker, side: 'BUY', orderType: 'LIMIT', price: buyOrder.price, quantity: buyOrder.quantity, exchange: orderExcd }
        );
      } else {
        result = await kisClient.submitDomesticOrder(
          credentials.appKey, credentials.appSecret, accessToken, credentials.accountNo,
          { ticker, side: 'BUY', orderType: 'LIMIT', price: buyOrder.price, quantity: buyOrder.quantity }
        );
      }

      if (result.rt_cd === '0' && result.output?.ODNO) {
        orderNumbers.push(result.output.ODNO);
        console.log(`[RealtimeDdsobV2:${tag}] Buy submitted: ODNO=${result.output.ODNO}, ${buyOrder.quantity}주 @ ${fp(buyOrder.price)}`);
      } else {
        console.error(`[RealtimeDdsobV2:${tag}] Buy failed: ${result.msg1} | accountId=${accountId} accountNo=${credentials.accountNo} appKey=${credentials.appKey?.slice(0, 8)}...`);
        failedOrderCount++;
      }
    } catch (err) {
      if (isTokenExpiredError(err)) {
        console.log(`[RealtimeDdsobV2:${tag}] Token expired at buy order, refreshing and retrying...`);
        try {
          accessToken = await getOrRefreshToken('', ctx?.accountId ?? accountId, credentials, kisClient, true);
          await new Promise(resolve => setTimeout(resolve, 300));
          const retryResult = market === 'overseas'
            ? await kisClient.submitOrder(credentials.appKey, credentials.appSecret, accessToken, credentials.accountNo,
                { ticker, side: 'BUY', orderType: 'LIMIT', price: buyOrder.price, quantity: buyOrder.quantity, exchange: orderExcd })
            : await kisClient.submitDomesticOrder(credentials.appKey, credentials.appSecret, accessToken, credentials.accountNo,
                { ticker, side: 'BUY', orderType: 'LIMIT', price: buyOrder.price, quantity: buyOrder.quantity });
          if (retryResult.rt_cd === '0' && retryResult.output?.ODNO) {
            orderNumbers.push(retryResult.output.ODNO);
            console.log(`[RealtimeDdsobV2:${tag}] Buy submitted (after token refresh): ODNO=${retryResult.output.ODNO}`);
          } else {
            console.error(`[RealtimeDdsobV2:${tag}] Buy retry failed: ${retryResult.msg1}`);
            failedOrderCount++;
          }
        } catch (retryErr) {
          console.error(`[RealtimeDdsobV2:${tag}] Buy retry error:`, retryErr);
          failedOrderCount++;
        }
      } else {
        console.error(`[RealtimeDdsobV2:${tag}] Buy error:`, err);
        failedOrderCount++;
      }
    }
  }

  if (failedOrderCount > 0) {
    console.warn(`[RealtimeDdsobV2:${tag}] ${failedOrderCount} order(s) failed out of ${calcResult.sellOrders.length + calcResult.buyOrders.length} total for ${ticker}`);
  }

  // ======== 6단계: 상태 갱신 ========
  const updateData: Record<string, unknown> = {
    previousPrice: currentPrice,
    lastCheckedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    lastOrderNumbers: orderNumbers,
    lastSellInfo: sellInfo,
    lastOrderDate: orderNumbers.length > 0 ? todayStr : '',
  };

  if (pendingRsiData) {
    updateData.pendingRsiData = pendingRsiData;
  }

  if (state.indicators) {
    updateData.indicators = state.indicators;
  }

  // recentPrices 갱신
  const peakCandles = tickerConfig.peakCheckCandles ?? 10;
  if (peakCandles > 0) {
    const updatedRecentPrices = [...((state.recentPrices as number[]) || []), currentPrice];
    if (updatedRecentPrices.length > peakCandles) {
      updatedRecentPrices.splice(0, updatedRecentPrices.length - peakCandles);
    }
    updateData.recentPrices = updatedRecentPrices;
  }

  // 사이클 시작 후 경과 캔들
  if (buyRecords.length > 0) {
    updateData.candlesSinceCycleStart = ((state.candlesSinceCycleStart as number) || 0) + 1;
  }

  // ======== 첫 매수 타임아웃: 매수 주문 미제출 시 ========
  if (buyRecords.length === 0 && orderNumbers.length === 0 && tickerConfig.autoSelected) {
    const newCandlesBeforeFirstBuy = ((state.candlesBeforeFirstBuy as number) || 0) + 1;
    if (newCandlesBeforeFirstBuy >= FIRST_BUY_TIMEOUT_CANDLES) {
      console.log(`[RealtimeDdsobV2:${tag}] First buy timeout: ${ticker} no buy in ${newCandlesBeforeFirstBuy} candles (${newCandlesBeforeFirstBuy * intervalMinutes}min) → removing`);
      store.deleteState('realtimeDdsobV2State', ticker);
      const latestConfig = getMarketStrategyConfig<RealtimeDdsobV2Config>(market, strategyId);
      if (latestConfig) {
        const latestTickers = extractTickerConfigsV2(latestConfig as unknown as Record<string, unknown>);
        const remaining = latestTickers.filter(t => !(t.ticker === ticker && t.autoSelected));
        setMarketStrategyConfig(market, strategyId, {
          ...latestConfig,
          tickers: remaining,
        });
        console.log(`[RealtimeDdsobV2:${tag}] Removed timed-out autoSelected ticker ${ticker} from config (${latestTickers.length} → ${remaining.length})`);
      }
      if (chatId) {
        await sendTelegramMessage(chatId,
          `⏰ <b>첫 매수 타임아웃</b> [${tickerConfig.stockName || ticker}]\n\n` +
          `${newCandlesBeforeFirstBuy}캔들(${newCandlesBeforeFirstBuy * intervalMinutes}분) 동안 매수 미발생\n` +
          `종목 제외 → 새 종목 재선정`,
          'HTML'
        );
      }
      return;
    }
    updateData.candlesBeforeFirstBuy = newCandlesBeforeFirstBuy;
  }

  try {
    store.updateState('realtimeDdsobV2State', ticker, updateData);
  } catch (stateErr) {
    console.error(`[RealtimeDdsobV2:${tag}] State update failed, retrying critical fields:`, stateErr);
    try {
      store.updateState('realtimeDdsobV2State', ticker, {
        lastOrderNumbers: orderNumbers,
        lastSellInfo: sellInfo,
        lastOrderDate: orderNumbers.length > 0 ? todayStr : '',
        lastCheckedAt: new Date().toISOString(),
      });
    } catch (retryErr) {
      console.error(`[RealtimeDdsobV2:${tag}] CRITICAL: Failed to save order numbers! Orders submitted but not tracked:`, orderNumbers, retryErr);
    }
  }

  // 분할소진 후 가격 하드스탑 (조건A)
  if (buyRecords.length > 0) {
    const totalBuyCost = buyRecords.reduce((sum, r) => sum + r.buyAmount, 0);
    const totalQty = buyRecords.reduce((sum, r) => sum + r.quantity, 0);
    const avgBuyPrice = totalBuyCost / totalQty;
    const exhaustionEnabled = tickerConfig.exhaustionStopLoss ?? false;
    if (exhaustionEnabled && buyRecords.length >= splitCount) {
      const multiplier = tickerConfig.stopLossMultiplier ?? 3;
      const hardStopPrice = avgBuyPrice * (1 - profitPercent * multiplier);

      if (currentPrice <= hardStopPrice) {
        const lossPercent = ((currentPrice - avgBuyPrice) / avgBuyPrice * 100).toFixed(2);
        console.log(`[RealtimeDdsobV2:${tag}] Exhaustion hard stop: ${ticker} price ${fp(currentPrice)} <= ${fp(hardStopPrice)} (avg=${fp(avgBuyPrice)}, TP=${profitPercent * 100}%, mult=${multiplier})`);
        const result = await forceStopRealtimeDdsobV2Ticker(ticker, market, 'exhaustion_stop_loss', strategyId);

        if (chatId) {
          await sendTelegramMessage(chatId,
            `🛑 <b>분할소진 손절</b> [${tickerConfig.stockName || ticker}]\n\n` +
            `현재가: ${fp(currentPrice)} (평단: ${fp(avgBuyPrice)})\n` +
            `손실률: ${lossPercent}% (한도: -${(profitPercent * multiplier * 100).toFixed(1)}%)\n` +
            `분할: ${buyRecords.length}/${splitCount} 소진\n` +
            `${result.success ? result.message : `실패: ${result.message}`}`
          );
        }
        return;
      }
    }

    // 강제매도 캔들
    if (forceSellCandles > 0 && !isFirstBuy) {
      const candles = (state.candlesSinceCycleStart as number) || 0;
      if (candles >= forceSellCandles) {
        console.log(`[RealtimeDdsobV2:${tag}] Force sell candles: ${ticker} ${candles} candles >= ${forceSellCandles} → full liquidation`);
        const result = await forceStopRealtimeDdsobV2Ticker(ticker, market, 'force_sell_candles', strategyId);

        if (chatId) {
          await sendTelegramMessage(chatId,
            `⏰ <b>강제매도 (캔들)</b> [${tickerConfig.stockName || ticker}]\n\n` +
            `${candles}캔들(${candles * intervalMinutes}분) 경과 → 전량 매도\n` +
            `${result.success ? result.message : `실패: ${result.message}`}`,
            'HTML'
          );
        }
        return;
      }
    }
  }
}
