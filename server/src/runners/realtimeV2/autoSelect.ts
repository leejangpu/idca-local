/**
 * 실사오팔v2 인기종목 자동선별 모듈
 * Firebase 의존성 제거 → localStore + config 기반
 */

import { config } from '../../config';
import * as localStore from '../../lib/localStore';
import { KisApiClient, getOrRefreshToken, isTokenExpiredError } from '../../lib/kisApi';
import { AccountContext } from '../../lib/accountContext';
import {
  getCommonConfig,
  getMarketStrategyConfig,
  setMarketStrategyConfig,
  isMarketStrategyActive,
  type AccountStrategy,
  type MarketType,
} from '../../lib/configHelper';
import { sendTelegramMessage, getUserTelegramChatId } from '../../lib/telegram';
import { getOccupiedTickersExcluding } from '../../lib/activeTickerRegistry';
import { getAscendingMaxPrice } from '../../lib/realtimeDdsobV2Calculator';
import {
  getKRMarketHolidayName,
  getKSTDateString,
} from '../../lib/marketUtils';
import { getUSMarketHolidayName } from '../../lib/usMarketHolidays';
import { calculateEMA, calculateRSI } from '../../lib/rsiCalculator';
import {
  type RealtimeDdsobV2Config,
  type RealtimeDdsobV2_1Config,
  type RealtimeDdsobV2TickerConfig,
  type AutoSelectConfig,
  type AutoSelectConfigUS,
  extractTickerConfigsV2,
} from './types';

// ==================== 로컬 타입 정의 ====================

interface ConditionItem {
  seq: string;
  groupName: string;
  conditionName: string;
}

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

// ==================== 틱 필터 상수/타입/함수 ====================

const MAX_SPREAD_TICKS = 1;
const MAX_SPREAD_TICKS_RELAXED = 2;
const MIN_TP_TICKS_FOR_RELAXED = 6;
const MIN_TP_TICKS = 3;
const LIQUIDITY_MULTIPLIER = 10;
const UPPER_ROOM_BUFFER_BPS = 20;

function getDomesticTickSize(price: number): number {
  if (price < 2000) return 1;
  if (price < 5000) return 5;
  if (price < 20000) return 10;
  if (price < 50000) return 50;
  if (price < 200000) return 100;
  if (price < 500000) return 500;
  return 1000;
}

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

async function getDomesticOrderbookInfo(
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

function checkTickFilter(
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

function hasEnoughUpperRoom(currentPrice: number, upperLimit: number, profitPercent: number): boolean {
  if (upperLimit <= 0 || currentPrice <= 0) return true;
  const tpBps = profitPercent * 10000;
  const upperRoomBps = (upperLimit - currentPrice) / currentPrice * 10000;
  return upperRoomBps >= tpBps + UPPER_ROOM_BUFFER_BPS;
}

async function selectWithSpreadFilter(
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

// ==================== v2.1 지표 필터 ====================

async function applyIndicatorFiltersUS(
  candidates: Array<{ ticker: string; name: string; price: number; tamt: number; rate: number; excd: string }>,
  autoConfig: AutoSelectConfigV2_1,
  kisClient: KisApiClient,
  appKey: string,
  appSecret: string,
  accessToken: string,
  targetCount: number,
): Promise<typeof candidates> {
  const passed: typeof candidates = [];
  const ema20On = autoConfig.ema20Filter !== false;
  const ema5On = autoConfig.ema5Filter !== false;
  const disparityMin = autoConfig.ema20DisparityMin ?? 100;
  const disparityMax = autoConfig.ema20DisparityMax ?? 103;
  const rsiOn = autoConfig.rsiFilterEnabled !== false;
  const rsiMin = autoConfig.rsiMin ?? 40;
  const rsiMax = autoConfig.rsiMax ?? 65;
  const nmin = autoConfig.indicatorTimeframe ?? 5;

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

      const ema20 = calculateEMA(closes, 20);
      if (ema20 === null) continue;
      if (ema20On && currentPrice <= ema20) {
        console.log(`[V2.1:IndicatorFilter:US] #${rank} ${c.ticker} ($${c.price}, ${c.rate.toFixed(1)}%): 현재가 ≤ EMA20 → SKIP`);
        continue;
      }

      const disparity = (currentPrice / ema20) * 100;
      if (disparity < disparityMin || disparity > disparityMax) {
        console.log(`[V2.1:IndicatorFilter:US] #${rank} ${c.ticker} ($${c.price}, ${c.rate.toFixed(1)}%): 이격도${disparity.toFixed(1)}% → SKIP`);
        continue;
      }

      if (ema5On) {
        const ema5 = calculateEMA(closes, 5);
        if (ema5 === null || currentPrice <= ema5) {
          console.log(`[V2.1:IndicatorFilter:US] #${rank} ${c.ticker}: EMA5 미통과 → SKIP`);
          continue;
        }
      }

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

// ==================== 공개 API ====================

/**
 * HTS 조건검색 목록 조회
 * 원본: getConditionListV2 (HTTP endpoint) → 단일 사용자 plain function
 */
export async function getConditionList(htsUserId: string, ctx?: AccountContext): Promise<ConditionItem[]> {
  const { credentials, kisClient } = getCredentialsAndClient(ctx);
  const accessToken = await getOrRefreshToken(
    '', ctx?.accountId ?? config.accountId,
    credentials, kisClient
  );

  const listResp = await kisClient.getConditionSearchList(
    credentials.appKey, credentials.appSecret, accessToken, htsUserId
  );

  if (listResp.rt_cd !== '0' || !listResp.output2) {
    console.error(`[ConditionList] 실패 응답:`, JSON.stringify(listResp));
    throw new Error(`조건 목록 조회 실패: [${listResp.msg_cd}] ${listResp.msg1}`);
  }

  return listResp.output2.map(c => ({
    seq: c.seq,
    groupName: c.grp_nm,
    conditionName: c.condition_nm,
  }));
}

/**
 * 수동 자동선별 트리거 (웹에서 매매활성화 ON 시 호출)
 * 원본: triggerAutoSelectStocksV2 (HTTP) → plain function
 */
export async function triggerAutoSelectStocks(market: string, ctx?: AccountContext): Promise<{ success: boolean; message: string }> {
  const isUS = market === 'overseas';
  console.log(`[AutoSelect:Manual:${isUS ? 'US' : 'KR'}] Triggered`);

  const commonConfig = getCommonConfig();
  if (!commonConfig) {
    throw new Error('Trading config not found');
  }

  const targetMarket: MarketType = isUS ? 'overseas' : 'domestic';
  const isV2Active = isMarketStrategyActive(commonConfig, targetMarket, 'realtimeDdsobV2');
  const isV2_1Active = isMarketStrategyActive(commonConfig, targetMarket, 'realtimeDdsobV2_1');
  if (!isV2Active && !isV2_1Active) {
    throw new Error('realtimeDdsobV2/V2.1 전략이 아니거나 매매가 비활성화 상태입니다');
  }

  if (isUS && isV2_1Active) {
    const rdConfig = getMarketStrategyConfig<RealtimeDdsobV2_1Config & { autoSelectConfigUS?: AutoSelectConfigV2_1 }>(targetMarket, 'realtimeDdsobV2_1');
    if (!rdConfig?.autoSelectEnabledUS) {
      throw new Error('v2.1 해외 자동 종목선정이 비활성화 상태입니다');
    }
    const autoConfigV2_1 = rdConfig.autoSelectConfigUS;
    if (!autoConfigV2_1) {
      throw new Error('v2.1 해외 자동선별 설정이 없습니다');
    }
    if (autoConfigV2_1.principalMode === 'manual' && !autoConfigV2_1.principalPerTicker) {
      throw new Error('종목당 투자금이 설정되지 않았습니다');
    }
    await processAutoSelectStocksV2_1US(autoConfigV2_1, rdConfig as unknown as Record<string, unknown>, undefined, ctx);
    return { success: true, message: 'v2.1 해외 지표 자동선별이 완료되었습니다' };
  }

  const rdConfig = getMarketStrategyConfig<RealtimeDdsobV2Config>(targetMarket, 'realtimeDdsobV2');

  if (isUS) {
    if (!rdConfig?.autoSelectEnabled) {
      throw new Error('해외 자동 종목선정이 비활성화 상태입니다');
    }
    const autoConfigUS = rdConfig.autoSelectConfig as unknown as AutoSelectConfigUS;
    if (!autoConfigUS) {
      throw new Error('해외 자동선별 설정이 없습니다');
    }
    if (autoConfigUS.principalMode === 'manual' && !autoConfigUS.principalPerTicker) {
      throw new Error('종목당 투자금이 설정되지 않았습니다');
    }
    await processAutoSelectStocksUS(autoConfigUS, rdConfig as unknown as Record<string, unknown>, undefined, ctx);
    return { success: true, message: '해외 자동 종목선정이 완료되었습니다' };
  }

  // 국내 자동선별
  if (!rdConfig?.autoSelectEnabled) {
    throw new Error('자동 종목선정이 비활성화 상태입니다');
  }
  const autoConfig = rdConfig.autoSelectConfig as AutoSelectConfig;
  if (!autoConfig) {
    throw new Error('자동선별 설정이 없습니다');
  }
  if (autoConfig.principalMode === 'manual' && !autoConfig.principalPerTicker) {
    throw new Error('종목당 투자금이 설정되지 않았습니다');
  }
  await processAutoSelectStocks(autoConfig, rdConfig as unknown as Record<string, unknown>, undefined, ctx);
  return { success: true, message: '자동 종목선정이 완료되었습니다' };
}

/**
 * 인기종목 자동선별 스케줄러 (국내) — 09:20 KST
 * 원본: autoSelectTopStocksTriggerKRV2 (onSchedule)
 */
export async function runAutoSelectKR(ctx?: AccountContext): Promise<void> {
  console.log('[AutoSelect:KR] Trigger started');

  const now = new Date();
  const kstTime = new Date(now.getTime() + 9 * 60 * 60 * 1000);

  const holidayName = getKRMarketHolidayName(kstTime);
  if (holidayName) {
    console.log(`[AutoSelect] Holiday: ${holidayName}`);
    return;
  }

  try {
    const commonConfig = getCommonConfig();
    if (!commonConfig) return;
    if (!isMarketStrategyActive(commonConfig, 'domestic', 'realtimeDdsobV2')) return;

    const rdConfig = getMarketStrategyConfig<RealtimeDdsobV2Config>('domestic', 'realtimeDdsobV2');
    if (!rdConfig?.autoSelectEnabled) return;

    const autoConfig = rdConfig.autoSelectConfig as AutoSelectConfig;
    if (!autoConfig) return;
    if (autoConfig.principalMode === 'manual' && !autoConfig.principalPerTicker) return;

    await processAutoSelectStocks(autoConfig, rdConfig as unknown as Record<string, unknown>, undefined, ctx);

    console.log('[AutoSelect:KR] Trigger completed');
  } catch (error) {
    console.error('[AutoSelect:KR] Trigger error:', error);
  }
}

/**
 * 실사오팔v2 해외 인기종목 자동선별 스케줄러 — 09:35 ET
 * 원본: autoSelectTopStocksTriggerUSV2 (onSchedule)
 */
export async function runAutoSelectUS(ctx?: AccountContext): Promise<void> {
  console.log('[AutoSelect:US] Trigger started');

  // 휴장일 확인
  const now = new Date();
  const estOffset = -5;
  const edtOffset = -4;
  const year = now.getUTCFullYear();
  const marchSecondSunday = new Date(year, 2, 8 + (7 - new Date(year, 2, 1).getDay()) % 7);
  const novFirstSunday = new Date(year, 10, 1 + (7 - new Date(year, 10, 1).getDay()) % 7);
  const isDST = now >= marchSecondSunday && now < novFirstSunday;
  const offset = isDST ? edtOffset : estOffset;
  const usTime = new Date(now.getTime() + offset * 60 * 60 * 1000);
  const holidayName = getUSMarketHolidayName(usTime);
  if (holidayName) {
    console.log(`[AutoSelect:US] Holiday: ${holidayName}`);
    return;
  }

  try {
    const commonConfig = getCommonConfig();
    if (!commonConfig) return;

    const isV2 = isMarketStrategyActive(commonConfig, 'overseas', 'realtimeDdsobV2');
    const isV2_1 = isMarketStrategyActive(commonConfig, 'overseas', 'realtimeDdsobV2_1');
    if (!isV2 && !isV2_1) return;

    if (isV2_1) {
      const rdConfig = getMarketStrategyConfig<RealtimeDdsobV2_1Config & { autoSelectConfigUS?: AutoSelectConfigV2_1 }>('overseas', 'realtimeDdsobV2_1');
      if (!rdConfig?.autoSelectEnabledUS) return;
      const autoConfigV2_1 = rdConfig.autoSelectConfigUS;
      if (!autoConfigV2_1) return;
      if (autoConfigV2_1.principalMode === 'manual' && !autoConfigV2_1.principalPerTicker) return;
      await processAutoSelectStocksV2_1US(autoConfigV2_1, rdConfig as unknown as Record<string, unknown>, undefined, ctx);
    } else {
      const rdConfig = getMarketStrategyConfig<RealtimeDdsobV2Config>('overseas', 'realtimeDdsobV2');
      if (!rdConfig?.autoSelectEnabled) return;
      const autoConfigUS = rdConfig.autoSelectConfig as unknown as AutoSelectConfigUS;
      if (!autoConfigUS) return;
      if (autoConfigUS.principalMode === 'manual' && !autoConfigUS.principalPerTicker) return;
      await processAutoSelectStocksUS(autoConfigUS, rdConfig as unknown as Record<string, unknown>, undefined, ctx);
    }

    console.log('[AutoSelect:US] Trigger completed');
  } catch (error) {
    console.error('[AutoSelect:US] Trigger error:', error);
  }
}

// ==================== 자동선별 종목 처리 (국내) ====================

export async function processAutoSelectStocks(
  autoConfig: AutoSelectConfig,
  rdConfig: Record<string, unknown>,
  options?: { mode?: 'full' | 'refill' },
  ctx?: AccountContext,
): Promise<RealtimeDdsobV2TickerConfig[]> {
  const store = ctx?.store ?? localStore;
  const mode = options?.mode || 'full';
  const { stockCount, splitCount, selectionMode, maxStockPrice, principalMode } = autoConfig;
  const includeETF = autoConfig.includeETF !== false;

  const ETF_KEYWORDS = ['KODEX', 'TIGER', 'KBSTAR', 'ARIRANG', 'HANARO', 'SOL', 'KOSEF', 'ACE', 'PLUS'];
  const isETF = (name: string) => ETF_KEYWORDS.some(kw => name.toUpperCase().includes(kw));

  console.log(`[AutoSelect] Processing: mode=${selectionMode}, count=${stockCount}, principalMode=${principalMode}, includeETF=${includeETF}`);

  // 자격증명 & 토큰
  const { credentials, kisClient } = getCredentialsAndClient(ctx);
  let accessToken = await getOrRefreshToken('', ctx?.accountId ?? config.accountId, credentials, kisClient);

  // 기존 종목 확인 (중복 방지 + 빈 슬롯 계산)
  const existingTickers = extractTickerConfigsV2(rdConfig);
  const manualTickers = new Set(existingTickers.filter(t => !t.autoSelected).map(t => t.ticker));
  const existingAutoTickers = existingTickers.filter(t => t.autoSelected && t.market === 'domestic');
  const excludeTickers = new Set([...Array.from(manualTickers), ...(mode === 'refill' ? existingAutoTickers.map(t => t.ticker) : [])]);
  // 다른 전략이 점유 중인 종목 제외
  for (const t of getOccupiedTickersExcluding('domestic', 'realtimeDdsobV2')) excludeTickers.add(t);
  const slotsToFill = mode === 'refill' ? stockCount - existingAutoTickers.length : stockCount;

  if (slotsToFill <= 0) {
    console.log(`[AutoSelect] No empty slots to fill (mode=${mode}, existing=${existingAutoTickers.length}, target=${stockCount})`);
    return [];
  }

  console.log(`[AutoSelect] mode=${mode}, slotsToFill=${slotsToFill}, excludeTickers=${Array.from(excludeTickers).join(',')}`);

  // 투자원금 결정
  let principalPerTicker: number;

  let balanceResp;
  try {
    balanceResp = await kisClient.getDomesticBalance(
      credentials.appKey, credentials.appSecret, accessToken, credentials.accountNo
    );
  } catch (err) {
    if (isTokenExpiredError(err)) {
      console.log(`[AutoSelect] Token expired, refreshing and retrying...`);
      accessToken = await getOrRefreshToken('', ctx?.accountId ?? config.accountId, credentials, kisClient, true);
      balanceResp = await kisClient.getDomesticBalance(
        credentials.appKey, credentials.appSecret, accessToken, credentials.accountNo
      );
    } else {
      throw err;
    }
  }
  const availableCash = balanceResp.output2?.[0]?.dnca_tot_amt
    ? parseInt(balanceResp.output2[0].dnca_tot_amt)
    : 0;
  if (availableCash <= 0) {
    console.log(`[AutoSelect] No available cash`);
    return [];
  }

  // 수동 종목 원금 합산 (국내주식만)
  const manualPrincipalSum = existingTickers
    .filter(t => !t.autoSelected && t.market !== 'overseas')
    .reduce((sum, t) => sum + (t.principal || 0), 0);

  // refill 모드: 진행중인 auto 종목의 남은 현금 계산
  let activeAutoCashReserved = 0;
  if (mode === 'refill' && existingAutoTickers.length > 0) {
    for (const t of existingAutoTickers) {
      const state = store.getState<Record<string, unknown>>('realtimeDdsobV2State', t.ticker);
      if (state) {
        const reserved = ((state.principal as number) || 0) - ((state.totalBuyAmount as number) || 0) + ((state.totalSellAmount as number) || 0);
        activeAutoCashReserved += Math.max(0, reserved);
      } else {
        activeAutoCashReserved += t.principal || 0;
      }
    }
  }

  const cashForNewSlots = availableCash - manualPrincipalSum - activeAutoCashReserved;
  if (cashForNewSlots <= 0) {
    console.log(`[AutoSelect] No cash for new slots (cash=${availableCash}, manual=${manualPrincipalSum}, activeReserved=${activeAutoCashReserved})`);
    return [];
  }

  const divisor = mode === 'refill' ? slotsToFill : stockCount;
  const maxPrincipalPerSlot = Math.floor(cashForNewSlots / divisor);

  if (principalMode === 'auto') {
    principalPerTicker = maxPrincipalPerSlot;
    console.log(`[AutoSelect] Auto principal: cash=${availableCash}, manual=${manualPrincipalSum}, activeReserved=${activeAutoCashReserved}, divisor=${divisor}(${mode}), perTicker=${principalPerTicker}`);
  } else {
    principalPerTicker = Math.min(autoConfig.principalPerTicker, maxPrincipalPerSlot);
    console.log(`[AutoSelect] Manual principal: configured=${autoConfig.principalPerTicker}, maxPerSlot=${maxPrincipalPerSlot}, perTicker=${principalPerTicker}`);
  }
  await new Promise(resolve => setTimeout(resolve, 300));

  if (principalPerTicker <= 0) {
    console.log(`[AutoSelect] principalPerTicker is 0`);
    return [];
  }

  const amountPerRound = principalPerTicker / splitCount;
  const ascendingSplit = autoConfig.ascendingSplit === true;
  const defaultPriceLimit = ascendingSplit
    ? getAscendingMaxPrice(principalPerTicker, splitCount, 5)
    : amountPerRound;
  const priceLimit = maxStockPrice > 0 ? maxStockPrice : defaultPriceLimit;
  if (ascendingSplit) {
    console.log(`[AutoSelect] 점증분할 가격필터: ${Math.round(defaultPriceLimit)}원 (균등: ${Math.round(amountPerRound)}원)`);
  }

  // 종목 선별
  let selected: Array<{ ticker: string; name: string; price: number }> = [];

  if (selectionMode === 'sideways') {
    // === 횡보 종목 조건검색 ===
    const { htsUserId, conditionName } = autoConfig;

    if (!htsUserId || !conditionName) {
      console.log(`[AutoSelect] sideways mode requires htsUserId and conditionName`);
      return [];
    }

    const listResp = await kisClient.getConditionSearchList(
      credentials.appKey, credentials.appSecret, accessToken, htsUserId
    );

    if (listResp.rt_cd !== '0' || !listResp.output2) {
      console.log(`[AutoSelect] Condition list failed: ${listResp.msg1}`);
      return [];
    }

    const matchedCondition = listResp.output2.find(c => c.condition_nm === conditionName);
    if (!matchedCondition) {
      const available = listResp.output2.map(c => c.condition_nm).join(', ');
      console.log(`[AutoSelect] Condition '${conditionName}' not found. Available: ${available}`);
      const chatId = await getUserTelegramChatId();
      if (chatId) {
        await sendTelegramMessage(chatId,
          `⚠️ <b>조건검색 실패</b>\n\n조건명 '${conditionName}'을 찾을 수 없습니다.\nHTS에서 조건명을 확인하세요.\n\n사용 가능: ${available || '(없음)'}`
        );
      }
      return [];
    }

    console.log(`[AutoSelect] Found condition '${conditionName}' with seq=${matchedCondition.seq}`);
    await new Promise(resolve => setTimeout(resolve, 300));

    const searchResp = await kisClient.getConditionSearchResult(
      credentials.appKey, credentials.appSecret, accessToken, htsUserId, matchedCondition.seq
    );

    if (searchResp.rt_cd === '1' && searchResp.msg_cd === 'MCA05918') {
      console.log(`[AutoSelect] Condition search returned 0 results`);
      if (mode === 'full') {
        const chatId = await getUserTelegramChatId();
        if (chatId) {
          await sendTelegramMessage(chatId,
            `ℹ️ <b>조건검색 결과 0건</b>\n\n조건 '${conditionName}'에 해당하는 종목이 없습니다.`
          );
        }
      }
      return [];
    }

    if (searchResp.rt_cd !== '0' || !searchResp.output2) {
      console.log(`[AutoSelect] Condition search failed: ${searchResp.msg1}`);
      return [];
    }

    console.log(`[AutoSelect] Condition search returned ${searchResp.output2.length} stocks`);

    const parsed = searchResp.output2
      .map(item => ({
        ticker: item.code,
        name: item.name.trim(),
        price: Math.round(parseFloat(item.price)),
      }))
      .filter(s => s.price > 0)
      .filter(s => s.price <= priceLimit)
      .filter(s => !excludeTickers.has(s.ticker))
      .filter(s => includeETF || !isETF(s.name));

    selected = await selectWithSpreadFilter(
      parsed, slotsToFill, autoConfig.profitPercent,
      kisClient, credentials.appKey, credentials.appSecret, accessToken, amountPerRound,
      autoConfig.spreadFilterEnabled === true
    );
    console.log(`[AutoSelect] Sideways: ${parsed.length} passed filters, selected ${selected.length} (spread+upper room)`);

  } else {
    // === 기존 모드: 거래량/시총 순위 ===
    const MIN_CHANGE_RATE = -2;
    let volumeStocks: Array<{ ticker: string; name: string; price: number; rank: number; changeRate: number; marketCap: number }> = [];
    let marketCapStocks: Array<{ ticker: string; name: string; price: number; rank: number; changeRate: number }> = [];

    if (selectionMode === 'marketCapOnly') {
      const mcResp = await kisClient.getDomesticMarketCapRanking(
        credentials.appKey, credentials.appSecret, accessToken
      );
      if (mcResp.rt_cd === '0' && mcResp.output) {
        marketCapStocks = mcResp.output.map(item => ({
          ticker: item.mksc_shrn_iscd,
          name: item.hts_kor_isnm,
          price: parseInt(item.stck_prpr),
          rank: parseInt(item.data_rank),
          changeRate: parseFloat(item.prdy_ctrt),
        }));
      }
      console.log(`[AutoSelect] MarketCap: ${marketCapStocks.length} stocks`);
      await new Promise(resolve => setTimeout(resolve, 300));
    }

    if (selectionMode === 'mixed' || selectionMode === 'volumeOnly') {
      const volResp = await kisClient.getDomesticVolumeRanking(
        credentials.appKey, credentials.appSecret, accessToken
      );
      if (volResp.rt_cd === '0' && volResp.output) {
        volumeStocks = volResp.output.map(item => ({
          ticker: item.mksc_shrn_iscd,
          name: item.hts_kor_isnm,
          price: parseInt(item.stck_prpr),
          rank: parseInt(item.data_rank),
          changeRate: parseFloat(item.prdy_ctrt),
          marketCap: parseInt(item.lstn_stcn) * parseInt(item.stck_prpr),
        }));
      }
      console.log(`[AutoSelect] Volume: ${volumeStocks.length} stocks`);
    }

    if (selectionMode === 'mixed') {
      const mixedCandidates = volumeStocks
        .filter(vs => vs.price <= priceLimit)
        .filter(vs => vs.changeRate >= MIN_CHANGE_RATE)
        .filter(vs => !excludeTickers.has(vs.ticker))
        .filter(vs => includeETF || !isETF(vs.name))
        .sort((a, b) => b.marketCap - a.marketCap);
      selected = await selectWithSpreadFilter(
        mixedCandidates, slotsToFill, autoConfig.profitPercent,
        kisClient, credentials.appKey, credentials.appSecret, accessToken, amountPerRound,
        autoConfig.spreadFilterEnabled === true
      );
    } else if (selectionMode === 'marketCapOnly') {
      const mcCandidates: typeof selected = [];
      for (const ms of marketCapStocks) {
        if (ms.price > priceLimit) continue;
        if (ms.changeRate < MIN_CHANGE_RATE) continue;
        if (excludeTickers.has(ms.ticker)) continue;
        if (!includeETF && isETF(ms.name)) continue;
        mcCandidates.push(ms);
      }
      selected = await selectWithSpreadFilter(
        mcCandidates, slotsToFill, autoConfig.profitPercent,
        kisClient, credentials.appKey, credentials.appSecret, accessToken, amountPerRound,
        autoConfig.spreadFilterEnabled === true
      );
    } else {
      const volCandidates: typeof selected = [];
      for (const vs of volumeStocks) {
        if (vs.price > priceLimit) continue;
        if (vs.changeRate < MIN_CHANGE_RATE) continue;
        if (excludeTickers.has(vs.ticker)) continue;
        if (!includeETF && isETF(vs.name)) continue;
        volCandidates.push(vs);
      }
      selected = await selectWithSpreadFilter(
        volCandidates, slotsToFill, autoConfig.profitPercent,
        kisClient, credentials.appKey, credentials.appSecret, accessToken, amountPerRound,
        autoConfig.spreadFilterEnabled === true
      );
    }
  }

  if (selected.length === 0) {
    console.log(`[AutoSelect] No stocks selected (all filtered by price limit ${priceLimit})`);
    return [];
  }

  // config 업데이트: full 모드는 국내 autoSelected만 교체
  const manualTickerConfigs = existingTickers.filter(t => !(t.autoSelected && t.market === 'domestic'));
  const newAutoTickers: RealtimeDdsobV2TickerConfig[] = selected.map(s => ({
    ticker: s.ticker,
    market: 'domestic' as MarketType,
    stockName: s.name,
    principal: principalPerTicker,
    splitCount: autoConfig.splitCount,
    profitPercent: autoConfig.profitPercent,
    forceSellCandles: autoConfig.forceSellCandles,
    intervalMinutes: autoConfig.intervalMinutes,
    autoSelected: true,
    autoStopLoss: autoConfig.autoStopLoss || false,
    stopLossPercent: autoConfig.stopLossPercent ?? -5,
    ...(autoConfig.exhaustionStopLoss !== undefined && { exhaustionStopLoss: autoConfig.exhaustionStopLoss }),
    ...(autoConfig.stopLossMultiplier !== undefined && { stopLossMultiplier: autoConfig.stopLossMultiplier }),
    ...(autoConfig.minDropPercent !== undefined && { minDropPercent: autoConfig.minDropPercent }),
    ...(autoConfig.peakCheckCandles !== undefined && { peakCheckCandles: autoConfig.peakCheckCandles }),
    selectionMode: autoConfig.selectionMode,
    ...(autoConfig.conditionName && { conditionName: autoConfig.conditionName }),
    ...(autoConfig.ascendingSplit && { ascendingSplit: true }),
  }));

  let updatedTickers = mode === 'refill'
    ? [...manualTickerConfigs, ...existingAutoTickers, ...newAutoTickers]
    : [...manualTickerConfigs, ...newAutoTickers];

  // 방어: 국내 autoSelected 종목 수가 stockCount를 초과하지 않도록
  const autoInUpdated = updatedTickers.filter(t => t.autoSelected && t.market === 'domestic');
  if (autoInUpdated.length > stockCount) {
    console.warn(`[AutoSelect] Auto count ${autoInUpdated.length} exceeds stockCount ${stockCount}, truncating`);
    const nonDomesticAuto = updatedTickers.filter(t => !(t.autoSelected && t.market === 'domestic'));
    updatedTickers = [...nonDomesticAuto, ...autoInUpdated.slice(0, stockCount)];
  }

  // 동시 실행 방어: write 직전 최신 config에서 국내 auto 수 재확인
  if (mode === 'refill') {
    const freshStrategyConfig = getMarketStrategyConfig<RealtimeDdsobV2Config>('domestic', 'realtimeDdsobV2');
    if (freshStrategyConfig) {
      const freshTickers = extractTickerConfigsV2(freshStrategyConfig as unknown as Record<string, unknown>);
      const freshAutoCount = freshTickers.filter(t => t.autoSelected && t.market === 'domestic').length;
      if (freshAutoCount >= stockCount) {
        console.log(`[AutoSelect] Concurrent refill detected: already ${freshAutoCount} auto stocks (target=${stockCount}), skipping write`);
        return [];
      }
    }
  }

  // config 저장
  const currentConfig = getMarketStrategyConfig<Record<string, unknown>>('domestic', 'realtimeDdsobV2') || {};
  setMarketStrategyConfig('domestic', 'realtimeDdsobV2', {
    ...currentConfig,
    tickers: updatedTickers,
  });

  const selectedNames = selected.map((s, i) => `${i + 1}. ${s.name}(${s.ticker}) ${s.price.toLocaleString()}원`).join('\n');
  console.log(`[AutoSelect] ${mode === 'refill' ? 'Refill' : 'Selected'} ${selected.length} stocks:\n${selectedNames}`);

  store.appendLog('realtimeV2AutoSelectLogs', getKSTDateString(), {
    mode: selectionMode,
    slotsToFill,
    selected: selected.length,
    excluded: Array.from(excludeTickers),
    result: selected.map(s => ({ ticker: s.ticker, name: s.name })),
    checkedAt: new Date().toISOString(),
  });

  return newAutoTickers;
}

// ==================== 해외 인기종목 자동선별 ====================

export async function processAutoSelectStocksUS(
  autoConfigUS: AutoSelectConfigUS,
  rdConfig: Record<string, unknown>,
  options?: { mode?: 'full' | 'refill' },
  ctx?: AccountContext,
): Promise<RealtimeDdsobV2TickerConfig[]> {
  const store = ctx?.store ?? localStore;
  const mode = options?.mode || 'full';
  const { stockCount, principalMode } = autoConfigUS;

  console.log(`[AutoSelect:US] Processing: mode=${mode}, count=${stockCount}, principalMode=${principalMode}`);

  // 자격증명 & 토큰
  const { credentials, kisClient } = getCredentialsAndClient(ctx);
  let accessToken = await getOrRefreshToken('', ctx?.accountId ?? config.accountId, credentials, kisClient);

  // 기존 종목 확인 (중복 방지)
  const existingTickers = extractTickerConfigsV2(rdConfig);
  const manualTickers = new Set(existingTickers.filter((t: RealtimeDdsobV2TickerConfig) => !t.autoSelected && t.market === 'overseas').map((t: RealtimeDdsobV2TickerConfig) => t.ticker));
  const existingAutoTickers = existingTickers.filter((t: RealtimeDdsobV2TickerConfig) => t.autoSelected && t.market === 'overseas');
  const excludeTickers = new Set([...Array.from(manualTickers), ...(mode === 'refill' ? existingAutoTickers.map(t => t.ticker) : [])]);
  for (const t of getOccupiedTickersExcluding('overseas', 'realtimeDdsobV2')) excludeTickers.add(t);

  const slotsToFill = mode === 'refill' ? stockCount - existingAutoTickers.length : stockCount;

  if (slotsToFill <= 0) {
    console.log(`[AutoSelect:US] No empty slots to fill (mode=${mode}, existing=${existingAutoTickers.length}, target=${stockCount})`);
    return [];
  }

  console.log(`[AutoSelect:US] mode=${mode}, slotsToFill=${slotsToFill}, excludeTickers=${Array.from(excludeTickers).join(',')}`);

  // 종목 선별: 해외주식 거래대금순위 API 기반
  const MIN_CHANGE_RATE = 0;
  const US_EXCHANGES = ['NAS', 'NYS', 'AMS'];
  let allStocks: Array<{ ticker: string; name: string; price: number; tamt: number; rate: number; excd: string }> = [];
  let tokenRefreshed = false;

  for (const excd of US_EXCHANGES) {
    try {
      const resp = await kisClient.getOverseasTradingAmountRanking(
        credentials.appKey, credentials.appSecret, accessToken, excd
      );
      if (resp.rt_cd === '0' && resp.output2) {
        const parsed = resp.output2
          .filter(item => item.e_ordyn === '1' || item.e_ordyn === 'Y' || item.e_ordyn === '○')
          .map(item => ({
            ticker: item.symb,
            name: item.name.trim() || item.ename.trim(),
            price: parseFloat(item.last),
            tamt: parseFloat(item.tamt),
            rate: parseFloat(item.rate),
            excd: item.excd || excd,
          }));
        allStocks.push(...parsed);
        console.log(`[AutoSelect:US] ${excd}: ${parsed.length} stocks from trading amount ranking`);
      } else {
        console.log(`[AutoSelect:US] ${excd} ranking failed: ${resp.msg1}`);
      }
    } catch (err) {
      if (!tokenRefreshed && isTokenExpiredError(err)) {
        console.log(`[AutoSelect:US] Token expired, refreshing and retrying...`);
        accessToken = await getOrRefreshToken('', ctx?.accountId ?? config.accountId, credentials, kisClient, true);
        tokenRefreshed = true;
        try {
          const retryResp = await kisClient.getOverseasTradingAmountRanking(
            credentials.appKey, credentials.appSecret, accessToken, excd
          );
          if (retryResp.rt_cd === '0' && retryResp.output2) {
            const parsed = retryResp.output2
              .filter(item => item.e_ordyn === '1' || item.e_ordyn === 'Y' || item.e_ordyn === '○')
              .map(item => ({
                ticker: item.symb,
                name: item.name.trim() || item.ename.trim(),
                price: parseFloat(item.last),
                tamt: parseFloat(item.tamt),
                rate: parseFloat(item.rate),
                excd: item.excd || excd,
              }));
            allStocks.push(...parsed);
            console.log(`[AutoSelect:US] ${excd}: ${parsed.length} stocks (after token refresh)`);
          }
        } catch (retryErr) {
          console.error(`[AutoSelect:US] ${excd} ranking error after token refresh:`, retryErr);
        }
      } else {
        console.error(`[AutoSelect:US] ${excd} ranking error:`, err);
      }
    }
    await new Promise(resolve => setTimeout(resolve, 300));
  }

  // 투자원금 결정
  let principalPerTicker: number;

  const firstExcd = 'NAS';
  let buyableResp;
  try {
    buyableResp = await kisClient.getBuyableAmount(
      credentials.appKey, credentials.appSecret, accessToken, credentials.accountNo,
      'AAPL', 1, firstExcd
    );
  } catch (err) {
    if (!tokenRefreshed && isTokenExpiredError(err)) {
      console.log(`[AutoSelect:US] Token expired at getBuyableAmount, refreshing and retrying...`);
      accessToken = await getOrRefreshToken('', ctx?.accountId ?? config.accountId, credentials, kisClient, true);
      tokenRefreshed = true;
      buyableResp = await kisClient.getBuyableAmount(
        credentials.appKey, credentials.appSecret, accessToken, credentials.accountNo,
        'AAPL', 1, firstExcd
      );
    } else {
      throw err;
    }
  }
  const availableCash = buyableResp.output?.ord_psbl_frcr_amt
    ? parseFloat(buyableResp.output.ord_psbl_frcr_amt)
    : 0;
  if (availableCash <= 0) {
    console.log(`[AutoSelect:US] No available USD cash`);
    return [];
  }

  const manualPrincipalSum = existingTickers
    .filter((t: RealtimeDdsobV2TickerConfig) => !t.autoSelected && t.market === 'overseas')
    .reduce((sum: number, t: RealtimeDdsobV2TickerConfig) => sum + (t.principal || 0), 0);

  // refill 모드: 진행중인 auto 종목의 남은 현금 계산
  let activeAutoCashReserved = 0;
  if (mode === 'refill' && existingAutoTickers.length > 0) {
    for (const t of existingAutoTickers) {
      const state = store.getState<Record<string, unknown>>('realtimeDdsobV2State', t.ticker);
      if (state) {
        const reserved = ((state.principal as number) || 0) - ((state.totalBuyAmount as number) || 0) + ((state.totalSellAmount as number) || 0);
        activeAutoCashReserved += Math.max(0, reserved);
      } else {
        activeAutoCashReserved += t.principal || 0;
      }
    }
  }

  const cashForNewSlots = availableCash - manualPrincipalSum - activeAutoCashReserved;
  if (cashForNewSlots <= 0) {
    console.log(`[AutoSelect:US] No cash for new slots (cash=${availableCash}, manual=${manualPrincipalSum}, activeReserved=${activeAutoCashReserved})`);
    return [];
  }

  const divisor = mode === 'refill' ? slotsToFill : stockCount;
  const maxPrincipalPerSlot = Math.floor(cashForNewSlots / divisor);

  if (principalMode === 'auto') {
    principalPerTicker = maxPrincipalPerSlot;
    console.log(`[AutoSelect:US] Auto principal: cash=${availableCash}, manual=${manualPrincipalSum}, activeReserved=${activeAutoCashReserved}, divisor=${divisor}(${mode}), perTicker=$${principalPerTicker}`);
  } else {
    principalPerTicker = Math.min(autoConfigUS.principalPerTicker, maxPrincipalPerSlot);
    console.log(`[AutoSelect:US] Manual principal: configured=$${autoConfigUS.principalPerTicker}, maxPerSlot=$${maxPrincipalPerSlot}, perTicker=$${principalPerTicker}`);
  }
  await new Promise(resolve => setTimeout(resolve, 300));

  if (principalPerTicker <= 0) {
    console.log(`[AutoSelect:US] principalPerTicker is 0`);
    return [];
  }

  const amountPerRound = principalPerTicker / autoConfigUS.splitCount;

  // 필터 + 정렬: 거래대금 내림차순
  const candidates = allStocks
    .filter(s => s.price > 0)
    .filter(s => s.price <= amountPerRound)
    .filter(s => s.rate >= MIN_CHANGE_RATE)
    .filter(s => !excludeTickers.has(s.ticker))
    .sort((a, b) => b.tamt - a.tamt);

  const selected = candidates.slice(0, slotsToFill);
  console.log(`[AutoSelect:US] ${allStocks.length} total → ${candidates.length} after filters → ${selected.length} selected`);

  if (selected.length === 0) {
    console.log(`[AutoSelect:US] No stocks selected`);
    return [];
  }

  // config 업데이트
  const manualTickerConfigs = existingTickers.filter((t: RealtimeDdsobV2TickerConfig) => !t.autoSelected || t.market !== 'overseas');
  const newAutoTickers: RealtimeDdsobV2TickerConfig[] = selected.map(s => ({
    ticker: s.ticker,
    market: 'overseas' as MarketType,
    stockName: s.name,
    principal: principalPerTicker,
    splitCount: autoConfigUS.splitCount,
    profitPercent: autoConfigUS.profitPercent,
    forceSellCandles: autoConfigUS.forceSellCandles,
    intervalMinutes: autoConfigUS.intervalMinutes,
    autoSelected: true,
    autoStopLoss: autoConfigUS.autoStopLoss ?? true,
    stopLossPercent: autoConfigUS.stopLossPercent ?? -5,
    exchangeCode: s.excd,
    ...(autoConfigUS.exhaustionStopLoss !== undefined && { exhaustionStopLoss: autoConfigUS.exhaustionStopLoss }),
    ...(autoConfigUS.stopLossMultiplier !== undefined && { stopLossMultiplier: autoConfigUS.stopLossMultiplier }),
    ...(autoConfigUS.minDropPercent !== undefined && { minDropPercent: autoConfigUS.minDropPercent }),
    ...(autoConfigUS.peakCheckCandles !== undefined && { peakCheckCandles: autoConfigUS.peakCheckCandles }),
    selectionMode: autoConfigUS.selectionMode || 'tradingAmount',
  }));

  let updatedTickers = mode === 'refill'
    ? [...manualTickerConfigs, ...existingAutoTickers, ...newAutoTickers]
    : [...manualTickerConfigs, ...newAutoTickers];

  // 방어: US autoSelected 종목 수가 stockCount를 초과하지 않도록
  const autoInUpdated = updatedTickers.filter(t => t.autoSelected && t.market === 'overseas');
  if (autoInUpdated.length > stockCount) {
    console.warn(`[AutoSelect:US] Auto count ${autoInUpdated.length} exceeds stockCount ${stockCount}, truncating`);
    const nonAutoUS = updatedTickers.filter(t => !(t.autoSelected && t.market === 'overseas'));
    updatedTickers = [...nonAutoUS, ...autoInUpdated.slice(0, stockCount)];
  }

  // 동시 실행 방어
  if (mode === 'refill') {
    const freshStrategyConfig = getMarketStrategyConfig<RealtimeDdsobV2Config>('overseas', 'realtimeDdsobV2');
    if (freshStrategyConfig) {
      const freshTickers = extractTickerConfigsV2(freshStrategyConfig as unknown as Record<string, unknown>);
      const freshAutoCount = freshTickers.filter(t => t.autoSelected && t.market === 'overseas').length;
      if (freshAutoCount >= stockCount) {
        console.log(`[AutoSelect:US] Concurrent refill detected: already ${freshAutoCount} US auto stocks (target=${stockCount}), skipping write`);
        return [];
      }
    }
  }

  // config 저장
  const currentConfig = getMarketStrategyConfig<Record<string, unknown>>('overseas', 'realtimeDdsobV2') || {};
  setMarketStrategyConfig('overseas', 'realtimeDdsobV2', {
    ...currentConfig,
    tickers: updatedTickers,
  });

  const selectedNames = selected.map((s, i) => `${i + 1}. ${s.name}(${s.ticker}) $${principalPerTicker}`).join('\n');
  console.log(`[AutoSelect:US] ${mode === 'refill' ? 'Refill' : 'Selected'} ${selected.length} stocks:\n${selectedNames}`);

  return newAutoTickers;
}

// ==================== v2.1 해외 인기종목 자동선별 ====================

export async function processAutoSelectStocksV2_1US(
  autoConfig: AutoSelectConfigV2_1,
  rdConfig: Record<string, unknown>,
  options?: { mode?: 'full' | 'refill' },
  ctx?: AccountContext,
): Promise<RealtimeDdsobV2TickerConfig[]> {
  const store = ctx?.store ?? localStore;
  const mode = options?.mode || 'full';
  const { stockCount, principalMode } = autoConfig;

  console.log(`[AutoSelect:V2.1:US] Processing: mode=${mode}, count=${stockCount}, principalMode=${principalMode}`);

  // 자격증명 & 토큰
  const { credentials, kisClient } = getCredentialsAndClient(ctx);
  let accessToken = await getOrRefreshToken('', ctx?.accountId ?? config.accountId, credentials, kisClient);

  // 기존 종목 확인 (중복 방지)
  const existingTickers = extractTickerConfigsV2(rdConfig);
  const manualTickers = new Set(existingTickers.filter((t: RealtimeDdsobV2TickerConfig) => !t.autoSelected && t.market === 'overseas').map((t: RealtimeDdsobV2TickerConfig) => t.ticker));
  const existingAutoTickers = existingTickers.filter((t: RealtimeDdsobV2TickerConfig) => t.autoSelected && t.market === 'overseas');
  const excludeTickers = new Set([...Array.from(manualTickers), ...(mode === 'refill' ? existingAutoTickers.map(t => t.ticker) : [])]);
  for (const t of getOccupiedTickersExcluding('overseas', 'realtimeDdsobV2_1')) excludeTickers.add(t);

  const slotsToFill = mode === 'refill' ? stockCount - existingAutoTickers.length : stockCount;
  if (slotsToFill <= 0) {
    console.log(`[AutoSelect:V2.1:US] No empty slots to fill`);
    return [];
  }

  console.log(`[AutoSelect:V2.1:US] mode=${mode}, slotsToFill=${slotsToFill}, excludeTickers=${Array.from(excludeTickers).join(',')}`);

  // 1단계: 거래대금 순위 조회 (NAS/NYS/AMS)
  const US_EXCHANGES = ['NAS', 'NYS', 'AMS'];
  let allStocks: Array<{ ticker: string; name: string; price: number; tamt: number; rate: number; excd: string }> = [];
  let tokenRefreshed = false;

  for (const excd of US_EXCHANGES) {
    try {
      const resp = await kisClient.getOverseasTradingAmountRanking(
        credentials.appKey, credentials.appSecret, accessToken, excd
      );
      if (resp.rt_cd === '0' && resp.output2) {
        const parsed = resp.output2
          .filter(item => item.e_ordyn === '1' || item.e_ordyn === 'Y' || item.e_ordyn === '○')
          .map(item => ({
            ticker: item.symb,
            name: item.name.trim() || item.ename.trim(),
            price: parseFloat(item.last),
            tamt: parseFloat(item.tamt),
            rate: parseFloat(item.rate),
            excd: item.excd || excd,
          }));
        allStocks.push(...parsed);
        console.log(`[AutoSelect:V2.1:US] ${excd}: ${parsed.length} stocks from trading amount ranking`);
      }
    } catch (err) {
      if (!tokenRefreshed && isTokenExpiredError(err)) {
        accessToken = await getOrRefreshToken('', ctx?.accountId ?? config.accountId, credentials, kisClient, true);
        tokenRefreshed = true;
        try {
          const retryResp = await kisClient.getOverseasTradingAmountRanking(
            credentials.appKey, credentials.appSecret, accessToken, excd
          );
          if (retryResp.rt_cd === '0' && retryResp.output2) {
            const parsed = retryResp.output2
              .filter(item => item.e_ordyn === '1' || item.e_ordyn === 'Y' || item.e_ordyn === '○')
              .map(item => ({
                ticker: item.symb,
                name: item.name.trim() || item.ename.trim(),
                price: parseFloat(item.last),
                tamt: parseFloat(item.tamt),
                rate: parseFloat(item.rate),
                excd: item.excd || excd,
              }));
            allStocks.push(...parsed);
          }
        } catch (retryErr) {
          console.error(`[AutoSelect:V2.1:US] ${excd} ranking error after token refresh:`, retryErr);
        }
      } else {
        console.error(`[AutoSelect:V2.1:US] ${excd} ranking error:`, err);
      }
    }
    await new Promise(resolve => setTimeout(resolve, 300));
  }

  // 투자원금 결정
  let principalPerTicker: number;
  const firstExcd = 'NAS';
  let buyableResp;
  try {
    buyableResp = await kisClient.getBuyableAmount(
      credentials.appKey, credentials.appSecret, accessToken, credentials.accountNo,
      'AAPL', 1, firstExcd
    );
  } catch (err) {
    if (!tokenRefreshed && isTokenExpiredError(err)) {
      accessToken = await getOrRefreshToken('', ctx?.accountId ?? config.accountId, credentials, kisClient, true);
      tokenRefreshed = true;
      buyableResp = await kisClient.getBuyableAmount(
        credentials.appKey, credentials.appSecret, accessToken, credentials.accountNo,
        'AAPL', 1, firstExcd
      );
    } else {
      throw err;
    }
  }
  const availableCash = buyableResp.output?.ord_psbl_frcr_amt
    ? parseFloat(buyableResp.output.ord_psbl_frcr_amt)
    : 0;
  if (availableCash <= 0) {
    console.log(`[AutoSelect:V2.1:US] No available USD cash`);
    return [];
  }

  const manualPrincipalSum = existingTickers
    .filter((t: RealtimeDdsobV2TickerConfig) => !t.autoSelected && t.market === 'overseas')
    .reduce((sum: number, t: RealtimeDdsobV2TickerConfig) => sum + (t.principal || 0), 0);

  let activeAutoCashReserved = 0;
  if (mode === 'refill' && existingAutoTickers.length > 0) {
    for (const t of existingAutoTickers) {
      const state = store.getState<Record<string, unknown>>('realtimeDdsobV2State', t.ticker);
      if (state) {
        const reserved = ((state.principal as number) || 0) - ((state.totalBuyAmount as number) || 0) + ((state.totalSellAmount as number) || 0);
        activeAutoCashReserved += Math.max(0, reserved);
      } else {
        activeAutoCashReserved += t.principal || 0;
      }
    }
  }

  const cashForNewSlots = availableCash - manualPrincipalSum - activeAutoCashReserved;
  if (cashForNewSlots <= 0) {
    console.log(`[AutoSelect:V2.1:US] No cash for new slots`);
    return [];
  }

  const divisor = mode === 'refill' ? slotsToFill : stockCount;
  const maxPrincipalPerSlot = Math.floor(cashForNewSlots / divisor);

  if (principalMode === 'auto') {
    principalPerTicker = maxPrincipalPerSlot;
  } else {
    principalPerTicker = Math.min(autoConfig.principalPerTicker, maxPrincipalPerSlot);
  }
  console.log(`[AutoSelect:V2.1:US] principal: $${principalPerTicker} (cash=$${availableCash}, mode=${principalMode})`);
  await new Promise(resolve => setTimeout(resolve, 300));

  if (principalPerTicker <= 0) {
    console.log(`[AutoSelect:V2.1:US] principalPerTicker is 0`);
    return [];
  }

  const amountPerRound = principalPerTicker / autoConfig.splitCount;
  const priceMin = autoConfig.priceMin ?? 5;
  const priceMax = autoConfig.priceMax ?? 1000;
  const changeRateMin = autoConfig.changeRateMin ?? 1;
  const changeRateMax = autoConfig.changeRateMax ?? 20;

  // 2단계: 가격/등락률 기본 필터
  const basicFiltered = allStocks
    .filter(s => s.price > 0)
    .filter(s => s.price <= amountPerRound)
    .filter(s => s.price >= priceMin && s.price <= priceMax)
    .filter(s => s.rate >= changeRateMin && s.rate <= changeRateMax)
    .filter(s => !excludeTickers.has(s.ticker))
    .sort((a, b) => b.tamt - a.tamt);

  console.log(`[AutoSelect:V2.1:US] ${allStocks.length} total → ${basicFiltered.length} after basic filters (price $${priceMin}~$${priceMax}, rate ${changeRateMin}~${changeRateMax}%)`);

  // 3단계: 지표 필터 (EMA/RSI)
  let selected: typeof basicFiltered;
  if (autoConfig.indicatorFilterEnabled !== false) {
    selected = await applyIndicatorFiltersUS(
      basicFiltered, autoConfig, kisClient,
      credentials.appKey, credentials.appSecret, accessToken,
      slotsToFill
    );
  } else {
    selected = basicFiltered.slice(0, slotsToFill);
  }

  if (selected.length === 0) {
    console.log(`[AutoSelect:V2.1:US] No stocks selected`);
    return [];
  }

  // config 업데이트
  const manualTickerConfigs = existingTickers.filter((t: RealtimeDdsobV2TickerConfig) => !t.autoSelected || t.market !== 'overseas');
  const newAutoTickers: RealtimeDdsobV2TickerConfig[] = selected.map(s => ({
    ticker: s.ticker,
    market: 'overseas' as MarketType,
    stockName: s.name,
    principal: principalPerTicker,
    splitCount: autoConfig.splitCount,
    profitPercent: autoConfig.profitPercent,
    forceSellCandles: autoConfig.forceSellCandles,
    intervalMinutes: autoConfig.intervalMinutes,
    autoSelected: true,
    autoStopLoss: autoConfig.autoStopLoss ?? true,
    stopLossPercent: autoConfig.stopLossPercent ?? -5,
    exchangeCode: s.excd,
    ...(autoConfig.exhaustionStopLoss !== undefined && { exhaustionStopLoss: autoConfig.exhaustionStopLoss }),
    ...(autoConfig.stopLossMultiplier !== undefined && { stopLossMultiplier: autoConfig.stopLossMultiplier }),
    ...(autoConfig.minDropPercent !== undefined && { minDropPercent: autoConfig.minDropPercent }),
    ...(autoConfig.peakCheckCandles !== undefined && { peakCheckCandles: autoConfig.peakCheckCandles }),
    ...(autoConfig.ascendingSplit !== undefined && { ascendingSplit: autoConfig.ascendingSplit }),
  }));

  let updatedTickers = mode === 'refill'
    ? [...manualTickerConfigs, ...existingAutoTickers, ...newAutoTickers]
    : [...manualTickerConfigs, ...newAutoTickers];

  // 방어: US autoSelected 종목 수가 stockCount를 초과하지 않도록
  const autoInUpdated = updatedTickers.filter(t => t.autoSelected && t.market === 'overseas');
  if (autoInUpdated.length > stockCount) {
    const nonAutoUS = updatedTickers.filter(t => !(t.autoSelected && t.market === 'overseas'));
    updatedTickers = [...nonAutoUS, ...autoInUpdated.slice(0, stockCount)];
  }

  // 동시 실행 방어
  if (mode === 'refill') {
    const freshConfig = getMarketStrategyConfig<RealtimeDdsobV2_1Config>('overseas', 'realtimeDdsobV2_1');
    if (freshConfig) {
      const freshTickers = extractTickerConfigsV2(freshConfig as unknown as Record<string, unknown>);
      const freshAutoCount = freshTickers.filter(t => t.autoSelected && t.market === 'overseas').length;
      if (freshAutoCount >= stockCount) {
        console.log(`[AutoSelect:V2.1:US] Concurrent refill detected, skipping write`);
        return [];
      }
    }
  }

  // config 저장
  const currentConfig = getMarketStrategyConfig<Record<string, unknown>>('overseas', 'realtimeDdsobV2_1') || {};
  setMarketStrategyConfig('overseas', 'realtimeDdsobV2_1', {
    ...currentConfig,
    tickers: updatedTickers,
  });

  const selectedNames = selected.map((s, i) => `${i + 1}. ${s.name}(${s.ticker}) $${principalPerTicker}`).join('\n');
  console.log(`[AutoSelect:V2.1:US] ${mode === 'refill' ? 'Refill' : 'Selected'} ${selected.length} stocks:\n${selectedNames}`);

  return newAutoTickers;
}

// ==================== 장마감 EOD 매도 처리 ====================

/**
 * 장마감 EOD 매도 처리 (autoSelected + forceLiquidateAtClose 통합)
 * 원본: processAutoSelectEOD
 */
export async function processAutoSelectEOD(
  eodTickers: RealtimeDdsobV2TickerConfig[],
  rdConfig: Record<string, unknown>,
  market: MarketType = 'domestic',
  strategyId: AccountStrategy = 'realtimeDdsobV2',
  ctx?: AccountContext,
): Promise<void> {
  const store = ctx?.store ?? localStore;
  const tag = market === 'domestic' ? 'KR' : 'US';
  console.log(`[EOD:${tag}] Processing: ${eodTickers.length} tickers`);

  const { credentials, kisClient } = getCredentialsAndClient(ctx);
  let accessToken = await getOrRefreshToken('', ctx?.accountId ?? config.accountId, credentials, kisClient);
  const chatId = await getUserTelegramChatId();
  const todayKST = getKSTDateString();
  const currencyUnit = market === 'domestic' ? '원' : '$';

  const eodResults: Array<{ ticker: string; name: string; soldQty: number; profit: number; isAutoSelected: boolean; pending?: boolean }> = [];
  let eodTokenRefreshed = false;

  // 해외 주문 날짜 (체결 내역 조회용)
  const todayET = market === 'overseas' ? (() => {
    const now = new Date();
    const year = now.getUTCFullYear();
    const marchSecondSunday = new Date(year, 2, 8 + (7 - new Date(year, 2, 1).getDay()) % 7);
    const novFirstSunday = new Date(year, 10, 1 + (7 - new Date(year, 10, 1).getDay()) % 7);
    const isDST = now >= marchSecondSunday && now < novFirstSunday;
    const usTime = new Date(now.getTime() + (isDST ? -4 : -5) * 60 * 60 * 1000);
    return `${usTime.getUTCFullYear()}${String(usTime.getUTCMonth() + 1).padStart(2, '0')}${String(usTime.getUTCDate()).padStart(2, '0')}`;
  })() : todayKST;

  for (let eodIdx = 0; eodIdx < eodTickers.length; eodIdx++) {
    const tc = eodTickers[eodIdx];
    const { ticker } = tc;
    const isAutoSelected = tc.autoSelected === true;

    const eodQuoteExcd = tc.exchangeCode;
    const eodOrderExcd = eodQuoteExcd ? KisApiClient.quoteToOrderExchangeCode(eodQuoteExcd) : KisApiClient.getExchangeCode(ticker);

    try {
      // 1. 상태 조회
      const state = store.getState<Record<string, unknown>>('realtimeDdsobV2State', ticker);
      if (!state) continue;

      const buyRecords = (state.buyRecords as Array<{ quantity: number; buyAmount: number }>) || [];
      if (buyRecords.length === 0) {
        store.deleteState('realtimeDdsobV2State', ticker);
        continue;
      }

      const totalQty = buyRecords.reduce((sum, br) => sum + br.quantity, 0);
      const totalBuyAmount = buyRecords.reduce((sum, br) => sum + br.buyAmount, 0);

      // 2. [해외] 이전 EOD 매도 체결 확인 (재시도 시)
      if (market === 'overseas' && state.eodSellPending && state.eodSellOrderNo) {
        const eodHistResp = await kisClient.getOrderHistory(
          credentials.appKey, credentials.appSecret, accessToken, credentials.accountNo,
          (state.eodSellDate as string) || todayET, todayET, ticker, '00', '01'
        );
        const eodFilled = (eodHistResp.output || []).find(
          (o: { odno: string; ft_ccld_qty: string }) => o.odno === state.eodSellOrderNo && parseInt(o.ft_ccld_qty) > 0
        );

        if (eodFilled) {
          const filledQty = parseInt(eodFilled.ft_ccld_qty);
          const filledPrice = parseFloat(eodFilled.ft_ccld_unpr3);
          const filledAmount = parseFloat(eodFilled.ft_ccld_amt3) || filledPrice * filledQty;
          const actualProfit = ((state.totalRealizedProfit as number) || 0) + (filledAmount - totalBuyAmount);

          console.log(`[EOD:${tag}] ${ticker} EOD sell confirmed: ${filledQty}주 @ $${filledPrice} (ODNO=${state.eodSellOrderNo})`);

          store.addCycleHistory({
            ticker, market, strategy: strategyId,
            stockName: tc.stockName || ticker,
            cycleNumber: (state.cycleNumber as number) || 1,
            autoSelected: isAutoSelected, dailyCycle: true,
            eodAction: isAutoSelected ? 'market_sell' : 'manual_eod_sell',
            startedAt: state.startedAt,
            completedAt: new Date().toISOString(),
            principal: tc.principal, splitCount: tc.splitCount, profitPercent: tc.profitPercent,
            amountPerRound: state.amountPerRound,
            forceSellCandles: tc.forceSellCandles, intervalMinutes: tc.intervalMinutes,
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
            totalSellAmount: ((state.totalSellAmount as number) || 0) + filledAmount,
            totalRealizedProfit: actualProfit,
            finalProfitRate: tc.principal > 0 ? actualProfit / tc.principal : 0,
            maxRoundsAtEnd: (state.maxRounds as number) || tc.splitCount,
            totalForceSellCount: (state.totalForceSellCount as number) || 0,
            totalForceSellLoss: (state.totalForceSellLoss as number) || 0,
            eodSoldQuantity: filledQty,
            candlesSinceCycleStart: (state.candlesSinceCycleStart as number) || 0,
          });

          eodResults.push({ ticker, name: tc.stockName || ticker, soldQty: filledQty, profit: actualProfit, isAutoSelected });
          store.deleteState('realtimeDdsobV2State', ticker);
          continue;
        }

        // 미체결 → 아래에서 취소 후 재시도
        console.log(`[EOD:${tag}] ${ticker} previous EOD sell not filled (ODNO=${state.eodSellOrderNo}), canceling and retrying...`);
      }

      // 3. 미체결 주문 취소
      if (market === 'overseas') {
        const pendingResp = await kisClient.getPendingOrders(
          credentials.appKey, credentials.appSecret, accessToken, credentials.accountNo, eodOrderExcd
        );
        const unfilledOrders = (pendingResp.output || []).filter(
          (o: { pdno: string; nccs_qty: string }) => o.pdno === ticker && parseInt(o.nccs_qty) > 0
        );
        for (const uf of unfilledOrders) {
          try {
            await kisClient.cancelOrder(
              credentials.appKey, credentials.appSecret, accessToken, credentials.accountNo,
              { orderNo: uf.odno, ticker, exchange: eodOrderExcd }
            );
          } catch (cancelErr) {
            console.error(`[EOD:${tag}] Cancel failed for ${ticker} ODNO=${uf.odno}:`, cancelErr);
          }
          await new Promise(resolve => setTimeout(resolve, 300));
        }
      } else {
        const pendingResp = await kisClient.getDomesticPendingOrders(
          credentials.appKey, credentials.appSecret, accessToken, credentials.accountNo, todayKST, ticker
        );
        const unfilledOrders = (pendingResp.output1 || []).filter(
          (o: { pdno: string; rmn_qty: string }) => o.pdno === ticker && parseInt(o.rmn_qty) > 0
        );
        for (const uf of unfilledOrders) {
          try {
            await kisClient.cancelDomesticOrder(
              credentials.appKey, credentials.appSecret, accessToken, credentials.accountNo,
              { orderNo: uf.odno, orgNo: uf.orgn_odno, ticker }
            );
          } catch (cancelErr) {
            console.error(`[EOD:${tag}] Cancel failed for ${ticker} ODNO=${uf.odno}:`, cancelErr);
          }
          await new Promise(resolve => setTimeout(resolve, 300));
        }
      }

      // 4. 매도
      console.log(`[EOD:${tag}] Sell ${ticker}: ${totalQty}주`);
      let sellResult;
      if (market === 'overseas') {
        const priceData = await kisClient.getCurrentPrice(
          credentials.appKey, credentials.appSecret, accessToken, ticker, eodQuoteExcd
        );
        const currentPrice = parseFloat(priceData.output?.last || '0');
        if (currentPrice <= 0) {
          console.error(`[EOD:${tag}] Price fetch failed for ${ticker}`);
          continue;
        }
        const sellPrice = Math.round(currentPrice * 0.95 * 100) / 100;
        console.log(`[EOD:${tag}] ${ticker} currentPrice=$${currentPrice} → sellPrice=$${sellPrice} (5% buffer)`);
        sellResult = await kisClient.submitOrder(
          credentials.appKey, credentials.appSecret, accessToken, credentials.accountNo,
          { ticker, side: 'SELL', orderType: 'LIMIT', price: sellPrice, quantity: totalQty, exchange: eodOrderExcd }
        );
      } else {
        sellResult = await kisClient.submitDomesticOrder(
          credentials.appKey, credentials.appSecret, accessToken, credentials.accountNo,
          { ticker, side: 'SELL', orderType: 'MARKET', price: 0, quantity: totalQty }
        );
      }

      if (sellResult.rt_cd !== '0') {
        console.error(`[EOD:${tag}] Sell failed for ${ticker}: ${sellResult.msg1}`);
        continue;
      }

      if (market === 'overseas') {
        // 해외 LIMIT: 체결 확인 전까지 state 유지
        store.updateState('realtimeDdsobV2State', ticker, {
          eodSellPending: true,
          eodSellOrderNo: sellResult.output?.ODNO || '',
          eodSellDate: todayET,
        });
        console.log(`[EOD:${tag}] ${ticker} sell submitted ODNO=${sellResult.output?.ODNO}, awaiting fill confirmation`);

        const estimatedSellPrice = (state.previousPrice as number) || 0;
        const estimatedProfit = ((state.totalRealizedProfit as number) || 0) + (estimatedSellPrice * totalQty - totalBuyAmount);
        eodResults.push({ ticker, name: tc.stockName || ticker, soldQty: totalQty, profit: estimatedProfit, isAutoSelected, pending: true });
      } else {
        // 국내 시장가: 즉시 체결
        const estimatedSellPrice = (state.previousPrice as number) || 0;
        const estimatedProfit = ((state.totalRealizedProfit as number) || 0) + (estimatedSellPrice * totalQty - totalBuyAmount);

        store.addCycleHistory({
          ticker, market, strategy: strategyId,
          stockName: tc.stockName || ticker,
          cycleNumber: (state.cycleNumber as number) || 1,
          autoSelected: isAutoSelected, dailyCycle: true,
          eodAction: isAutoSelected ? 'market_sell' : 'manual_eod_sell',
          startedAt: state.startedAt,
          completedAt: new Date().toISOString(),
          principal: tc.principal, splitCount: tc.splitCount, profitPercent: tc.profitPercent,
          amountPerRound: state.amountPerRound,
          forceSellCandles: tc.forceSellCandles, intervalMinutes: tc.intervalMinutes,
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
          totalSellAmount: ((state.totalSellAmount as number) || 0) + estimatedSellPrice * totalQty,
          totalRealizedProfit: estimatedProfit,
          finalProfitRate: tc.principal > 0 ? estimatedProfit / tc.principal : 0,
          maxRoundsAtEnd: (state.maxRounds as number) || tc.splitCount,
          totalForceSellCount: (state.totalForceSellCount as number) || 0,
          totalForceSellLoss: (state.totalForceSellLoss as number) || 0,
          eodSoldQuantity: totalQty,
          candlesSinceCycleStart: (state.candlesSinceCycleStart as number) || 0,
        });

        eodResults.push({ ticker, name: tc.stockName || ticker, soldQty: totalQty, profit: estimatedProfit, isAutoSelected });
        store.deleteState('realtimeDdsobV2State', ticker);
      }

    } catch (err) {
      if (!eodTokenRefreshed && isTokenExpiredError(err)) {
        console.log(`[EOD:${tag}] Token expired at ${ticker}, refreshing and retrying...`);
        accessToken = await getOrRefreshToken('', ctx?.accountId ?? config.accountId, credentials, kisClient, true);
        eodTokenRefreshed = true;
        eodIdx--;
        continue;
      } else {
        console.error(`[EOD:${tag}] Error processing ${ticker}:`, err);
      }
    }
    await new Promise(resolve => setTimeout(resolve, 300));
  }

  // 6. config에서 해당 마켓의 autoSelected 종목만 제거
  const allTickers = extractTickerConfigsV2(rdConfig);
  const hasAutoSelected = eodTickers.some(t => t.autoSelected);
  if (hasAutoSelected) {
    const remainingTickers = allTickers.filter(t => !(t.autoSelected && t.market === market));
    const currentConfig = getMarketStrategyConfig<Record<string, unknown>>(market, strategyId) || {};
    setMarketStrategyConfig(market, strategyId, {
      ...currentConfig,
      tickers: remainingTickers,
    });
  }

  // Telegram 알림
  const confirmedResults = eodResults.filter(r => !r.pending);
  const pendingResults = eodResults.filter(r => r.pending);

  if (chatId && eodResults.length > 0) {
    const formatLine = (r: { ticker: string; name: string; soldQty: number; profit: number }) =>
      `  ${r.name}: ${r.soldQty}주 매도, 수익 ${r.profit >= 0 ? '+' : ''}${Math.round(r.profit).toLocaleString()}${currencyUnit}`;
    const formatPendingLine = (r: { ticker: string; name: string; soldQty: number }) =>
      `  ${r.name}: ${r.soldQty}주 매도 접수 (체결 대기)`;

    let msg = `🏁 <b>장마감 강제 청산 (${tag})</b>\n\n`;

    if (confirmedResults.length > 0) {
      const autoConfirmed = confirmedResults.filter(r => r.isAutoSelected);
      const manualConfirmed = confirmedResults.filter(r => !r.isAutoSelected);
      if (autoConfirmed.length > 0) msg += `📋 자동추천 종목:\n${autoConfirmed.map(formatLine).join('\n')}\n\n`;
      if (manualConfirmed.length > 0) msg += `📌 수동 종목:\n${manualConfirmed.map(formatLine).join('\n')}\n\n`;
    }
    if (pendingResults.length > 0) {
      msg += `⏳ 체결 대기:\n${pendingResults.map(formatPendingLine).join('\n')}\n\n`;
    }

    if (eodResults.some(r => r.isAutoSelected)) {
      if (market === 'domestic') {
        msg += `내일 09:10에 새 종목을 선별합니다.`;
      } else {
        msg += `내일 09:50 ET에 새 종목을 선별합니다.`;
      }
    }
    await sendTelegramMessage(chatId, msg);
  }

  console.log(`[EOD:${tag}] Completed: ${confirmedResults.length} confirmed, ${pendingResults.length} pending`);
}
