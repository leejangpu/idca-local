import { config } from '../config';
import * as localStore from '../lib/localStore';
import { getUSMarketHolidayName, isUSMarketOpen } from '../lib/usMarketHolidays';
import { KisApiClient, getOrRefreshToken, isTokenExpiredError } from '../lib/kisApi';
import { AccountStrategy, getCommonConfig, getMarketStrategyConfig, setMarketStrategyConfig, isMarketStrategyActive } from '../lib/configHelper';
import {
  sendTelegramMessage,
  getUserTelegramChatId,
} from '../lib/telegram';
import {
  calculateRealtimeDdsobV2,
  generateRealtimeBuyRecordIdV2,
  getAscendingAmountForRound,
  getAscendingMaxPrice,
  type RealtimeBuyRecordV2,
} from '../lib/realtimeDdsobV2Calculator';
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
} from '../lib/rsiCalculator';
import {
  type MarketType,
  getMarketType,
  formatPrice as marketFormatPrice,
  isKRMarketOpen,
  getKRMarketHolidayName,
  getKSTDateString,
  getKSTCurrentMinute,
  getETCurrentMinute,
} from '../lib/marketUtils';

// 동시 실행 방어: 이전 트리거가 실행 중이면 다음 트리거를 스킵
let krTriggerRunningV2 = false;
let usTriggerRunningV2 = false;

// autoSelected 종목 첫 매수 타임아웃: N캔들 이내 매수 미발생 시 종목 제외
const FIRST_BUY_TIMEOUT_CANDLES = 10;

interface RealtimeDdsobV2Config {
  tickers: RealtimeDdsobV2TickerConfig[];
  stopAfterCycleEnd: boolean;
  autoSelectEnabled?: boolean;
  autoSelectConfig?: AutoSelectConfig;
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
  exhaustionStopLoss?: boolean;  // 분할소진 후 가격 하드스탑 ON/OFF
  stopLossMultiplier?: number;   // TP 배수 (기본 3: TP=0.5% → -1.5% 도달 시 손절)
  forceLiquidateAtClose?: boolean;
  minDropPercent?: number;       // 최소 낙폭 (0.002 = 0.2%, 평단가 대비 이 이상 하락해야 매수)
  peakCheckCandles?: number;     // 피크 확인 캔들 수 (직전 캔들이 N캔들 중 고점이면 매수 스킵, 0=비활성, 기본: 10)
  exchangeCode?: string;         // 해외 거래소 코드 (NAS/NYS/AMS, 자동선별 시 저장)
  selectionMode?: string;        // 선별 모드 (mixed/marketCapOnly/volumeOnly/sideways)
  conditionName?: string;        // 조건검색 조건명 (sideways 모드)
  ascendingSplit?: boolean;      // 급경사 점증 분할 (초반 소액, 후반 대량)
}

export function extractTickerConfigsV2(rdConfig: Record<string, unknown>): RealtimeDdsobV2TickerConfig[] {
  // 새 형식: tickers 배열
  if (Array.isArray(rdConfig.tickers)) {
    // market 필드 누락 시 ticker 코드에서 자동 감지
    return rdConfig.tickers.map((t: RealtimeDdsobV2TickerConfig) => ({
      ...t,
      market: t.market || getMarketType(t.ticker),
    }));
  }
  // 구 형식: 단일 ticker
  if (typeof rdConfig.ticker === 'string') {
    const ticker = rdConfig.ticker;
    const market = getMarketType(ticker);
    return [{
      ticker,
      market,
      principal: market === 'domestic' ? 5000000 : 5000,
      splitCount: rdConfig.splitCount ?? 10,
      profitPercent: rdConfig.profitPercent ?? 0.01,
      forceSellCandles: rdConfig.forceSellCandles ?? 10,
      intervalMinutes: rdConfig.intervalMinutes ?? 15,
    }];
  }
  return [];
}

/**
 * state 문서에서 tickerConfig 복원 (config에서 제거된 진행중 사이클용)
 * 사이클 시작 시 스냅샷된 설정값을 사용하여 독립 운영
 */
function buildTickerConfigFromStateV2(stateData: Record<string, unknown>): RealtimeDdsobV2TickerConfig {
  return {
    ticker: stateData.ticker,
    market: stateData.market || 'overseas',
    principal: stateData.principal ?? 5000,
    splitCount: stateData.splitCount ?? 10,
    profitPercent: stateData.profitPercent ?? 0.01,
    forceSellCandles: stateData.forceSellCandles ?? 10,
    intervalMinutes: stateData.intervalMinutes ?? 15,
    stockName: stateData.stockName || stateData.ticker,
    autoSelected: stateData.autoSelected ?? false,
    minDropPercent: stateData.minDropPercent ?? 0,
    exchangeCode: stateData.exchangeCode,
  };
}


/**
 * 실사오팔v2 미국장 스케줄러
 * 1분마다 실행, overseas 티커만 처리
 */
export const realtimeTradingTriggerUSV2 = onSchedule(
  {
    schedule: '*/1 9-15 * * 1-5', // 월~금, 09:00~15:59 ET만 (09:50부터 매매)
    timeZone: 'America/New_York',
    secrets: [telegramBotToken],
    maxInstances: 1,
  },
  async () => {
    if (!isUSMarketOpen()) return;

    // 이전 트리거가 아직 실행 중이면 스킵
    if (usTriggerRunningV2) {
      console.log('[RealtimeDdsobV2:US] Previous trigger still running, skipping');
      return;
    }
    usTriggerRunningV2 = true;

    console.log('[RealtimeDdsobV2:US] Trigger started');

    
    const currentMinute = getETCurrentMinute();

    // 실사오팔v2: 장 시작 20분 후부터 매매 (09:50 ET~)
    if (currentMinute < 9 * 60 + 50) { usTriggerRunningV2 = false; return; }

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
      console.log(`[RealtimeDdsobV2:US] Holiday: ${holidayName}`);
      usTriggerRunningV2 = false;
      return;
    }

    try {
      const usersSnapshot = await db.collection('users').get();
      let processedCount = 0;

      for (const userDoc of usersSnapshot.docs) {
        const userId = userDoc.id;
        const accountsSnapshot = await db.collection(`users/${userId}/accounts`).get();

        for (const accountDoc of accountsSnapshot.docs) {
          const accountId = accountDoc.id;
          const commonConfig = await getCommonConfig(db, userId, accountId);
          if (!commonConfig?.tradingEnabled) continue;
          const isV2Active = isMarketStrategyActive(commonConfig, 'overseas', 'realtimeDdsobV2');
          const isV2_1Active = isMarketStrategyActive(commonConfig, 'overseas', 'realtimeDdsobV2_1');
          const isActiveStrategy = isV2Active || isV2_1Active;

          // 전략이 다를 때: 잔여 포지션이 있으면 매도 전용 모드, 없으면 스킵
          if (!isActiveStrategy) {
            const stateRef = db.collection(`users/${userId}/accounts/${accountId}/realtimeDdsobV2State`);
            const activeStates = await stateRef.where('status', '==', 'active').limit(1).get();
            if (activeStates.empty) continue;
            console.log(`[RealtimeDdsobV2:US] ${userId}/${accountId} — 매도 전용 모드 (잔여 포지션 존재)`);
          }

          const rdConfig = isV2_1Active
            ? await getMarketStrategyConfig<RealtimeDdsobV2_1Config>(db, userId, accountId, 'overseas', 'realtimeDdsobV2_1')
            : await getMarketStrategyConfig<RealtimeDdsobV2Config>(db, userId, accountId, 'overseas', 'realtimeDdsobV2');
          if (!rdConfig) continue;

          const tickerConfigs = extractTickerConfigsV2(rdConfig);
          const overseasConfigTickers = tickerConfigs.filter(t => t.market === 'overseas');
          const isUSAutoSelectEnabled = isV2_1Active
            ? (rdConfig as RealtimeDdsobV2_1Config).autoSelectEnabledUS === true
            : (rdConfig as RealtimeDdsobV2Config).autoSelectEnabled === true;
          const isUSEODTime = currentMinute >= 945;

          // ======== 활성 state 조회 + config 매핑 ========
          const allStatesSnap = await db.collection(`users/${userId}/accounts/${accountId}/realtimeDdsobV2State`).get();
          const configTickerMap = new Map(overseasConfigTickers.map(t => [t.ticker, t]));

          // 활성 overseas state 분류: EOD 대상 vs 일반 매매
          const eodTickers: RealtimeDdsobV2TickerConfig[] = [];
          const normalStateTickers: { ticker: string; tc: RealtimeDdsobV2TickerConfig }[] = [];

          for (const stateDoc of allStatesSnap.docs) {
            const stateData = stateDoc.data();
            if (stateData.status !== 'active') continue;
            const stateMarket = stateData.market || getMarketType(stateDoc.id);
            if (stateMarket !== 'overseas') continue;

            const ticker = stateDoc.id;
            const tc = configTickerMap.get(ticker) || buildTickerConfigFromStateV2(stateData);

            if (isUSEODTime && (tc.autoSelected || tc.forceLiquidateAtClose)) {
              eodTickers.push(tc);
            } else {
              normalStateTickers.push({ ticker, tc });
            }
          }

          // ======== 1. EOD 일괄 처리 (autoSelected/forceLiquidateAtClose) ========
          if (isUSEODTime && eodTickers.length > 0) {
            try {
              const eodStrategyId: AccountStrategy = isV2_1Active ? 'realtimeDdsobV2_1' : 'realtimeDdsobV2';
              await processAutoSelectEOD(userId, accountId, eodTickers, rdConfig, db, 'overseas', eodStrategyId);
            } catch (err) {
              console.error(`[RealtimeDdsobV2:US] EOD error ${userId}/${accountId}:`, err);
            }
          }

          // ======== EOD 이후 일반 매매 차단 ========
          // EOD 시간(15:45 ET) 이후에는 장 마감 직전이므로 일반 매매/신규 사이클/재선택 모두 스킵
          if (isUSEODTime) continue;

          // ======== 2. 활성 state 기반 일반 매매 처리 (병렬, 300ms 스태거) ========
          {
            const tradingStrategyId: AccountStrategy = isV2_1Active ? 'realtimeDdsobV2_1' : 'realtimeDdsobV2';
            const tasks = normalStateTickers
              .filter(({ tc }) => currentMinute % tc.intervalMinutes === 0)
              .map(({ ticker, tc }, i) => {
                processedCount++;
                return new Promise<void>(resolve => setTimeout(resolve, i * 300)).then(async () => {
                  try {
                    await processRealtimeDdsobV2Trading(userId, accountId, tc, rdConfig, db, 'overseas',
                      !isActiveStrategy ? { sellOnly: true, strategyId: tradingStrategyId } : { strategyId: tradingStrategyId });
                  } catch (err) {
                    console.error(`[RealtimeDdsobV2:US] Error ${userId}/${accountId}/${ticker}:`, err);
                  }
                });
              });
            await Promise.all(tasks);
          }

          // 매도 전용 모드: 신규 사이클 시작 및 자동선별 스킵
          if (!isActiveStrategy) continue;

          // ======== 3. config에만 있고 state가 없는 종목 → 신규 사이클 시작 (병렬, 300ms 스태거) ========
          {
            const tradingStrategyId2: AccountStrategy = isV2_1Active ? 'realtimeDdsobV2_1' : 'realtimeDdsobV2';
            const activeStateTickers = new Set(allStatesSnap.docs.map(d => d.id));
            const newTasks = overseasConfigTickers
              .filter(tc => !activeStateTickers.has(tc.ticker) && currentMinute % tc.intervalMinutes === 0)
              .map((tc, i) => {
                processedCount++;
                return new Promise<void>(resolve => setTimeout(resolve, i * 300)).then(async () => {
                  try {
                    await processRealtimeDdsobV2Trading(userId, accountId, tc, rdConfig, db, 'overseas', { strategyId: tradingStrategyId2 });
                  } catch (err) {
                    console.error(`[RealtimeDdsobV2:US] New cycle error ${tc.ticker}:`, err);
                  }
                });
              });
            await Promise.all(newTasks);
          }

          // ======== US 빈 슬롯 재선택 (매매 처리와 독립적으로 실행) ========
          const usReselectionCutoff = 15 * 60; // 15:00 ET
          if (!isUSEODTime && isUSAutoSelectEnabled && currentMinute < usReselectionCutoff) {
            try {
              // v2.1: 지표 기반 자동선별 / v2: 기존 거래대금 순위 기반
              const latestRdConfig = isV2_1Active
                ? await getMarketStrategyConfig<RealtimeDdsobV2_1Config>(db, userId, accountId, 'overseas', 'realtimeDdsobV2_1')
                : await getMarketStrategyConfig<RealtimeDdsobV2Config>(db, userId, accountId, 'overseas', 'realtimeDdsobV2');
              if (latestRdConfig) {
                const latestTickers = extractTickerConfigsV2(latestRdConfig);
                const currentUSAutoCount = latestTickers.filter(t => t.autoSelected && t.market === 'overseas').length;

                if (isV2_1Active) {
                  const autoConfigV2_1 = (latestRdConfig as RealtimeDdsobV2_1Config).autoSelectConfigUS;
                  if (autoConfigV2_1 && autoConfigV2_1.stockCount > 0) {
                    const emptySlots = autoConfigV2_1.stockCount - currentUSAutoCount;
                    if (emptySlots > 0) {
                      console.log(`[RealtimeDdsobV2.1:US] Empty slots detected: ${emptySlots}`);
                      const newTickers = await processAutoSelectStocksV2_1US(userId, accountId, autoConfigV2_1, latestRdConfig, db, { mode: 'refill' });
                      for (const ntc of newTickers) {
                        processedCount++;
                        try {
                          await processRealtimeDdsobV2Trading(userId, accountId, ntc, latestRdConfig, db, 'overseas', { strategyId: 'realtimeDdsobV2_1' });
                        } catch (err) {
                          console.error(`[RealtimeDdsobV2.1:US] Refill immediate trade error ${ntc.ticker}:`, err);
                        }
                        await new Promise(resolve => setTimeout(resolve, 500));
                      }
                    }
                  }
                } else {
                  const autoConfigUS = (latestRdConfig as RealtimeDdsobV2Config).autoSelectConfig as unknown as AutoSelectConfigUS;
                  if (autoConfigUS && autoConfigUS.stockCount > 0) {
                    const emptySlots = autoConfigUS.stockCount - currentUSAutoCount;
                    if (emptySlots > 0) {
                      console.log(`[RealtimeDdsobV2:US] Empty slots detected: ${emptySlots} (target=${autoConfigUS.stockCount}, current=${currentUSAutoCount})`);
                      const newTickers = await processAutoSelectStocksUS(userId, accountId, autoConfigUS, latestRdConfig, db, { mode: 'refill' });
                      for (const ntc of newTickers) {
                        processedCount++;
                        try {
                          await processRealtimeDdsobV2Trading(userId, accountId, ntc, latestRdConfig, db, 'overseas');
                        } catch (err) {
                          console.error(`[RealtimeDdsobV2:US] Refill immediate trade error ${ntc.ticker}:`, err);
                        }
                        await new Promise(resolve => setTimeout(resolve, 500));
                      }
                    }
                  }
                }
              }
            } catch (err) {
              console.error(`[RealtimeDdsobV2:US] Refill error ${userId}/${accountId}:`, err);
            }
          }
        }
      }

      console.log(`[RealtimeDdsobV2:US] Processed ${processedCount} tickers`);
    } catch (error) {
      console.error('[RealtimeDdsobV2:US] Trigger error:', error);
    } finally {
      usTriggerRunningV2 = false;
    }
  }
);

/**
 * 실사오팔v2 한국장 스케줄러
 * 1분마다 실행, domestic 티커만 처리
 */
export const realtimeTradingTriggerKRV2 = onSchedule(
  {
    schedule: '*/1 9-15 * * 1-5', // 월~금, 09:00~15:59 KST만
    timeZone: 'Asia/Seoul',
    secrets: [telegramBotToken],
    maxInstances: 1, // 인스턴스 1개로 제한 (in-memory flag 신뢰성 보장)
  },
  async () => {
    if (!isKRMarketOpen()) return;

    // 이전 트리거가 아직 실행 중이면 스킵
    if (krTriggerRunningV2) {
      console.log('[RealtimeDdsobV2:KR] Previous trigger still running, skipping');
      return;
    }
    krTriggerRunningV2 = true;

    console.log('[RealtimeDdsobV2:KR] Trigger started');

    
    const now = new Date();
    const kstTime = new Date(now.getTime() + 9 * 60 * 60 * 1000);
    const currentMinute = getKSTCurrentMinute();

    // 실사오팔v2: 장 시작 20분 후부터 매매 (09:20 KST~)
    if (currentMinute < 9 * 60 + 20) { krTriggerRunningV2 = false; return; }

    // 휴장일 확인
    const holidayName = getKRMarketHolidayName(kstTime);
    if (holidayName) {
      console.log(`[RealtimeDdsobV2:KR] Holiday: ${holidayName}`);
      krTriggerRunningV2 = false;
      return;
    }

    try {
      const usersSnapshot = await db.collection('users').get();
      let processedCount = 0;

      for (const userDoc of usersSnapshot.docs) {
        const userId = userDoc.id;
        const accountsSnapshot = await db.collection(`users/${userId}/accounts`).get();

        for (const accountDoc of accountsSnapshot.docs) {
          const accountId = accountDoc.id;
          const commonConfig = await getCommonConfig(db, userId, accountId);
          if (!commonConfig?.tradingEnabled) continue;
          const isActiveStrategy = isMarketStrategyActive(commonConfig, 'domestic', 'realtimeDdsobV2');

          // 전략이 다를 때: 잔여 포지션이 있으면 매도 전용 모드, 없으면 스킵
          if (!isActiveStrategy) {
            const stateRef = db.collection(`users/${userId}/accounts/${accountId}/realtimeDdsobV2State`);
            const activeStates = await stateRef.where('status', '==', 'active').limit(1).get();
            if (activeStates.empty) continue;
            console.log(`[RealtimeDdsobV2:KR] ${userId}/${accountId} — 매도 전용 모드 (잔여 포지션 존재)`);
          }

          const rdConfig = await getMarketStrategyConfig<RealtimeDdsobV2Config>(db, userId, accountId, 'domestic', 'realtimeDdsobV2');
          if (!rdConfig) continue;

          const tickerConfigs = extractTickerConfigsV2(rdConfig);
          const domesticConfigTickers = tickerConfigs.filter(t => t.market === 'domestic');
          const isEODTime = currentMinute >= 915;

          // ======== 활성 state 조회 + config 매핑 ========
          const allStatesSnap = await db.collection(`users/${userId}/accounts/${accountId}/realtimeDdsobV2State`).get();
          const configTickerMap = new Map(domesticConfigTickers.map(t => [t.ticker, t]));

          // 활성 domestic state 분류: EOD 대상 vs 일반 매매
          const eodTickers: RealtimeDdsobV2TickerConfig[] = [];
          const normalStateTickers: { ticker: string; tc: RealtimeDdsobV2TickerConfig }[] = [];

          for (const stateDoc of allStatesSnap.docs) {
            const stateData = stateDoc.data();
            if (stateData.status !== 'active') continue;
            const stateMarket = stateData.market || getMarketType(stateDoc.id);
            if (stateMarket !== 'domestic') continue;

            const ticker = stateDoc.id;
            const tc = configTickerMap.get(ticker) || buildTickerConfigFromStateV2(stateData);

            if (isEODTime && (tc.autoSelected || tc.forceLiquidateAtClose)) {
              eodTickers.push(tc);
            } else {
              normalStateTickers.push({ ticker, tc });
            }
          }

          // ======== 1. EOD 일괄 처리 (autoSelected/forceLiquidateAtClose) ========
          if (isEODTime && eodTickers.length > 0) {
            try {
              await processAutoSelectEOD(userId, accountId, eodTickers, rdConfig, db);
            } catch (err) {
              console.error(`[RealtimeDdsobV2:KR] EOD error ${userId}/${accountId}:`, err);
            }
          }

          // ======== EOD 이후 일반 매매 차단 ========
          // EOD 시간(15:15 KST) 이후에는 장 마감 직전이므로 일반 매매/신규 사이클/재선택 모두 스킵
          if (isEODTime) continue;

          // ======== 2. 활성 state 기반 일반 매매 처리 (병렬, 300ms 스태거) ========
          {
            const tasks = normalStateTickers
              .filter(({ tc }) => currentMinute % tc.intervalMinutes === 0)
              .map(({ ticker, tc }, i) => {
                processedCount++;
                return new Promise<void>(resolve => setTimeout(resolve, i * 300)).then(async () => {
                  try {
                    await processRealtimeDdsobV2Trading(userId, accountId, tc, rdConfig, db, 'domestic',
                      !isActiveStrategy ? { sellOnly: true } : undefined);
                  } catch (err) {
                    console.error(`[RealtimeDdsobV2:KR] Error ${userId}/${accountId}/${ticker}:`, err);
                  }
                });
              });
            await Promise.all(tasks);
          }

          // 매도 전용 모드: 신규 사이클 시작 및 자동선별 스킵
          if (!isActiveStrategy) continue;

          // 점심시간 신규진입 차단 (11:30~13:00 KST) — 기존 사이클은 위에서 정상 처리됨
          const isLunchBreak = currentMinute >= 690 && currentMinute < 780;
          if (isLunchBreak) {
            console.log(`[RealtimeDdsobV2:KR] Lunch break (11:30~13:00) — skipping new cycle entries`);
            continue;
          }

          // ======== 3. config에만 있고 state가 없는 종목 → 신규 사이클 시작 (병렬, 300ms 스태거) ========
          {
            const activeStateTickers = new Set(allStatesSnap.docs.map(d => d.id));
            const newTasks = domesticConfigTickers
              .filter(tc => !activeStateTickers.has(tc.ticker) && currentMinute % tc.intervalMinutes === 0)
              .map((tc, i) => {
                processedCount++;
                return new Promise<void>(resolve => setTimeout(resolve, i * 300)).then(async () => {
                  try {
                    await processRealtimeDdsobV2Trading(userId, accountId, tc, rdConfig, db, 'domestic');
                  } catch (err) {
                    console.error(`[RealtimeDdsobV2:KR] New cycle error ${tc.ticker}:`, err);
                  }
                });
              });
            await Promise.all(newTasks);
          }

          // ======== 빈 슬롯 재선택 (매매 처리와 독립적으로 실행) ========
          // domesticTickers가 0이어도 실행 (이전 틱에서 전부 사이클 종료된 경우 대응)
          const reselectionCutoff = 14 * 60 + 30; // 14:30 KST
          if (rdConfig.autoSelectEnabled && currentMinute < reselectionCutoff) {
            const autoConfig = rdConfig.autoSelectConfig as AutoSelectConfig;
            if (autoConfig && autoConfig.stockCount > 0) {
              try {
                // config 재조회 (매매 처리 중 사이클 종료로 변경되었을 수 있음)
                const latestRdConfig = await getMarketStrategyConfig<RealtimeDdsobV2Config>(db, userId, accountId, 'domestic', 'realtimeDdsobV2');
                if (latestRdConfig) {
                  const latestTickers = extractTickerConfigsV2(latestRdConfig);
                  const currentAutoCount = latestTickers.filter(t => t.autoSelected && t.market === 'domestic').length;
                  const emptySlots = autoConfig.stockCount - currentAutoCount;

                  if (emptySlots > 0) {
                    console.log(`[RealtimeDdsobV2:KR] Empty slots detected: ${emptySlots} (target=${autoConfig.stockCount}, current=${currentAutoCount})`);
                    const newTickers = await processAutoSelectStocks(userId, accountId, autoConfig, latestRdConfig, db, { mode: 'refill' });

                    // refill로 추가된 종목 즉시 매매 시작 (다음 틱까지 기다리지 않음)
                    for (const ntc of newTickers) {
                      processedCount++;
                      try {
                        await processRealtimeDdsobV2Trading(userId, accountId, ntc, latestRdConfig, db, 'domestic');
                      } catch (err) {
                        console.error(`[RealtimeDdsobV2:KR] Refill immediate trade error ${ntc.ticker}:`, err);
                      }
                      await new Promise(resolve => setTimeout(resolve, 500));
                    }
                  }
                }
              } catch (err) {
                console.error(`[RealtimeDdsobV2:KR] Refill error ${userId}/${accountId}:`, err);
              }
            }
          }
        }
      }

      console.log(`[RealtimeDdsobV2:KR] Processed ${processedCount} tickers`);
    } catch (error) {
      console.error('[RealtimeDdsobV2:KR] Trigger error:', error);
    } finally {
      krTriggerRunningV2 = false;
    }
  }
);

/**
 * 매수 시점 RSI (5분봉/15분봉) 조회
 * 해외: NMIN으로 직접 5분/15분봉 요청
 * 국내: 1분봉 조회 후 집계
 */
interface RSIResult {
  rsi5m: number | null;
  rsi15m: number | null;
  rsi5mBars: number;    // RSI 계산에 사용된 5분봉 캔들 수
  rsi15mBars: number;   // RSI 계산에 사용된 15분봉 캔들 수
}

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
      // 해외: NMIN으로 5분봉/15분봉 직접 요청
      await new Promise(resolve => setTimeout(resolve, 300));
      const [resp5m, resp15m] = await Promise.all([
        kisClient.getOverseasMinuteBars(appKey, appSecret, accessToken, ticker, 5, 20),
        new Promise(resolve => setTimeout(resolve, 300)).then(() =>
          kisClient.getOverseasMinuteBars(appKey, appSecret, accessToken, ticker, 15, 20)
        ),
      ]);

      const closes5m = (resp5m.output2 || [])
        .map(b => parseFloat(b.last))
        .filter(v => v > 0)
        .reverse(); // API는 최신→과거 순, RSI는 과거→최신 순 필요
      const closes15m = (resp15m.output2 || [])
        .map(b => parseFloat(b.last))
        .filter(v => v > 0)
        .reverse();

      const rsi5m = calculateRSI(closes5m);
      const rsi15m = calculateRSI(closes15m);
      console.log(`[RealtimeDdsobV2:${tag}] RSI at buy: 5m=${rsi5m}, 15m=${rsi15m} (data: 5m=${closes5m.length}건, 15m=${closes15m.length}건)`);
      return { rsi5m, rsi15m, rsi5mBars: closes5m.length, rsi15mBars: closes15m.length };
    } else {
      // 국내: 1분봉 조회 후 5분/15분봉으로 집계
      // 15분봉 RSI(14)에는 15개 15분봉 = 225개 1분봉 필요
      // 30건/호출이므로 여러 시간 윈도우에서 조회
      const now = new Date();
      const kstHour = (now.getUTCHours() + 9) % 24;
      const kstMinute = now.getUTCMinutes();

      // 현재 시각부터 역순으로 시간 윈도우 생성
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

      // 시간순 정렬 (오래된 것부터)
      allBars.sort((a, b) => {
        const ka = `${a.date}_${a.time}`;
        const kb = `${b.date}_${b.time}`;
        return ka.localeCompare(kb);
      });

      // 5분봉/15분봉 집계
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

/**
 * 종목 선택 시 과거 분봉 데이터로 EMA/RSI 초기화
 * - 해외: 1분봉 20개 + 5분봉 25개 (2 API calls)
 * - 국내: 1분봉 수집 → 5분봉 집계 (3~5 API calls)
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
      // 해외: 1분봉 + 5분봉 병렬 조회
      await new Promise(resolve => setTimeout(resolve, 300));
      const [resp1m, resp5m] = await Promise.all([
        kisClient.getOverseasMinuteBars(appKey, appSecret, accessToken, ticker, 1, 20),
        new Promise(resolve => setTimeout(resolve, 300)).then(() =>
          kisClient.getOverseasMinuteBars(appKey, appSecret, accessToken, ticker, 5, 25)
        ),
      ]);

      const closes1m = (resp1m.output2 || [])
        .map(b => parseFloat(b.last))
        .filter(v => v > 0)
        .reverse(); // API: 최신→과거 순 → reverse로 시간순

      const closes5m = (resp5m.output2 || [])
        .map(b => parseFloat(b.last))
        .filter(v => v > 0)
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

      // 시간 윈도우 생성 (현재 → 09:00, 최대 5회)
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

      // 시간순 정렬
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
    // 실패해도 빈 indicators 반환 — 이후 틱에서 점진 축적
  }
  return { indicators, recentCloses1m };
}

/**
 * 매 틱 EMA/RSI 갱신
 * @param indicators 현재 지표 상태
 * @param currentPrice 현재가
 * @param intervalMinutes 체크 간격 (분)
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
    // 1분봉 → 5분봉 버퍼 집계
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
    // interval >= 5분: 매 틱이 5분봉 이상
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

// 틱 기반 스프레드 필터 상수
const MAX_SPREAD_TICKS = 1;            // 기본: 1틱까지 허용
const MAX_SPREAD_TICKS_RELAXED = 2;    // 조건부: TP_ticks >= 6이면 2틱 허용
const MIN_TP_TICKS_FOR_RELAXED = 6;    // 2틱 허용에 필요한 최소 TP 틱수
const MIN_TP_TICKS = 3;               // 최소 TP 틱수 (이 이하면 진입 금지)
const LIQUIDITY_MULTIPLIER = 10;      // 잔량 >= 주문수량 × 이 값
const UPPER_ROOM_BUFFER_BPS = 20;     // 상한가 여유 버퍼 (bps)

/** 한국 주식 호가단위 (KRX 기준) */
function getDomesticTickSize(price: number): number {
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
  spreadTicks: number;    // (ask1 - bid1) / tick — 정상이면 1,2,3...
  spreadAbs: number;      // ask1 - bid1 (원)
  tick: number;           // 호가단위
  tpTicks: number;        // TP를 틱으로 환산 (profitPercent 기반)
  askQty: number;         // 매도1 잔량
  bidQty: number;         // 매수1 잔량
  currentPrice: number;
  basePrice: number;      // 기준가 (상한가 추정용)
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

/**
 * 틱 기반 스프레드 + TP 틱수 + 잔량 필터 판정
 * @param orderQty 주문 수량 (선정 단계에서는 추정치, 진입에서는 실제값)
 * @returns { pass, reason } — reason은 차단 사유 (로그용)
 */
function checkTickFilter(
  info: DomesticOrderbookInfo,
  orderQty: number
): { pass: boolean; reason?: string } {
  // 1. 스프레드 틱수 체크
  if (info.spreadTicks > MAX_SPREAD_TICKS_RELAXED) {
    return { pass: false, reason: `spread ${info.spreadTicks}tick > ${MAX_SPREAD_TICKS_RELAXED}tick` };
  }
  if (info.spreadTicks > MAX_SPREAD_TICKS && info.tpTicks < MIN_TP_TICKS_FOR_RELAXED) {
    return { pass: false, reason: `spread ${info.spreadTicks}tick, TP ${info.tpTicks.toFixed(1)}tick < ${MIN_TP_TICKS_FOR_RELAXED}tick` };
  }

  // 2. TP 틱수 최소 조건 (목표가가 너무 가까우면 스프레드 비용이 과도)
  if (info.tpTicks < MIN_TP_TICKS) {
    return { pass: false, reason: `TP ${info.tpTicks.toFixed(1)}tick < ${MIN_TP_TICKS}tick` };
  }

  // 3. 잔량 체크 (주문수량 대비 호가 잔량이 충분한지)
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
function hasEnoughUpperRoom(currentPrice: number, upperLimit: number, profitPercent: number): boolean {
  if (upperLimit <= 0 || currentPrice <= 0) return true; // 데이터 없으면 통과
  const tpBps = profitPercent * 10000;
  const upperRoomBps = (upperLimit - currentPrice) / currentPrice * 10000;
  return upperRoomBps >= tpBps + UPPER_ROOM_BUFFER_BPS;
}

/**
 * 선정 단계: 틱 스프레드 + 잔량 + 상한가 여유 필터
 * 상위부터 순회하며 통과한 종목만 선택, 슬롯이 차면 중단
 */
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

  // 스프레드 필터 OFF → 호가 조회 없이 후보 상위부터 선택
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

      // 추정 주문수량 (선정 단계에서는 정확한 값이 없으므로 추정)
      const estimatedQty = amountPerRound && price > 0 ? Math.floor(amountPerRound / price) : 0;

      // 틱 + 잔량 필터
      const { pass, reason } = checkTickFilter(info, estimatedQty);
      if (!pass) {
        console.log(`[AutoSelect] ${candidate.name}(${candidate.ticker}) ${reason} → SKIP`);
        continue;
      }

      // 상한가 여유 체크 (기준가 * 1.30 ≈ 상한가)
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

/**
 * 실사오팔v2 매매 처리 함수 (국내/해외 통합)
 * 매 N분마다 호출되어 미체결 정리 → 계산 → 주문 제출 → 상태 갱신
 */
async function processRealtimeDdsobV2Trading(
  userId: string,
  accountId: string,
  tickerConfig: RealtimeDdsobV2TickerConfig,
  globalConfig: Record<string, unknown>,
  
  market: MarketType,
  options?: { sellOnly?: boolean; strategyId?: AccountStrategy }
): Promise<void> {
  const strategyId: AccountStrategy = options?.strategyId || 'realtimeDdsobV2';
  const sellOnly = options?.sellOnly ?? false;
  const { ticker, splitCount, profitPercent, intervalMinutes, principal: configPrincipal, minDropPercent, forceSellCandles } = tickerConfig;
  const stopAfterCycleEnd = globalConfig.stopAfterCycleEnd || false;
  const bufferPercent = 0.01; // 1% 버퍼 (고정)
  const tag = market === 'domestic' ? 'KR' : 'US';
  const fp = (p: number) => marketFormatPrice(p, market);

  console.log(`[RealtimeDdsobV2:${tag}] Processing ${userId}/${accountId} ticker=${ticker} interval=${intervalMinutes}min${sellOnly ? ' [SELL-ONLY]' : ''}`);

  // 자격증명 & 토큰
  const credentialsDoc = await db.doc(`users/${userId}/accounts/${accountId}/credentials/main`).get();
  if (!credentialsDoc.exists) {
    console.log(`[RealtimeDdsobV2:${tag}] No credentials for ${userId}/${accountId}`);
    return;
  }
  const credentials = credentialsDoc.data()!;
  const kisClient = new KisApiClient(false); // 실전 전용
  let accessToken = await getOrRefreshToken(userId, accountId, credentials as { appKey: string; appSecret: string }, kisClient);
  const chatId = await getUserTelegramChatId(userId);

  // 해외 거래소 코드: tickerConfig에 저장된 값 우선, 없으면 ticker 기반 자동 판별
  const quoteExcd = tickerConfig.exchangeCode;  // NAS/NYS/AMS (현재가 조회용)
  const orderExcd = quoteExcd ? KisApiClient.quoteToOrderExchangeCode(quoteExcd) : KisApiClient.getExchangeCode(ticker);  // NASD/NYSE/AMEX (주문용)

  // ======== 0단계: 미체결 주문 정리 ========
  try {
    if (market === 'overseas') {
      const pendingOrdersResp = await kisClient.getPendingOrders(
        credentials.appKey, credentials.appSecret, accessToken, credentials.accountNo, orderExcd
      );
      const unfilledOrders = (pendingOrdersResp.output || []).filter(
        o => o.pdno === ticker && parseInt(o.nccs_qty) > 0
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
      // 국내: 일별주문체결조회로 미체결 확인
      const todayKST = getKSTDateString();
      const pendingResp = await kisClient.getDomesticPendingOrders(
        credentials.appKey, credentials.appSecret, accessToken, credentials.accountNo,
        todayKST, ticker
      );
      const unfilledOrders = (pendingResp.output1 || []).filter(
        o => o.pdno === ticker && parseInt(o.rmn_qty) > 0
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
      accessToken = await getOrRefreshToken(userId, accountId, credentials as { appKey: string; appSecret: string }, kisClient, true);
    } else {
      console.error(`[RealtimeDdsobV2:${tag}] Error in unfilled order cleanup:`, err);
    }
  }

  // ======== 체결 내역 확인 & state 동기화 ========
  const stateRef = db.doc(`users/${userId}/accounts/${accountId}/realtimeDdsobV2State/${ticker}`);
  const stateDoc = await stateRef.get();
  let state = stateDoc.exists ? stateDoc.data()! : null;

  // 전일 EOD 매도 미체결 잔여 정리: eodSellPending 플래그가 남아있으면 클리어
  // (이 함수는 EOD 시간이 아닐 때만 호출되므로, 여기서 플래그가 있으면 전날 잔여)
  if (state?.eodSellPending) {
    console.warn(`[RealtimeDdsobV2:${tag}] Clearing stale eodSellPending for ${ticker} (previous day leftover)`);
    await stateRef.update({
      eodSellPending: undefined,
      eodSellOrderNo: undefined,
      eodSellDate: undefined,
    });
    delete state.eodSellPending;
    delete state.eodSellOrderNo;
  }

  // 동시 실행 방지: 최근 (intervalMinutes - 1)분 이내 처리된 티커는 건너뜀
  if (state?.lastCheckedAt) {
    const lastChecked = state.lastCheckedAt.toDate ? state.lastCheckedAt.toDate() : new Date(state.lastCheckedAt);
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
  if (state && state.lastOrderNumbers && state.lastOrderNumbers.length > 0) {
    try {
      await new Promise(resolve => setTimeout(resolve, 300));

      // 주문 제출 날짜부터 조회 (익일/주말/휴일 체결 누락 방지)
      const queryStartDate = state.lastOrderDate || todayStr;

      // 마켓별 체결내역 조회
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
          .filter(o => state!.lastOrderNumbers.includes(o.odno) && parseInt(o.ft_ccld_qty) > 0)
          .map(o => ({
            odno: o.odno,
            sll_buy_dvsn_cd: o.sll_buy_dvsn_cd,
            qty: parseInt(o.ft_ccld_qty),
            price: parseFloat(o.ft_ccld_unpr3),
            amount: parseFloat(o.ft_ccld_amt3) || parseFloat(o.ft_ccld_unpr3) * parseInt(o.ft_ccld_qty),
          }));
      } else {
        const histResp = await kisClient.getDomesticOrderHistory(
          credentials.appKey, credentials.appSecret, accessToken, credentials.accountNo,
          queryStartDate, todayStr, '01', '00', ticker  // 체결만
        );
        if (histResp.rt_cd !== '0') {
          throw new Error(`Domestic order history API error: rt_cd=${histResp.rt_cd}, msg=${histResp.msg1}`);
        }
        filledOrders = (histResp.output1 || [])
          .filter(o => state!.lastOrderNumbers.includes(o.odno) && parseInt(o.tot_ccld_qty) > 0)
          .map(o => ({
            odno: o.odno,
            sll_buy_dvsn_cd: o.sll_buy_dvsn_cd,
            qty: parseInt(o.tot_ccld_qty),
            price: parseFloat(o.avg_prvs),
            amount: parseFloat(o.tot_ccld_amt) || parseFloat(o.avg_prvs) * parseInt(o.tot_ccld_qty),
          }));
      }

      let buyRecords: RealtimeBuyRecordV2[] = state.buyRecords || [];
      let hadTrade = false;
      let totalRealizedProfit = state.totalRealizedProfit || 0;
      let totalBuyAmount = state.totalBuyAmount || 0;
      let totalSellAmount = state.totalSellAmount || 0;
      let maxRounds = state.maxRounds ?? splitCount;

      // 재시도 헬퍼: Firestore 상태 업데이트 (최대 2회, 500ms 간격)
      const retryStateUpdate = async (data: Record<string, unknown>, label: string): Promise<boolean> => {
        for (let attempt = 1; attempt <= 2; attempt++) {
          try {
            await stateRef.update(data);
            return true;
          } catch (err) {
            console.error(`[RealtimeDdsobV2:${tag}] ${label} attempt ${attempt}/2 failed:`, err);
            if (attempt < 2) await new Promise(r => setTimeout(r, 500));
          }
        }
        return false;
      };

      // FIFO 매도 체결 처리: 가장 오래된 buyRecord부터 순차 소진
      const consumeBuyRecordsFIFO = (filledQty: number, filledAmount: number): { consumedCost: number; consumedQty: number } => {
        let remainQty = filledQty;
        let consumedCost = 0;
        let consumedQty = 0;

        while (remainQty > 0 && buyRecords.length > 0) {
          const oldest = buyRecords[0];
          if (oldest.quantity <= remainQty) {
            // 전체 소진
            consumedCost += oldest.buyAmount;
            consumedQty += oldest.quantity;
            remainQty -= oldest.quantity;
            buyRecords.splice(0, 1);
          } else {
            // 부분 소진: 비례 차감
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
          // 매도 체결: FIFO로 buyRecords 소진
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

      // ======== 상태 저장 (재시도 포함) ========
      const fillStateData = {
        buyRecords,
        candlesSinceCycleStart: (state.candlesSinceCycleStart || 0) + 1,
        maxRounds,
        totalRealizedProfit,
        totalBuyAmount,
        totalSellAmount,
        lastOrderNumbers: [] as string[],
        lastSellInfo: [] as unknown[],
        lastOrderDate: '',
        pendingRsiData: undefined,
        updatedAt: new Date().toISOString(),
      };

      // 사이클 완료 체크
      if (buyRecords.length === 0 && hadTrade && filledOrders.some(f => f.sll_buy_dvsn_cd === '01')) {
        console.log(`[RealtimeDdsobV2:${tag}] Cycle completed for ${userId}/${accountId}/${ticker}`);

        // 1) 상태 업데이트 먼저 (critical: lastOrderNumbers 클리어 → 재처리 방지)
        const completedData = {
          ...fillStateData,
          candlesSinceCycleStart: 0,
          status: 'completed',
          indicators: undefined,
          completedAt: new Date().toISOString(),
        };
        const success = await retryStateUpdate(completedData, 'Cycle completion');
        if (!success) throw new Error('Cycle completion state update failed after retries');

        // 2) 사이클 이력 저장 (non-critical, 중복 방지 체크 포함)
        try {
          const existingCycle = await db.collection('users').doc(userId)
            .collection('cycleHistory')
            .where('ticker', '==', ticker)
            .where('strategy', '==', strategyId)
            .where('cycleNumber', '==', state.cycleNumber || 1)
            .limit(1)
            .get();

          if (existingCycle.empty) {
            await db.collection('users').doc(userId).collection('cycleHistory').add({
              ticker,
              market,
              strategy: strategyId,
              stockName: tickerConfig.stockName || ticker,
              cycleNumber: state.cycleNumber || 1,
              autoSelected: state.autoSelected || false,
              startedAt: state.startedAt,
              completedAt: new Date().toISOString(),
              principal: state.principal,
              splitCount,
              profitPercent,
              amountPerRound: state.amountPerRound,
              intervalMinutes,
              forceSellCandles: state.forceSellCandles || 0,
              minDropPercent: state.minDropPercent || 0,
              peakCheckCandles: state.peakCheckCandles ?? 0,
              bufferPercent: 0.01,
              autoStopLoss: state.autoStopLoss || false,
              stopLossPercent: state.stopLossPercent ?? -5,
              exhaustionStopLoss: state.exhaustionStopLoss || false,
              stopLossMultiplier: state.stopLossMultiplier ?? 3,
              exchangeCode: state.exchangeCode || '',
              selectionMode: state.selectionMode || '',
              conditionName: state.conditionName || '',
              totalBuyAmount,
              totalSellAmount,
              totalRealizedProfit,
              finalProfitRate: state.principal > 0 ? totalRealizedProfit / state.principal : 0,
              maxRoundsAtEnd: maxRounds,
              candlesSinceCycleStart: state.candlesSinceCycleStart || 0,
              totalForceSellCount: state.totalForceSellCount || 0,
              totalForceSellLoss: state.totalForceSellLoss || 0,
            });
          } else {
            console.log(`[RealtimeDdsobV2:${tag}] Cycle history already exists for cycle ${state.cycleNumber || 1}, skipping`);
          }
        } catch (histErr) {
          console.error(`[RealtimeDdsobV2:${tag}] Failed to save cycle history (non-critical):`, histErr);
        }

        // 사이클 완료 메시지는 장마감 요약에서 일괄 보고
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
        try { await stateRef.delete(); } catch (e) {
          console.warn(`[RealtimeDdsobV2:${tag}] stateRef.delete failed (will be handled on next tick):`, e);
        }

        // autoSelected 종목: 사이클 종료 시 config에서 제거 (빈 슬롯 → 다음 틱에서 재선택)
        if (tickerConfig.autoSelected) {
          try {
            const configRef = setMarketStrategyConfig_REF_PLACEHOLDER(db, userId, accountId, market, strategyId);
            const latestConfig = await configRef.get();
            if (latestConfig.exists) {
              const latestTickers = extractTickerConfigsV2(latestConfig.data()! as RealtimeDdsobV2Config);
              // autoSelected + ticker 일치하는 항목만 제거 (수동 종목 보호)
              const remaining = latestTickers.filter(t => !(t.ticker === ticker && t.autoSelected));
              await configRef.update({ tickers: remaining });
              console.log(`[RealtimeDdsobV2:${tag}] Removed completed autoSelected ticker ${ticker} from config (${latestTickers.length} → ${remaining.length})`);
            }
          } catch (e) {
            console.error(`[RealtimeDdsobV2:${tag}] Failed to remove ticker ${ticker} from config:`, e);
          }
          return; // 새 사이클 시작하지 않음
        }

        // config에서 제거된 종목(orphaned): 사이클 완료 후 새 사이클 시작하지 않음
        {
          const configRef = setMarketStrategyConfig_REF_PLACEHOLDER(db, userId, accountId, market, strategyId);
          const latestConfig = await configRef.get();
          if (latestConfig.exists) {
            const latestTickers = extractTickerConfigsV2(latestConfig.data()! as RealtimeDdsobV2Config);
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
        state = (await stateRef.get()).data()!;
      } else {
        // 체결 없음: lastOrderNumbers 클리어만 (실패해도 다음 틱에서 재시도)
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
          accessToken = await getOrRefreshToken(userId, accountId, credentials as { appKey: string; appSecret: string }, kisClient, true);
          // 체결확인 재시도 (간소화: 해외/국내 구분만)
          const queryStartDate = state!.lastOrderDate || todayStr;
          if (market === 'overseas') {
            const retryResp = await kisClient.getOrderHistory(
              credentials.appKey, credentials.appSecret, accessToken, credentials.accountNo,
              queryStartDate, todayStr, ticker, '00', '01'
            );
            if (retryResp.rt_cd !== '0') throw new Error(`Retry failed: ${retryResp.msg1}`);
            // 재시도 성공 시 전체 체결 처리 로직 건너뜀 (다음 틱에서 처리)
            console.log(`[RealtimeDdsobV2:${tag}] Token refreshed, will process fills next tick`);
          } else {
            const retryResp = await kisClient.getDomesticOrderHistory(
              credentials.appKey, credentials.appSecret, accessToken, credentials.accountNo,
              queryStartDate, todayStr, '01', '00', ticker
            );
            if (retryResp.rt_cd !== '0') throw new Error(`Retry failed: ${retryResp.msg1}`);
            console.log(`[RealtimeDdsobV2:${tag}] Token refreshed, will process fills next tick`);
          }
          // 토큰 갱신 성공 → fillCheckFailed 유지 (이번 틱은 체결 처리 스킵, 다음 틱에서 정상 처리)
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

  // 체결 체크 실패 시 새 주문 제출 금지 (lastOrderNumbers 덮어쓰기 방지)
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
        accessToken = await getOrRefreshToken(userId, accountId, credentials as { appKey: string; appSecret: string }, kisClient, true);
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
      // output2[0]이 가장 최근(현재 진행 중) 캔들, output2[1]이 직전 완성 캔들
      const prevBar = minuteData.output2?.[1];
      if (prevBar) {
        prevCandleClose = parseFloat(prevBar.last || '0');
      }
    } else {
      // 국내: 현재 시각 기준 조회 → output2[0]이 현재 캔들, [1]이 직전 캔들
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
        // config의 해당 ticker에 stockName 업데이트
        const strategyConfig = await getMarketStrategyConfig<RealtimeDdsobV2Config>(db, userId, accountId, market, strategyId);
        const tickers = strategyConfig?.tickers as RealtimeDdsobV2TickerConfig[] | undefined;
        if (tickers) {
          const updatedTickers = tickers.map(t =>
            t.ticker === ticker ? { ...t, stockName } : t
          );
          const configRef = setMarketStrategyConfig_REF_PLACEHOLDER(db, userId, accountId, market, strategyId);
          await configRef.update({
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
    // sell-only 모드에서는 새 사이클 시작 금지
    if (sellOnly) {
      console.log(`[RealtimeDdsobV2:${tag}] [SELL-ONLY] No active state for ${ticker}, skipping new cycle`);
      return;
    }
    // 원금: tickerConfig에서 설정된 금액 사용
    const principal = configPrincipal;
    const amountPerRound = principal / splitCount;

    // 이전 사이클 번호 조회
    const lastCycleSnap = await db.collection('users').doc(userId)
      .collection('cycleHistory')
      .where('ticker', '==', ticker)
      .where('strategy', '==', strategyId)
      .orderBy('completedAt', 'desc')
      .limit(1)
      .get();
    const lastCycleNumber = lastCycleSnap.empty ? 0 : (lastCycleSnap.docs[0].data().cycleNumber || 0);

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

    // EMA/RSI 지표 초기화 + 최근 캔들 가격 (과거 분봉 데이터 fetch)
    const { indicators, recentCloses1m } = await fetchIndicatorsAtStartup(
      kisClient, credentials.appKey, credentials.appSecret,
      accessToken, ticker, market, tag
    );
    state.indicators = indicators;
    const peakCandles = tickerConfig.peakCheckCandles ?? 10;
    state.recentPrices = peakCandles > 0 ? recentCloses1m.slice(-peakCandles) : [];

    await stateRef.set(state);
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

    // 새 사이클 생성 후 바로 아래 계산·매수 단계로 진행 (다음 트리거 대기 안 함)
  }

  // 완료 상태면 재시작 또는 종료
  if (state.status === 'completed') {
    if (stopAfterCycleEnd) {
      console.log(`[RealtimeDdsobV2:${tag}] Cycle completed, stopAfterCycleEnd=true`);
      return;
    }
    await stateRef.delete();
    console.log(`[RealtimeDdsobV2:${tag}] Auto-restart: deleted completed state`);
    return;
  }

  // ======== EMA/RSI 지표 갱신 (매 틱) ========
  if (state.indicators?.initialized) {
    updateIndicatorsOnTick(state.indicators, currentPrice, intervalMinutes);
    const ind = state.indicators;
    console.log(`[RealtimeDdsobV2:${tag}] ${ticker} indicators: EMA9(1m)=${ind.ema9_1m !== null ? (market === 'overseas' ? ind.ema9_1m.toFixed(2) : ind.ema9_1m.toFixed(0)) : 'N/A'} EMA20(5m)=${ind.ema20_5m !== null ? (market === 'overseas' ? ind.ema20_5m.toFixed(2) : ind.ema20_5m.toFixed(0)) : 'N/A'} RSI(1m)=${ind.rsi14_1m ?? 'N/A'} RSI(5m)=${ind.rsi14_5m ?? 'N/A'}`);
  }

  // ======== 2단계: 계산 ========
  const buyRecords: RealtimeBuyRecordV2[] = state.buyRecords || [];
  const isFirstBuy = buyRecords.length === 0;
  const previousPrice = (prevCandleClose && prevCandleClose > 0) ? prevCandleClose : (state.previousPrice || currentPrice);
  let maxRounds = state.maxRounds ?? splitCount;

  if (isFirstBuy && maxRounds < splitCount) {
    console.log(`[RealtimeDdsobV2:${tag}] Resetting maxRounds from ${maxRounds} to ${splitCount}`);
    maxRounds = splitCount;
    await stateRef.update({ maxRounds: splitCount });
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
        const holdingData = holdingsArray.find((h) => h.ovrs_pdno === ticker);
        if (holdingData) {
          kisAvgPrice = parseFloat(holdingData.pchs_avg_pric || '0');
          kisHoldingQty = parseInt(holdingData.ovrs_cblc_qty || '0');
        }
      } else {
        const balanceData = await kisClient.getDomesticBalance(
          credentials.appKey, credentials.appSecret, accessToken, credentials.accountNo
        );
        const holdingsArray = Array.isArray(balanceData.output1) ? balanceData.output1 : [];
        const holdingData = holdingsArray.find((h) => h.pdno === ticker);
        if (holdingData) {
          kisAvgPrice = parseFloat(holdingData.pchs_avg_pric || '0');
          kisHoldingQty = parseInt(holdingData.hldg_qty || '0');
        }
      }
      console.log(`[RealtimeDdsobV2:${tag}] KIS holdings: ${ticker} avgPrice=${fp(kisAvgPrice)}, qty=${kisHoldingQty}`);
    } catch (balanceErr) {
      if (isTokenExpiredError(balanceErr)) {
        accessToken = await getOrRefreshToken(userId, accountId, credentials as { appKey: string; appSecret: string }, kisClient, true);
        // 토큰 갱신 후 재시도
        try {
          if (market === 'overseas') {
            const balanceData = await kisClient.getBalance(
              credentials.appKey, credentials.appSecret, accessToken, credentials.accountNo
            );
            const holdingsArray = Array.isArray(balanceData.output1) ? balanceData.output1 : [];
            const holdingData = holdingsArray.find((h) => h.ovrs_pdno === ticker);
            if (holdingData) {
              kisAvgPrice = parseFloat(holdingData.pchs_avg_pric || '0');
              kisHoldingQty = parseInt(holdingData.ovrs_cblc_qty || '0');
            }
          } else {
            const balanceData = await kisClient.getDomesticBalance(
              credentials.appKey, credentials.appSecret, accessToken, credentials.accountNo
            );
            const holdingsArray = Array.isArray(balanceData.output1) ? balanceData.output1 : [];
            const holdingData = holdingsArray.find((h) => h.pdno === ticker);
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

  const equalAmountPerRound = state.amountPerRound || state.principal / splitCount;
  const effectiveAmountPerRound = tickerConfig.ascendingSplit
    ? getAscendingAmountForRound(state.principal, splitCount, buyRecords.length, currentPrice)
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
    candlesSinceCycleStart: state.candlesSinceCycleStart || 0,
    maxRounds,
    bufferPercent,
    kisAvgPrice,
    kisHoldingQty,
    tickSize: domesticTickSize,
    minDropPercent,
    recentPrices: state.recentPrices,
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
        holdUpdate.candlesSinceCycleStart = (state.candlesSinceCycleStart || 0) + 1;
      }
      if (state.indicators) {
        holdUpdate.indicators = state.indicators;
      }
      const holdPeakCandles = tickerConfig.peakCheckCandles ?? 10;
      if (holdPeakCandles > 0) {
        const holdRecentPrices = [...(state.recentPrices || []), currentPrice];
        if (holdRecentPrices.length > holdPeakCandles) {
          holdRecentPrices.splice(0, holdRecentPrices.length - holdPeakCandles);
        }
        holdUpdate.recentPrices = holdRecentPrices;
      }
      await stateRef.update(holdUpdate);
      return;
    }

    // ======== 1회분 매수금 부족 감지: 첫 매수인데 매수 주문 생성 불가 (수량 0) ========
    if (isFirstBuy && calcResult.buyOrders.length === 0 && calcResult.analysis.availableRounds > 0) {
      const amountPerRound = state.amountPerRound || state.principal / splitCount;
      console.log(`[RealtimeDdsobV2:${tag}] ${ticker} 1회분 매수금(${fp(amountPerRound)}) < 주가(${fp(currentPrice)}) → 매수 불가, 종목 제외`);

      if (buyRecords.length > 0) {
        // 보유량 있으면 전량 매도 후 사이클 종료
        const result = await forceStopRealtimeDdsobV2Ticker(userId, accountId, ticker, market, db, 'force_stop', strategyId);
        if (chatId) {
          await sendTelegramMessage(chatId,
            `⚠️ <b>매수금 부족 → 청산</b> [${tickerConfig.stockName || ticker}]\n\n` +
            `1회분 ${fp(amountPerRound)} < 주가 ${fp(currentPrice)}\n` +
            `${result.success ? `전량 매도 ${result.soldQty}주` : `매도 실패: ${result.message}`}`,
            'HTML'
          );
        }
      } else {
        // 보유량 없으면 state 삭제 + config에서 제거
        await stateRef.delete();
        if (tickerConfig.autoSelected) {
          const configRef = setMarketStrategyConfig_REF_PLACEHOLDER(db, userId, accountId, market, strategyId);
          const latestConfig = await configRef.get();
          if (latestConfig.exists) {
            const latestTickers = extractTickerConfigsV2(latestConfig.data()! as RealtimeDdsobV2Config);
            const remaining = latestTickers.filter(t => !(t.ticker === ticker && t.autoSelected));
            await configRef.update({ tickers: remaining });
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

    // ======== 첫 매수 타임아웃: autoSelected 종목에서 N캔들 이내 매수 미발생 시 종목 제외 ========
    if (isFirstBuy && tickerConfig.autoSelected) {
      const newCandlesBeforeFirstBuy = (state.candlesBeforeFirstBuy || 0) + 1;
      if (newCandlesBeforeFirstBuy >= FIRST_BUY_TIMEOUT_CANDLES) {
        console.log(`[RealtimeDdsobV2:${tag}] First buy timeout: ${ticker} no buy in ${newCandlesBeforeFirstBuy} candles (${newCandlesBeforeFirstBuy * intervalMinutes}min) → removing`);
        await stateRef.delete();
        const configRef = setMarketStrategyConfig_REF_PLACEHOLDER(db, userId, accountId, market, strategyId);
        const latestConfig = await configRef.get();
        if (latestConfig.exists) {
          const latestTickers = extractTickerConfigsV2(latestConfig.data()! as RealtimeDdsobV2Config);
          const remaining = latestTickers.filter(t => !(t.ticker === ticker && t.autoSelected));
          await configRef.update({ tickers: remaining });
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
      candlesSinceCycleStart: (state.candlesSinceCycleStart || 0) + (buyRecords.length > 0 ? 1 : 0),
      lastCheckedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    // 첫 매수 전 캔들 카운터 갱신
    if (isFirstBuy && tickerConfig.autoSelected) {
      holdUpdate.candlesBeforeFirstBuy = (state.candlesBeforeFirstBuy || 0) + 1;
    }
    if (state.indicators) {
      holdUpdate.indicators = state.indicators;
    }
    // recentPrices 갱신 (피크 체크용 — hold 시에도 현재가 추가 필수)
    const holdPeakCandles = tickerConfig.peakCheckCandles ?? 10;
    if (holdPeakCandles > 0) {
      const holdRecentPrices = [...(state.recentPrices || []), currentPrice];
      if (holdRecentPrices.length > holdPeakCandles) {
        holdRecentPrices.splice(0, holdRecentPrices.length - holdPeakCandles);
      }
      holdUpdate.recentPrices = holdRecentPrices;
    }
    await stateRef.update(holdUpdate);
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
    await stateRef.update(limitUpdate);
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
          accessToken = await getOrRefreshToken(userId, accountId, credentials as { appKey: string; appSecret: string }, kisClient, true);
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

  // 매수 차단: sell-only 모드에서만 적용
  const buyCutoff = sellOnly;

  // ======== RSI 선조회 (매수 주문 전) ========
  // autoSelected 종목은 일일 회전하여 RSI 수집 가치 낮음 → 스킵 (API 최대 8건 + 2400ms 절약)
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

  // ======== RSI 매수 필터 (임시 비활성화 — 1분봉 기반으로 재설계 필요) ========
  const rsiBlocked = false;

  // 자동선별 첫 매수는 RSI 필터 무시
  const forceFirstBuy = !sellOnly && isFirstBuy && tickerConfig.autoSelected === true;
  if (forceFirstBuy && rsiBlocked) {
    console.log(`[RealtimeDdsobV2:${tag}] Force first buy: ${ticker} skipping RSI filter (rsiBlocked=${rsiBlocked})`);
  }

  // 매수 주문 (컷오프 차단 시 항상 스킵, RSI 차단은 자동선별 첫 매수만 무시)
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
          accessToken = await getOrRefreshToken(userId, accountId, credentials as { appKey: string; appSecret: string }, kisClient, true);
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

  // RSI 데이터를 상태에 저장 (다음 틱 체결 확인 시 buyRecord에 첨부)
  if (pendingRsiData) {
    updateData.pendingRsiData = pendingRsiData;
  }

  // EMA/RSI 지표 상태 저장
  if (state.indicators) {
    updateData.indicators = state.indicators;
  }

  // recentPrices 갱신 (피크 체크용)
  const peakCandles = tickerConfig.peakCheckCandles ?? 10;
  if (peakCandles > 0) {
    const updatedRecentPrices = [...(state.recentPrices || []), currentPrice];
    if (updatedRecentPrices.length > peakCandles) {
      updatedRecentPrices.splice(0, updatedRecentPrices.length - peakCandles);
    }
    updateData.recentPrices = updatedRecentPrices;
  }

  // 사이클 시작 후 경과 캔들: 포지션 보유 중이면 항상 +1 (거래 발생 여부 무관)
  if (buyRecords.length > 0) {
    updateData.candlesSinceCycleStart = (state.candlesSinceCycleStart || 0) + 1;
  }

  // ======== 첫 매수 타임아웃: 매수 주문 미제출 시 (RSI/cutoff 차단 등) ========
  if (buyRecords.length === 0 && orderNumbers.length === 0 && tickerConfig.autoSelected) {
    const newCandlesBeforeFirstBuy = (state.candlesBeforeFirstBuy || 0) + 1;
    if (newCandlesBeforeFirstBuy >= FIRST_BUY_TIMEOUT_CANDLES) {
      console.log(`[RealtimeDdsobV2:${tag}] First buy timeout: ${ticker} no buy in ${newCandlesBeforeFirstBuy} candles (${newCandlesBeforeFirstBuy * intervalMinutes}min) → removing`);
      await stateRef.delete();
      const configRef2 = setMarketStrategyConfig_REF_PLACEHOLDER(db, userId, accountId, market, strategyId);
      const latestConfig2 = await configRef2.get();
      if (latestConfig2.exists) {
        const latestTickers = extractTickerConfigsV2(latestConfig2.data()! as RealtimeDdsobV2Config);
        const remaining = latestTickers.filter(t => !(t.ticker === ticker && t.autoSelected));
        await configRef2.update({ tickers: remaining });
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
    await stateRef.update(updateData);
  } catch (stateErr) {
    console.error(`[RealtimeDdsobV2:${tag}] State update failed, retrying critical fields:`, stateErr);
    try {
      // 최소한 주문번호는 반드시 저장 (다음 틱 체결 확인에 필수)
      await stateRef.update({
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
        const result = await forceStopRealtimeDdsobV2Ticker(userId, accountId, ticker, market, db, 'exhaustion_stop_loss', strategyId);

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

    // 강제매도 캔들: 첫 매수 이후 N캔들 경과 시 전량 매도
    if (forceSellCandles > 0 && !isFirstBuy) {
      const candles = state.candlesSinceCycleStart || 0;
      if (candles >= forceSellCandles) {
        console.log(`[RealtimeDdsobV2:${tag}] Force sell candles: ${ticker} ${candles} candles >= ${forceSellCandles} → full liquidation`);
        const result = await forceStopRealtimeDdsobV2Ticker(userId, accountId, ticker, market, db, 'force_sell_candles', strategyId);

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

// ==================== 인기종목 자동선별 ====================

interface AutoSelectConfig {
  principalMode: 'auto' | 'manual';
  principalPerTicker: number;
  stockCount: number;
  splitCount: number;
  profitPercent: number;
  forceSellCandles: number;
  intervalMinutes: number;
  selectionMode: 'mixed' | 'marketCapOnly' | 'volumeOnly' | 'sideways';
  maxStockPrice: number;
  // sideways 모드 설정
  htsUserId?: string;          // HTS ID (종목조건검색 API 필수)
  conditionName?: string;      // HTS에 등록한 조건명
  minMarketCap?: number;       // 최소 시가총액 (억원, 0 = 필터 없음)
  includeETF?: boolean;        // ETF 포함 여부 (기본: true)
  autoStopLoss?: boolean;      // 자동손절 (기본: false)
  stopLossPercent?: number;    // 손절 기준 % (기본: -5, 음수)
  exhaustionStopLoss?: boolean;  // 분할소진 손절 ON/OFF
  stopLossMultiplier?: number;   // TP 배수 (기본 3)
  minDropPercent?: number;     // 최소 낙폭 (0.002 = 0.2%)
  peakCheckCandles?: number;   // 피크 확인 캔들 수 (기본: 10, 0=비활성)
  spreadFilterEnabled?: boolean; // 스프레드 필터 ON/OFF (기본: true)
  ascendingSplit?: boolean;      // 급경사 점증 분할 (초반 소액, 후반 대량)
}

// 해외 인기종목 자동선별 설정
interface AutoSelectConfigUS {
  selectionMode?: 'tradingAmount';   // 선별 기준 (기본: tradingAmount)
  principalMode: 'auto' | 'manual';
  principalPerTicker: number;        // USD ($)
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
  peakCheckCandles?: number;   // 피크 확인 캔들 수 (기본: 10, 0=비활성)
}

// v2.1 자동선별 설정 (지표 기반 필터링 — 해외용)
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

// v2.1 config 인터페이스
interface RealtimeDdsobV2_1Config {
  tickers: RealtimeDdsobV2TickerConfig[];
  stopAfterCycleEnd: boolean;
  autoSelectEnabledUS?: boolean;
  autoSelectConfigUS?: AutoSelectConfigV2_1;
}

/**
 * v2.1 해외주식 지표 기반 필터
 * 후보 종목별 분봉 → EMA20/EMA5/이격도/RSI 순차 필터, 조기종료
 */
async function applyIndicatorFiltersUS(
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
      await new Promise(resolve => setTimeout(resolve, 300)); // KIS rate limit
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
        .reverse(); // oldest first

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

      console.log(`[V2.1:IndicatorFilter:US] #${rank} ${c.ticker} ($${c.price}, ${c.rate.toFixed(1)}%, 이격도${disparity.toFixed(1)}%): ✓ PASS [${passed.length + 1}/${targetCount}]`);
      passed.push(c);
    } catch (err) {
      console.warn(`[V2.1:IndicatorFilter:US] #${rank} ${c.ticker}: API에러 → SKIP`, err instanceof Error ? err.message : '');
    }
  }

  console.log(`[V2.1:IndicatorFilter:US] 결과: ${checked}개 체크 → ${passed.length}개 통과`);
  return passed;
}

/**
 * HTS 조건검색 목록 조회 (설정 페이지에서 조건명 드롭다운용)
 */
export const getConditionListV2 = onRequest(
  { cors: true },
  async (req, res) => {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    let decodedToken;
    try {
      decodedToken = await admin.auth().verifyIdToken(authHeader.split('Bearer ')[1]);
    } catch {
      res.status(401).json({ error: 'Invalid token' });
      return;
    }

    const userId = decodedToken.uid;
    const { accountId, htsUserId } = req.body || {};

    if (!accountId || typeof accountId !== 'string') {
      res.status(400).json({ success: false, message: 'accountId is required' });
      return;
    }
    if (!htsUserId || typeof htsUserId !== 'string') {
      res.status(400).json({ success: false, message: 'htsUserId is required' });
      return;
    }

    

    try {
      const credentialsDoc = await db.doc(`users/${userId}/accounts/${accountId}/credentials/main`).get();
      if (!credentialsDoc.exists) {
        res.status(404).json({ success: false, message: '계좌 인증정보를 찾을 수 없습니다' });
        return;
      }

      const credentials = credentialsDoc.data()!;
      const kisClient = new KisApiClient(false);
      const accessToken = await getOrRefreshToken(userId, accountId, credentials as { appKey: string; appSecret: string }, kisClient);

      const listResp = await kisClient.getConditionSearchList(
        credentials.appKey, credentials.appSecret, accessToken, htsUserId
      );

      if (listResp.rt_cd !== '0' || !listResp.output2) {
        res.json({ success: false, message: `조건 목록 조회 실패: ${listResp.msg1}` });
        return;
      }

      const conditions = listResp.output2.map(c => ({
        seq: c.seq,
        groupName: c.grp_nm,
        conditionName: c.condition_nm,
      }));

      res.json({ success: true, conditions });
    } catch (error) {
      console.error(`[getConditionList] Error - userId: ${userId}:`, error);
      res.status(500).json({
        success: false,
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }
);

/**
 * 수동 자동선별 트리거 (웹에서 매매활성화 ON 시 호출)
 * 9:10 자동선별을 놓쳤을 때 수동으로 종목선정을 실행
 */
export const triggerAutoSelectStocksV2 = onRequest(
  { cors: true, secrets: [telegramBotToken] },
  async (req, res) => {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const idToken = authHeader.split('Bearer ')[1];
    let decodedToken;
    try {
      decodedToken = { uid: config.userId }; // local: no auth
    } catch {
      res.status(401).json({ error: 'Invalid token' });
      return;
    }

    const userId = decodedToken.uid;
    const { accountId, market } = req.body || {};

    if (!accountId || typeof accountId !== 'string') {
      res.status(400).json({ error: 'accountId is required' });
      return;
    }

    const isUS = market === 'overseas';
    console.log(`[AutoSelect:Manual:${isUS ? 'US' : 'KR'}] userId: ${userId}, accountId: ${accountId}`);

    

    try {
      const commonConfig = await getCommonConfig(db, userId, accountId);
      if (!commonConfig) {
        res.status(404).json({ error: 'Trading config not found' });
        return;
      }

      const targetMarket: MarketType = isUS ? 'overseas' : 'domestic';
      const isV2Active = isMarketStrategyActive(commonConfig, targetMarket, 'realtimeDdsobV2');
      const isV2_1Active = isMarketStrategyActive(commonConfig, targetMarket, 'realtimeDdsobV2_1');
      if (!isV2Active && !isV2_1Active) {
        res.status(400).json({ error: 'realtimeDdsobV2/V2.1 전략이 아니거나 매매가 비활성화 상태입니다' });
        return;
      }

      if (isUS && isV2_1Active) {
        // v2.1 해외 자동선별 (지표 기반)
        const rdConfig = await getMarketStrategyConfig<RealtimeDdsobV2_1Config>(db, userId, accountId, targetMarket, 'realtimeDdsobV2_1');
        if (!rdConfig?.autoSelectEnabledUS) {
          res.status(400).json({ error: 'v2.1 해외 자동 종목선정이 비활성화 상태입니다' });
          return;
        }
        const autoConfigV2_1 = rdConfig.autoSelectConfigUS;
        if (!autoConfigV2_1) {
          res.status(400).json({ error: 'v2.1 해외 자동선별 설정이 없습니다' });
          return;
        }
        if (autoConfigV2_1.principalMode === 'manual' && !autoConfigV2_1.principalPerTicker) {
          res.status(400).json({ error: '종목당 투자금이 설정되지 않았습니다' });
          return;
        }
        await processAutoSelectStocksV2_1US(userId, accountId, autoConfigV2_1, rdConfig, db);
        res.json({ success: true, message: 'v2.1 해외 지표 자동선별이 완료되었습니다' });
        return;
      }

      const rdConfig = await getMarketStrategyConfig<RealtimeDdsobV2Config>(db, userId, accountId, targetMarket, 'realtimeDdsobV2');

      if (isUS) {
        // v2 해외 자동선별
        if (!rdConfig?.autoSelectEnabled) {
          res.status(400).json({ error: '해외 자동 종목선정이 비활성화 상태입니다' });
          return;
        }

        const autoConfigUS = rdConfig.autoSelectConfig as unknown as AutoSelectConfigUS;
        if (!autoConfigUS) {
          res.status(400).json({ error: '해외 자동선별 설정이 없습니다' });
          return;
        }

        if (autoConfigUS.principalMode === 'manual' && !autoConfigUS.principalPerTicker) {
          res.status(400).json({ error: '종목당 투자금이 설정되지 않았습니다' });
          return;
        }

        await processAutoSelectStocksUS(userId, accountId, autoConfigUS, rdConfig, db);

        res.json({
          success: true,
          message: '해외 자동 종목선정이 완료되었습니다',
        });
        return;
      }

      // 국내 자동선별 (기존 로직)
      if (!rdConfig?.autoSelectEnabled) {
        res.status(400).json({ error: '자동 종목선정이 비활성화 상태입니다' });
        return;
      }

      const autoConfig = rdConfig.autoSelectConfig as AutoSelectConfig;
      if (!autoConfig) {
        res.status(400).json({ error: '자동선별 설정이 없습니다' });
        return;
      }

      if (autoConfig.principalMode === 'manual' && !autoConfig.principalPerTicker) {
        res.status(400).json({ error: '종목당 투자금이 설정되지 않았습니다' });
        return;
      }

      await processAutoSelectStocks(userId, accountId, autoConfig, rdConfig, db);

      res.json({
        success: true,
        message: '자동 종목선정이 완료되었습니다',
      });
    } catch (error) {
      console.error(`[AutoSelect:Manual:${isUS ? 'US' : 'KR'}] Error - userId: ${userId}, accountId: ${accountId}:`, error);
      res.status(500).json({
        success: false,
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }
);

/**
 * 인기종목 자동선별 스케줄러
 * 매일 09:20 KST에 실행: 시총+거래량 상위 종목 선별 → 실사오팔v2 티커에 추가
 */
export const autoSelectTopStocksTriggerKRV2 = onSchedule(
  {
    schedule: '20 9 * * 1-5', // 월~금 09:20 KST
    timeZone: 'Asia/Seoul',
    secrets: [telegramBotToken],
  },
  async () => {
    console.log('[AutoSelect] Trigger started');

    
    const now = new Date();
    const kstTime = new Date(now.getTime() + 9 * 60 * 60 * 1000);

    // 휴장일 확인
    const holidayName = getKRMarketHolidayName(kstTime);
    if (holidayName) {
      console.log(`[AutoSelect] Holiday: ${holidayName}`);
      return;
    }

    try {
      const usersSnapshot = await db.collection('users').get();

      for (const userDoc of usersSnapshot.docs) {
        const userId = userDoc.id;
        const accountsSnapshot = await db.collection(`users/${userId}/accounts`).get();

        for (const accountDoc of accountsSnapshot.docs) {
          const accountId = accountDoc.id;
          const commonConfig = await getCommonConfig(db, userId, accountId);
          if (!commonConfig) continue;
          if (!isMarketStrategyActive(commonConfig, 'domestic', 'realtimeDdsobV2')) continue;

          const rdConfig = await getMarketStrategyConfig<RealtimeDdsobV2Config>(db, userId, accountId, 'domestic', 'realtimeDdsobV2');
          if (!rdConfig?.autoSelectEnabled) continue;

          const autoConfig = rdConfig.autoSelectConfig as AutoSelectConfig;
          if (!autoConfig) continue;
          if (autoConfig.principalMode === 'manual' && !autoConfig.principalPerTicker) continue;

          try {
            await processAutoSelectStocks(userId, accountId, autoConfig, rdConfig, db);
          } catch (err) {
            console.error(`[AutoSelect] Error ${userId}/${accountId}:`, err);
          }
          await new Promise(resolve => setTimeout(resolve, 500));
        }
      }

      console.log('[AutoSelect:KR] Trigger completed');
    } catch (error) {
      console.error('[AutoSelect:KR] Trigger error:', error);
    }
  }
);

/**
 * 실사오팔v2 해외 인기종목 자동선별 스케줄러
 * 미국 장 시작 직후 09:35 ET (월~금)
 */
export const autoSelectTopStocksTriggerUSV2 = onSchedule(
  {
    schedule: '35 9 * * 1-5', // 월~금 09:35 ET
    timeZone: 'America/New_York',
    secrets: [telegramBotToken],
  },
  async () => {
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
      const usersSnapshot = await db.collection('users').get();

      for (const userDoc of usersSnapshot.docs) {
        const userId = userDoc.id;
        const accountsSnapshot = await db.collection(`users/${userId}/accounts`).get();

        for (const accountDoc of accountsSnapshot.docs) {
          const accountId = accountDoc.id;
          const commonConfig = await getCommonConfig(db, userId, accountId);
          if (!commonConfig) continue;

          const isV2 = isMarketStrategyActive(commonConfig, 'overseas', 'realtimeDdsobV2');
          const isV2_1 = isMarketStrategyActive(commonConfig, 'overseas', 'realtimeDdsobV2_1');
          if (!isV2 && !isV2_1) continue;

          try {
            if (isV2_1) {
              // v2.1: 지표 기반 자동선별
              const rdConfig = await getMarketStrategyConfig<RealtimeDdsobV2_1Config>(db, userId, accountId, 'overseas', 'realtimeDdsobV2_1');
              if (!rdConfig?.autoSelectEnabledUS) continue;
              const autoConfigV2_1 = rdConfig.autoSelectConfigUS;
              if (!autoConfigV2_1) continue;
              if (autoConfigV2_1.principalMode === 'manual' && !autoConfigV2_1.principalPerTicker) continue;
              await processAutoSelectStocksV2_1US(userId, accountId, autoConfigV2_1, rdConfig, db);
            } else {
              // v2: 기존 거래대금 순위 기반
              const rdConfig = await getMarketStrategyConfig<RealtimeDdsobV2Config>(db, userId, accountId, 'overseas', 'realtimeDdsobV2');
              if (!rdConfig?.autoSelectEnabled) continue;
              const autoConfigUS = rdConfig.autoSelectConfig as unknown as AutoSelectConfigUS;
              if (!autoConfigUS) continue;
              if (autoConfigUS.principalMode === 'manual' && !autoConfigUS.principalPerTicker) continue;
              await processAutoSelectStocksUS(userId, accountId, autoConfigUS, rdConfig, db);
            }
          } catch (err) {
            console.error(`[AutoSelect:US] Error ${userId}/${accountId}:`, err);
          }
          await new Promise(resolve => setTimeout(resolve, 500));
        }
      }

      console.log('[AutoSelect:US] Trigger completed');
    } catch (error) {
      console.error('[AutoSelect:US] Trigger error:', error);
    }
  }
);

/**
 * 자동선별 종목 처리 함수 (국내)
 */
async function processAutoSelectStocks(
  userId: string,
  accountId: string,
  autoConfig: AutoSelectConfig,
  rdConfig: Record<string, unknown>,
  
  options?: { mode?: 'full' | 'refill' }
): Promise<RealtimeDdsobV2TickerConfig[]> {
  const mode = options?.mode || 'full';
  const { stockCount, splitCount, selectionMode, maxStockPrice, principalMode } = autoConfig;
  const includeETF = autoConfig.includeETF !== false; // 기본: true

  const ETF_KEYWORDS = ['KODEX', 'TIGER', 'KBSTAR', 'ARIRANG', 'HANARO', 'SOL', 'KOSEF', 'ACE', 'PLUS'];
  const isETF = (name: string) => ETF_KEYWORDS.some(kw => name.toUpperCase().includes(kw));

  console.log(`[AutoSelect] Processing ${userId}/${accountId}: mode=${selectionMode}, count=${stockCount}, principalMode=${principalMode}, includeETF=${includeETF}`);

  // 자격증명 & 토큰
  const credentialsDoc = await db.doc(`users/${userId}/accounts/${accountId}/credentials/main`).get();
  if (!credentialsDoc.exists) {
    console.log(`[AutoSelect] No credentials for ${userId}/${accountId}`);
    return [];
  }
  const credentials = credentialsDoc.data()!;
  const kisClient = new KisApiClient(false);
  let accessToken = await getOrRefreshToken(userId, accountId, credentials as { appKey: string; appSecret: string }, kisClient);

  // 기존 종목 확인 (중복 방지 + 빈 슬롯 계산)
  const existingTickers = extractTickerConfigsV2(rdConfig);
  const manualTickers = new Set(existingTickers.filter(t => !t.autoSelected).map(t => t.ticker));
  const existingAutoTickers = existingTickers.filter(t => t.autoSelected && t.market === 'domestic');
  const excludeTickers = new Set([...manualTickers, ...(mode === 'refill' ? existingAutoTickers.map(t => t.ticker) : [])]);
  const slotsToFill = mode === 'refill' ? stockCount - existingAutoTickers.length : stockCount;

  if (slotsToFill <= 0) {
    console.log(`[AutoSelect] No empty slots to fill (mode=${mode}, existing=${existingAutoTickers.length}, target=${stockCount})`);
    return [];
  }

  console.log(`[AutoSelect] mode=${mode}, slotsToFill=${slotsToFill}, excludeTickers=${[...excludeTickers].join(',')}`);

  // 투자원금 결정 — 예수금 조회는 auto/manual 공통 (manual도 예수금 상한 체크 필요)
  let principalPerTicker: number;

  let balanceResp;
  try {
    balanceResp = await kisClient.getDomesticBalance(
      credentials.appKey, credentials.appSecret, accessToken, credentials.accountNo
    );
  } catch (err) {
    if (isTokenExpiredError(err)) {
      console.log(`[AutoSelect] Token expired, refreshing and retrying...`);
      accessToken = await getOrRefreshToken(userId, accountId, credentials as { appKey: string; appSecret: string }, kisClient, true);
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
    console.log(`[AutoSelect] No available cash for ${userId}/${accountId}`);
    return [];
  }

  // 수동 종목 원금 합산 (국내주식만 — 해외주식 달러 예수금은 별개)
  const manualPrincipalSum = existingTickers
    .filter(t => !t.autoSelected && t.market !== 'overseas')
    .reduce((sum, t) => sum + (t.principal || 0), 0);

  // refill 모드: 진행중인 auto 종목의 남은 현금 계산 (state에서 조회)
  let activeAutoCashReserved = 0;
  if (mode === 'refill' && existingAutoTickers.length > 0) {
    const statePromises = existingAutoTickers.map(t =>
      db.doc(`users/${userId}/accounts/${accountId}/realtimeDdsobV2State/${t.ticker}`).get()
    );
    const stateDocs = await Promise.all(statePromises);
    for (let i = 0; i < existingAutoTickers.length; i++) {
      if (stateDocs[i].exists) {
        const d = stateDocs[i].data()!;
        const reserved = (d.principal || 0) - (d.totalBuyAmount || 0) + (d.totalSellAmount || 0);
        activeAutoCashReserved += Math.max(0, reserved);
      } else {
        // state 아직 없음 → 전체 원금이 현금으로 잡혀있음
        activeAutoCashReserved += existingAutoTickers[i].principal || 0;
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
    console.log(`[AutoSelect] principalPerTicker is 0 for ${userId}/${accountId}`);
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

    // 1. 조건 목록 조회 → conditionName으로 seq 찾기
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
      const chatId = await getUserTelegramChatId(userId);
      if (chatId) {
        await sendTelegramMessage(chatId,
          `⚠️ <b>조건검색 실패</b>\n\n조건명 '${conditionName}'을 찾을 수 없습니다.\nHTS에서 조건명을 확인하세요.\n\n사용 가능: ${available || '(없음)'}`
        );
      }
      return [];
    }

    console.log(`[AutoSelect] Found condition '${conditionName}' with seq=${matchedCondition.seq}`);
    await new Promise(resolve => setTimeout(resolve, 300));

    // 2. 조건검색 실행
    const searchResp = await kisClient.getConditionSearchResult(
      credentials.appKey, credentials.appSecret, accessToken, htsUserId, matchedCondition.seq
    );

    // rt_cd:"1" + MCA05918 = 결과 0건 (정상 동작)
    if (searchResp.rt_cd === '1' && searchResp.msg_cd === 'MCA05918') {
      console.log(`[AutoSelect] Condition search returned 0 results`);
      if (mode === 'full') {
        const chatId = await getUserTelegramChatId(userId);
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

    // 3. 파싱, 필터 (조건검색 결과 순서 유지)
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
    const MIN_CHANGE_RATE = -2; // 전일 대비 -2% 이하 종목 제외
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
          marketCap: parseInt(item.lstn_stcn) * parseInt(item.stck_prpr), // 시총 = 상장주수 × 현재가
        }));
      }
      console.log(`[AutoSelect] Volume: ${volumeStocks.length} stocks`);
    }

    if (selectionMode === 'mixed') {
      // 거래량 상위 종목 중 시총 높은 순으로 선별
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
    console.log(`[AutoSelect] No stocks selected for ${userId}/${accountId} (all filtered by price limit ${priceLimit})`);
    return [];
  }

  // config 업데이트: full 모드는 국내 autoSelected만 교체, 해외 autoSelected + 수동 종목은 유지
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

  // 방어: 국내 autoSelected 종목 수가 stockCount를 초과하지 않도록 검증
  const autoInUpdated = updatedTickers.filter(t => t.autoSelected && t.market === 'domestic');
  if (autoInUpdated.length > stockCount) {
    console.warn(`[AutoSelect] Auto count ${autoInUpdated.length} exceeds stockCount ${stockCount}, truncating`);
    const nonDomesticAuto = updatedTickers.filter(t => !(t.autoSelected && t.market === 'domestic'));
    updatedTickers = [...nonDomesticAuto, ...autoInUpdated.slice(0, stockCount)];
  }

  // 동시 실행 방어: write 직전 최신 config에서 국내 auto 수 재확인
  const freshStrategyConfig = await getMarketStrategyConfig<RealtimeDdsobV2Config>(db, userId, accountId, 'domestic', 'realtimeDdsobV2');
  if (freshStrategyConfig && mode === 'refill') {
    const freshTickers = extractTickerConfigsV2(freshStrategyConfig);
    const freshAutoCount = freshTickers.filter(t => t.autoSelected && t.market === 'domestic').length;
    if (freshAutoCount >= stockCount) {
      console.log(`[AutoSelect] Concurrent refill detected: already ${freshAutoCount} auto stocks (target=${stockCount}), skipping write`);
      return [];
    }
  }

  const configRef = setMarketStrategyConfig_REF_PLACEHOLDER(db, userId, accountId, 'domestic', 'realtimeDdsobV2');
  await configRef.update({
    tickers: updatedTickers,
  });

  const selectedNames = selected.map((s, i) => `${i + 1}. ${s.name}(${s.ticker}) ${s.price.toLocaleString()}원`).join('\n');
  console.log(`[AutoSelect] ${mode === 'refill' ? 'Refill' : 'Selected'} ${selected.length} stocks for ${userId}/${accountId}:\n${selectedNames}`);

  return newAutoTickers;
}

/**
 * 해외 인기종목 자동선별 (API 기반 종목 선별 → 티커 생성)
 * - full: 기존 autoSelected 전체 교체
 * - refill: 빈 슬롯만 채움
 */
async function processAutoSelectStocksUS(
  userId: string,
  accountId: string,
  autoConfigUS: AutoSelectConfigUS,
  rdConfig: Record<string, unknown>,
  
  options?: { mode?: 'full' | 'refill' }
): Promise<RealtimeDdsobV2TickerConfig[]> {
  const mode = options?.mode || 'full';
  const { stockCount, principalMode } = autoConfigUS;

  console.log(`[AutoSelect:US] Processing ${userId}/${accountId}: mode=${mode}, count=${stockCount}, principalMode=${principalMode}`);

  // 자격증명 & 토큰
  const credentialsDoc = await db.doc(`users/${userId}/accounts/${accountId}/credentials/main`).get();
  if (!credentialsDoc.exists) {
    console.log(`[AutoSelect:US] No credentials for ${userId}/${accountId}`);
    return [];
  }
  const credentials = credentialsDoc.data()!;
  const kisClient = new KisApiClient(false);
  let accessToken = await getOrRefreshToken(userId, accountId, credentials as { appKey: string; appSecret: string }, kisClient);

  // 기존 종목 확인 (중복 방지)
  const existingTickers = extractTickerConfigsV2(rdConfig);
  const manualTickers = new Set(existingTickers.filter((t: RealtimeDdsobV2TickerConfig) => !t.autoSelected && t.market === 'overseas').map((t: RealtimeDdsobV2TickerConfig) => t.ticker));
  const existingAutoTickers = existingTickers.filter((t: RealtimeDdsobV2TickerConfig) => t.autoSelected && t.market === 'overseas');
  const excludeTickers = new Set([...manualTickers, ...(mode === 'refill' ? existingAutoTickers.map(t => t.ticker) : [])]);

  // refill 모드: 빈 슬롯 수만큼만 선택
  const slotsToFill = mode === 'refill' ? stockCount - existingAutoTickers.length : stockCount;

  if (slotsToFill <= 0) {
    console.log(`[AutoSelect:US] No empty slots to fill (mode=${mode}, existing=${existingAutoTickers.length}, target=${stockCount})`);
    return [];
  }

  console.log(`[AutoSelect:US] mode=${mode}, slotsToFill=${slotsToFill}, excludeTickers=${[...excludeTickers].join(',')}`);

  // ====== 종목 선별: 해외주식 거래대금순위 API 기반 ======
  const MIN_CHANGE_RATE = 0; // 등락률 0% 미만(하락 종목) 제외
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
        accessToken = await getOrRefreshToken(userId, accountId, credentials as { appKey: string; appSecret: string }, kisClient, true);
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

  // 투자원금 결정 — 예수금 조회는 auto/manual 공통 (manual도 예수금 상한 체크 필요)
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
      accessToken = await getOrRefreshToken(userId, accountId, credentials as { appKey: string; appSecret: string }, kisClient, true);
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
    console.log(`[AutoSelect:US] No available USD cash for ${userId}/${accountId}`);
    return [];
  }

  const manualPrincipalSum = existingTickers
    .filter((t: RealtimeDdsobV2TickerConfig) => !t.autoSelected && t.market === 'overseas')
    .reduce((sum: number, t: RealtimeDdsobV2TickerConfig) => sum + (t.principal || 0), 0);

  // refill 모드: 진행중인 auto 종목의 남은 현금 계산 (state에서 조회)
  let activeAutoCashReserved = 0;
  if (mode === 'refill' && existingAutoTickers.length > 0) {
    const statePromises = existingAutoTickers.map(t =>
      db.doc(`users/${userId}/accounts/${accountId}/realtimeDdsobV2State/${t.ticker}`).get()
    );
    const stateDocs = await Promise.all(statePromises);
    for (let i = 0; i < existingAutoTickers.length; i++) {
      if (stateDocs[i].exists) {
        const d = stateDocs[i].data()!;
        const reserved = (d.principal || 0) - (d.totalBuyAmount || 0) + (d.totalSellAmount || 0);
        activeAutoCashReserved += Math.max(0, reserved);
      } else {
        activeAutoCashReserved += existingAutoTickers[i].principal || 0;
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
    console.log(`[AutoSelect:US] principalPerTicker is 0 for ${userId}/${accountId}`);
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
    console.log(`[AutoSelect:US] No stocks selected for ${userId}/${accountId}`);
    return [];
  }
  // ====== 종목 선별 끝 ======

  // config 업데이트: ticker config 생성
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
    exchangeCode: s.excd,  // 거래소 코드 (NAS/NYS/AMS) 저장
    ...(autoConfigUS.exhaustionStopLoss !== undefined && { exhaustionStopLoss: autoConfigUS.exhaustionStopLoss }),
    ...(autoConfigUS.stopLossMultiplier !== undefined && { stopLossMultiplier: autoConfigUS.stopLossMultiplier }),
    ...(autoConfigUS.minDropPercent !== undefined && { minDropPercent: autoConfigUS.minDropPercent }),
    ...(autoConfigUS.peakCheckCandles !== undefined && { peakCheckCandles: autoConfigUS.peakCheckCandles }),
    selectionMode: autoConfigUS.selectionMode || 'tradingAmount',
  }));

  let updatedTickers = mode === 'refill'
    ? [...manualTickerConfigs, ...existingAutoTickers, ...newAutoTickers]
    : [...manualTickerConfigs, ...newAutoTickers];

  // 방어: US autoSelected 종목 수가 stockCount를 초과하지 않도록 검증
  const autoInUpdated = updatedTickers.filter(t => t.autoSelected && t.market === 'overseas');
  if (autoInUpdated.length > stockCount) {
    console.warn(`[AutoSelect:US] Auto count ${autoInUpdated.length} exceeds stockCount ${stockCount}, truncating`);
    const nonAutoUS = updatedTickers.filter(t => !(t.autoSelected && t.market === 'overseas'));
    updatedTickers = [...nonAutoUS, ...autoInUpdated.slice(0, stockCount)];
  }

  // 동시 실행 방어: write 직전 최신 config에서 US auto 수 재확인
  if (mode === 'refill') {
    const freshStrategyConfig = await getMarketStrategyConfig<RealtimeDdsobV2Config>(db, userId, accountId, 'overseas', 'realtimeDdsobV2');
    if (freshStrategyConfig) {
      const freshTickers = extractTickerConfigsV2(freshStrategyConfig);
      const freshAutoCount = freshTickers.filter(t => t.autoSelected && t.market === 'overseas').length;
      if (freshAutoCount >= stockCount) {
        console.log(`[AutoSelect:US] Concurrent refill detected: already ${freshAutoCount} US auto stocks (target=${stockCount}), skipping write`);
        return [];
      }
    }
  }

  const configRef = setMarketStrategyConfig_REF_PLACEHOLDER(db, userId, accountId, 'overseas', 'realtimeDdsobV2');
  await configRef.update({
    tickers: updatedTickers,
  });

  const selectedNames = selected.map((s, i) => `${i + 1}. ${s.name}(${s.ticker}) $${principalPerTicker}`).join('\n');
  console.log(`[AutoSelect:US] ${mode === 'refill' ? 'Refill' : 'Selected'} ${selected.length} stocks for ${userId}/${accountId}:\n${selectedNames}`);

  return newAutoTickers;
}

/**
 * v2.1 해외 인기종목 자동선별 (지표 기반 필터링)
 * 거래대금 순위 → 가격/등락률 필터 → EMA/RSI 지표 필터
 */
async function processAutoSelectStocksV2_1US(
  userId: string,
  accountId: string,
  autoConfig: AutoSelectConfigV2_1,
  rdConfig: Record<string, unknown>,
  
  options?: { mode?: 'full' | 'refill' }
): Promise<RealtimeDdsobV2TickerConfig[]> {
  const mode = options?.mode || 'full';
  const { stockCount, principalMode } = autoConfig;

  console.log(`[AutoSelect:V2.1:US] Processing ${userId}/${accountId}: mode=${mode}, count=${stockCount}, principalMode=${principalMode}`);

  // 자격증명 & 토큰
  const credentialsDoc = await db.doc(`users/${userId}/accounts/${accountId}/credentials/main`).get();
  if (!credentialsDoc.exists) {
    console.log(`[AutoSelect:V2.1:US] No credentials for ${userId}/${accountId}`);
    return [];
  }
  const credentials = credentialsDoc.data()!;
  const kisClient = new KisApiClient(false);
  let accessToken = await getOrRefreshToken(userId, accountId, credentials as { appKey: string; appSecret: string }, kisClient);

  // 기존 종목 확인 (중복 방지)
  const existingTickers = extractTickerConfigsV2(rdConfig);
  const manualTickers = new Set(existingTickers.filter((t: RealtimeDdsobV2TickerConfig) => !t.autoSelected && t.market === 'overseas').map((t: RealtimeDdsobV2TickerConfig) => t.ticker));
  const existingAutoTickers = existingTickers.filter((t: RealtimeDdsobV2TickerConfig) => t.autoSelected && t.market === 'overseas');
  const excludeTickers = new Set([...manualTickers, ...(mode === 'refill' ? existingAutoTickers.map(t => t.ticker) : [])]);

  const slotsToFill = mode === 'refill' ? stockCount - existingAutoTickers.length : stockCount;
  if (slotsToFill <= 0) {
    console.log(`[AutoSelect:V2.1:US] No empty slots to fill`);
    return [];
  }

  console.log(`[AutoSelect:V2.1:US] mode=${mode}, slotsToFill=${slotsToFill}, excludeTickers=${[...excludeTickers].join(',')}`);

  // ====== 1단계: 거래대금 순위 조회 (NAS/NYS/AMS) ======
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
        accessToken = await getOrRefreshToken(userId, accountId, credentials as { appKey: string; appSecret: string }, kisClient, true);
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

  // ====== 투자원금 결정 ======
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
      accessToken = await getOrRefreshToken(userId, accountId, credentials as { appKey: string; appSecret: string }, kisClient, true);
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
    console.log(`[AutoSelect:V2.1:US] No available USD cash for ${userId}/${accountId}`);
    return [];
  }

  const manualPrincipalSum = existingTickers
    .filter((t: RealtimeDdsobV2TickerConfig) => !t.autoSelected && t.market === 'overseas')
    .reduce((sum: number, t: RealtimeDdsobV2TickerConfig) => sum + (t.principal || 0), 0);

  let activeAutoCashReserved = 0;
  if (mode === 'refill' && existingAutoTickers.length > 0) {
    const statePromises = existingAutoTickers.map(t =>
      db.doc(`users/${userId}/accounts/${accountId}/realtimeDdsobV2State/${t.ticker}`).get()
    );
    const stateDocs = await Promise.all(statePromises);
    for (let i = 0; i < existingAutoTickers.length; i++) {
      if (stateDocs[i].exists) {
        const d = stateDocs[i].data()!;
        const reserved = (d.principal || 0) - (d.totalBuyAmount || 0) + (d.totalSellAmount || 0);
        activeAutoCashReserved += Math.max(0, reserved);
      } else {
        activeAutoCashReserved += existingAutoTickers[i].principal || 0;
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

  // ====== 2단계: 가격/등락률 기본 필터 ======
  const basicFiltered = allStocks
    .filter(s => s.price > 0)
    .filter(s => s.price <= amountPerRound) // 1회차 매수금액 이내
    .filter(s => s.price >= priceMin && s.price <= priceMax)
    .filter(s => s.rate >= changeRateMin && s.rate <= changeRateMax)
    .filter(s => !excludeTickers.has(s.ticker))
    .sort((a, b) => b.tamt - a.tamt); // 거래대금 내림차순

  console.log(`[AutoSelect:V2.1:US] ${allStocks.length} total → ${basicFiltered.length} after basic filters (price $${priceMin}~$${priceMax}, rate ${changeRateMin}~${changeRateMax}%)`);

  // ====== 3단계: 지표 필터 (EMA/RSI) ======
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
    console.log(`[AutoSelect:V2.1:US] No stocks selected for ${userId}/${accountId}`);
    return [];
  }

  // ====== config 업데이트 ======
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
    const freshConfig = await getMarketStrategyConfig<RealtimeDdsobV2_1Config>(db, userId, accountId, 'overseas', 'realtimeDdsobV2_1');
    if (freshConfig) {
      const freshTickers = extractTickerConfigsV2(freshConfig);
      const freshAutoCount = freshTickers.filter(t => t.autoSelected && t.market === 'overseas').length;
      if (freshAutoCount >= stockCount) {
        console.log(`[AutoSelect:V2.1:US] Concurrent refill detected, skipping write`);
        return [];
      }
    }
  }

  const configRef = setMarketStrategyConfig_REF_PLACEHOLDER(db, userId, accountId, 'overseas', 'realtimeDdsobV2_1');
  await configRef.update({
    tickers: updatedTickers,
  });

  const selectedNames = selected.map((s, i) => `${i + 1}. ${s.name}(${s.ticker}) $${principalPerTicker}`).join('\n');
  console.log(`[AutoSelect:V2.1:US] ${mode === 'refill' ? 'Refill' : 'Selected'} ${selected.length} stocks:\n${selectedNames}`);

  return newAutoTickers;
}

/**
 * 장마감 EOD 매도 처리 (autoSelected + forceLiquidateAtClose 통합)
 * KR: realtimeTradingTriggerKR에서 15:15 KST에 호출
 * US: realtimeTradingTriggerUS에서 15:45 ET에 호출
 */
async function processAutoSelectEOD(
  userId: string,
  accountId: string,
  eodTickers: RealtimeDdsobV2TickerConfig[],
  rdConfig: Record<string, unknown>,
  
  market: MarketType = 'domestic',
  strategyId: AccountStrategy = 'realtimeDdsobV2'
): Promise<void> {
  const tag = market === 'domestic' ? 'KR' : 'US';
  console.log(`[EOD:${tag}] Processing ${userId}/${accountId}: ${eodTickers.length} tickers`);

  const credentialsDoc = await db.doc(`users/${userId}/accounts/${accountId}/credentials/main`).get();
  if (!credentialsDoc.exists) return;
  const credentials = credentialsDoc.data()!;
  const kisClient = new KisApiClient(false);
  let accessToken = await getOrRefreshToken(userId, accountId, credentials as { appKey: string; appSecret: string }, kisClient);
  const chatId = await getUserTelegramChatId(userId);
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

    // 해외 거래소 코드: tickerConfig에 저장된 값 우선, 없으면 ticker 기반 자동 판별
    const eodQuoteExcd = tc.exchangeCode;
    const eodOrderExcd = eodQuoteExcd ? KisApiClient.quoteToOrderExchangeCode(eodQuoteExcd) : KisApiClient.getExchangeCode(ticker);

    try {
      // 1. 상태 조회
      const stateRef = db.doc(`users/${userId}/accounts/${accountId}/realtimeDdsobV2State/${ticker}`);
      const stateDoc = await stateRef.get();
      if (!stateDoc.exists) continue;

      const state = stateDoc.data()!;
      const buyRecords = state.buyRecords || [];
      if (buyRecords.length === 0) {
        await stateRef.delete();
        continue;
      }

      const totalQty = buyRecords.reduce((sum: number, br: { quantity: number }) => sum + br.quantity, 0);
      const totalBuyAmount = buyRecords.reduce((sum: number, br: { buyAmount: number }) => sum + br.buyAmount, 0);

      // 2. [해외] 이전 EOD 매도 체결 확인 (재시도 시)
      if (market === 'overseas' && state.eodSellPending && state.eodSellOrderNo) {
        const eodHistResp = await kisClient.getOrderHistory(
          credentials.appKey, credentials.appSecret, accessToken, credentials.accountNo,
          state.eodSellDate || todayET, todayET, ticker, '00', '01'
        );
        const eodFilled = (eodHistResp.output || []).find(
          (o: { odno: string; ft_ccld_qty: string }) => o.odno === state.eodSellOrderNo && parseInt(o.ft_ccld_qty) > 0
        );

        if (eodFilled) {
          // 체결 확인 → cycleHistory 기록 + state 삭제
          const filledQty = parseInt(eodFilled.ft_ccld_qty);
          const filledPrice = parseFloat(eodFilled.ft_ccld_unpr3);
          const filledAmount = parseFloat(eodFilled.ft_ccld_amt3) || filledPrice * filledQty;
          const actualProfit = (state.totalRealizedProfit || 0) + (filledAmount - totalBuyAmount);

          console.log(`[EOD:${tag}] ${ticker} EOD sell confirmed: ${filledQty}주 @ $${filledPrice} (ODNO=${state.eodSellOrderNo})`);

          await db.collection('users').doc(userId).collection('cycleHistory').add({
            ticker, market, strategy: strategyId,
            stockName: tc.stockName || ticker,
            cycleNumber: state.cycleNumber || 1,
            autoSelected: isAutoSelected, dailyCycle: true,
            eodAction: isAutoSelected ? 'market_sell' : 'manual_eod_sell',
            startedAt: state.startedAt,
            completedAt: new Date().toISOString(),
            principal: tc.principal, splitCount: tc.splitCount, profitPercent: tc.profitPercent,
            amountPerRound: state.amountPerRound,
            forceSellCandles: tc.forceSellCandles, intervalMinutes: tc.intervalMinutes,
            minDropPercent: state.minDropPercent || 0,
            peakCheckCandles: state.peakCheckCandles ?? 0,
            bufferPercent: 0.01,
            autoStopLoss: state.autoStopLoss || false,
            stopLossPercent: state.stopLossPercent ?? -5,
            exhaustionStopLoss: state.exhaustionStopLoss || false,
            stopLossMultiplier: state.stopLossMultiplier ?? 3,
            exchangeCode: state.exchangeCode || '',
            selectionMode: state.selectionMode || '',
            conditionName: state.conditionName || '',
            totalBuyAmount: state.totalBuyAmount || 0,
            totalSellAmount: (state.totalSellAmount || 0) + filledAmount,
            totalRealizedProfit: actualProfit,
            finalProfitRate: tc.principal > 0 ? actualProfit / tc.principal : 0,
            maxRoundsAtEnd: state.maxRounds || tc.splitCount,
            totalForceSellCount: state.totalForceSellCount || 0,
            totalForceSellLoss: state.totalForceSellLoss || 0,
            eodSoldQuantity: filledQty,
            candlesSinceCycleStart: state.candlesSinceCycleStart || 0,
          });

          eodResults.push({ ticker, name: tc.stockName || ticker, soldQty: filledQty, profit: actualProfit, isAutoSelected });
          await stateRef.delete();
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
        // 해외: 현재가 조회 후 LIMIT 매도 (5% 버퍼로 체결 확보)
        const priceData = await kisClient.getCurrentPrice(
          credentials.appKey, credentials.appSecret, accessToken, ticker, eodQuoteExcd
        );
        const currentPrice = parseFloat(priceData.output?.last || '0');
        if (currentPrice <= 0) {
          console.error(`[EOD:${tag}] Price fetch failed for ${ticker}`);
          continue;
        }
        const sellPrice = Math.round(currentPrice * 0.95 * 100) / 100; // 5% 버퍼 (소수점 2자리)
        console.log(`[EOD:${tag}] ${ticker} currentPrice=$${currentPrice} → sellPrice=$${sellPrice} (5% buffer)`);
        sellResult = await kisClient.submitOrder(
          credentials.appKey, credentials.appSecret, accessToken, credentials.accountNo,
          { ticker, side: 'SELL', orderType: 'LIMIT', price: sellPrice, quantity: totalQty, exchange: eodOrderExcd }
        );
      } else {
        // 국내: 시장가 매도
        sellResult = await kisClient.submitDomesticOrder(
          credentials.appKey, credentials.appSecret, accessToken, credentials.accountNo,
          { ticker, side: 'SELL', orderType: 'MARKET', price: 0, quantity: totalQty }
        );
      }

      if (sellResult.rt_cd !== '0') {
        console.error(`[EOD:${tag}] Sell failed for ${ticker}: ${sellResult.msg1} | accountId=${accountId} accountNo=${credentials.accountNo} appKey=${credentials.appKey?.slice(0, 8)}...`);
        continue;
      }

      if (market === 'overseas') {
        // 해외 LIMIT: 체결 확인 전까지 state 유지 (다음 틱에서 체결 확인)
        await stateRef.update({
          eodSellPending: true,
          eodSellOrderNo: sellResult.output?.ODNO || '',
          eodSellDate: todayET,
        });
        console.log(`[EOD:${tag}] ${ticker} sell submitted ODNO=${sellResult.output?.ODNO}, awaiting fill confirmation`);

        const estimatedSellPrice = state.previousPrice || 0;
        const estimatedProfit = (state.totalRealizedProfit || 0) + (estimatedSellPrice * totalQty - totalBuyAmount);
        eodResults.push({ ticker, name: tc.stockName || ticker, soldQty: totalQty, profit: estimatedProfit, isAutoSelected, pending: true });
      } else {
        // 국내 시장가: 즉시 체결 → cycleHistory 기록 + state 삭제
        const estimatedSellPrice = state.previousPrice || 0;
        const estimatedProfit = (state.totalRealizedProfit || 0) + (estimatedSellPrice * totalQty - totalBuyAmount);

        await db.collection('users').doc(userId).collection('cycleHistory').add({
          ticker, market, strategy: strategyId,
          stockName: tc.stockName || ticker,
          cycleNumber: state.cycleNumber || 1,
          autoSelected: isAutoSelected, dailyCycle: true,
          eodAction: isAutoSelected ? 'market_sell' : 'manual_eod_sell',
          startedAt: state.startedAt,
          completedAt: new Date().toISOString(),
          principal: tc.principal, splitCount: tc.splitCount, profitPercent: tc.profitPercent,
          amountPerRound: state.amountPerRound,
          forceSellCandles: tc.forceSellCandles, intervalMinutes: tc.intervalMinutes,
          minDropPercent: state.minDropPercent || 0,
          peakCheckCandles: state.peakCheckCandles ?? 0,
          bufferPercent: 0.01,
          autoStopLoss: state.autoStopLoss || false,
          stopLossPercent: state.stopLossPercent ?? -5,
          exhaustionStopLoss: state.exhaustionStopLoss || false,
          stopLossMultiplier: state.stopLossMultiplier ?? 3,
          exchangeCode: state.exchangeCode || '',
          selectionMode: state.selectionMode || '',
          conditionName: state.conditionName || '',
          totalBuyAmount: state.totalBuyAmount || 0,
          totalSellAmount: (state.totalSellAmount || 0) + estimatedSellPrice * totalQty,
          totalRealizedProfit: estimatedProfit,
          finalProfitRate: tc.principal > 0 ? estimatedProfit / tc.principal : 0,
          maxRoundsAtEnd: state.maxRounds || tc.splitCount,
          totalForceSellCount: state.totalForceSellCount || 0,
          totalForceSellLoss: state.totalForceSellLoss || 0,
          eodSoldQuantity: totalQty,
          candlesSinceCycleStart: state.candlesSinceCycleStart || 0,
        });

        eodResults.push({ ticker, name: tc.stockName || ticker, soldQty: totalQty, profit: estimatedProfit, isAutoSelected });
        await stateRef.delete();
      }

    } catch (err) {
      if (!eodTokenRefreshed && isTokenExpiredError(err)) {
        console.log(`[EOD:${tag}] Token expired at ${ticker}, refreshing and retrying...`);
        accessToken = await getOrRefreshToken(userId, accountId, credentials as { appKey: string; appSecret: string }, kisClient, true);
        eodTokenRefreshed = true;
        eodIdx--; // 현재 ticker 재시도
        continue;
      } else {
        console.error(`[EOD:${tag}] Error processing ${ticker}:`, err);
      }
    }
    await new Promise(resolve => setTimeout(resolve, 300));
  }

  // 6. config에서 해당 마켓의 autoSelected 종목만 제거 (다른 마켓 autoSelected + forceLiquidateAtClose 수동 종목은 유지)
  // state가 남아있어도 buildTickerConfigFromStateV2가 autoSelected를 복원하므로 다음 EOD 트리거에서 재처리됨
  const allTickers = extractTickerConfigsV2(rdConfig);
  const hasAutoSelected = eodTickers.some(t => t.autoSelected);
  if (hasAutoSelected) {
    const remainingTickers = allTickers.filter(t => !(t.autoSelected && t.market === market));
    const configRef = setMarketStrategyConfig_REF_PLACEHOLDER(db, userId, accountId, market, strategyId);
    await configRef.update({
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

  console.log(`[EOD:${tag}] Completed ${userId}/${accountId}: ${confirmedResults.length} confirmed, ${pendingResults.length} pending`);
}

// ==================== 전량매도 및 추적종료 ====================

/**
 * 실사오팔v2 특정 종목 전량매도 + 추적종료
 * 텔레그램 인라인 버튼 및 웹 대시보드에서 호출
 */
export async function forceStopRealtimeDdsobV2Ticker(
  userId: string,
  accountId: string,
  ticker: string,
  market: MarketType,
  
  reason: 'force_stop' | 'auto_stop_loss' | 'exhaustion_stop_loss' | 'force_sell_candles' = 'force_stop',
  strategyId: AccountStrategy = 'realtimeDdsobV2',
): Promise<{ success: boolean; soldQty: number; message: string }> {
  const tag = market === 'domestic' ? 'KR' : 'US';
  console.log(`[ForceStop:${tag}] ${userId}/${accountId} ticker=${ticker}`);

  // 1. credentials & accessToken
  const credentialsDoc = await db.doc(`users/${userId}/accounts/${accountId}/credentials/main`).get();
  if (!credentialsDoc.exists) {
    return { success: false, soldQty: 0, message: '자격증명을 찾을 수 없습니다' };
  }
  const credentials = credentialsDoc.data()!;
  const kisClient = new KisApiClient(false);
  let accessToken = await getOrRefreshToken(userId, accountId, credentials as { appKey: string; appSecret: string }, kisClient);

  // 2. state 조회 (exchangeCode 확인 + 보유수량 계산 겸용)
  const stateRef = db.doc(`users/${userId}/accounts/${accountId}/realtimeDdsobV2State/${ticker}`);
  const stateDoc = await stateRef.get();

  // 해외 거래소 코드: state에 저장된 값 우선, 없으면 ticker 기반 자동 판별
  const fsQuoteExcd = stateDoc.exists ? stateDoc.data()?.exchangeCode : undefined;
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
      accessToken = await getOrRefreshToken(userId, accountId, credentials as { appKey: string; appSecret: string }, kisClient, true);
    } else {
      console.error(`[ForceStop:${tag}] Unfilled cleanup error:`, err);
    }
  }

  if (!stateDoc.exists) {
    // state 없으면 config에서만 제거
    await removeTickerFromConfig(userId, accountId, ticker, market, db, strategyId);
    return { success: true, soldQty: 0, message: '보유 없음, 추적종료 완료' };
  }

  const state = stateDoc.data()!;
  const buyRecords = state.buyRecords || [];
  const totalQty = buyRecords.reduce((sum: number, br: { quantity: number }) => sum + br.quantity, 0);
  const totalBuyAmount = buyRecords.reduce((sum: number, br: { buyAmount: number }) => sum + br.buyAmount, 0);

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
      const sellPrice = Math.round(currentPrice * 0.95 * 100) / 100; // 5% 버퍼 (소수점 2자리)
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
  const estimatedPrice = state.previousPrice || 0;
  const estimatedProfit = (state.totalRealizedProfit || 0) + (estimatedPrice * totalQty - totalBuyAmount);

  await db.collection('users').doc(userId).collection('cycleHistory').add({
    ticker,
    market,
    strategy: strategyId,
    stockName: state.stockName || ticker,
    cycleNumber: state.cycleNumber || 1,
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
    minDropPercent: state.minDropPercent || 0,
    peakCheckCandles: state.peakCheckCandles ?? 0,
    bufferPercent: 0.01,
    autoStopLoss: state.autoStopLoss || false,
    stopLossPercent: state.stopLossPercent ?? -5,
    exhaustionStopLoss: state.exhaustionStopLoss || false,
    stopLossMultiplier: state.stopLossMultiplier ?? 3,
    exchangeCode: state.exchangeCode || '',
    selectionMode: state.selectionMode || '',
    conditionName: state.conditionName || '',
    totalBuyAmount: state.totalBuyAmount || 0,
    totalSellAmount: (state.totalSellAmount || 0) + estimatedPrice * totalQty,
    totalRealizedProfit: estimatedProfit,
    finalProfitRate: state.principal > 0 ? estimatedProfit / state.principal : 0,
    maxRoundsAtEnd: state.maxRounds || state.splitCount,
    candlesSinceCycleStart: state.candlesSinceCycleStart || 0,
    totalForceSellCount: state.totalForceSellCount || 0,
    totalForceSellLoss: state.totalForceSellLoss || 0,
    forceStopSoldQuantity: totalQty,
  });

  // 6. state 삭제
  await stateRef.delete();

  // 7. config에서 종목 제거
  await removeTickerFromConfig(userId, accountId, ticker, market, db, strategyId);

  console.log(`[ForceStop:${tag}] Completed: ${ticker} ${soldQty}주 매도, 추적종료`);
  return { success: true, soldQty, message: `${ticker} ${soldQty}주 매도 완료, 추적종료` };
}

/**
 * config의 tickers 배열에서 특정 종목 제거
 */
async function removeTickerFromConfig(
  userId: string,
  accountId: string,
  ticker: string,
  market: MarketType,
  
  strategyId: AccountStrategy = 'realtimeDdsobV2'
): Promise<void> {
  const strategyConfig = await getMarketStrategyConfig<RealtimeDdsobV2Config>(db, userId, accountId, market, strategyId);
  if (strategyConfig) {
    const allTickers = extractTickerConfigsV2(strategyConfig);
    if (allTickers.some(t => t.ticker === ticker)) {
      const remaining = allTickers.filter(t => t.ticker !== ticker);
      const configRef = setMarketStrategyConfig_REF_PLACEHOLDER(db, userId, accountId, market, strategyId);
      await configRef.update({ tickers: remaining });
    }
  }
}

/**
 * 웹 대시보드에서 특정 종목 전량매도 + 추적종료 API
 */
export const apiForceStopTickerV2 = onRequest(
  { cors: true, secrets: [telegramBotToken] },
  async (req, res) => {
    if (req.method === 'OPTIONS') { res.status(204).send(''); return; }
    if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }

    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    let decodedToken;
    try {
      decodedToken = await admin.auth().verifyIdToken(authHeader.split('Bearer ')[1]);
    } catch {
      res.status(401).json({ error: 'Invalid token' });
      return;
    }

    const userId = decodedToken.uid;
    const { accountId, ticker } = req.body || {};

    if (!accountId || !ticker) {
      res.status(400).json({ error: 'accountId and ticker are required' });
      return;
    }

    

    try {
      let market: MarketType = getMarketType(ticker);

      // CommonConfig에서 활성 전략 확인 → 해당 전략의 config만 조회
      const commonConfig = await getCommonConfig(db, userId, accountId);
      let detectedStrategy: AccountStrategy = 'realtimeDdsobV2';

      if (commonConfig) {
        // 시장별 활성 전략 확인
        if (isMarketStrategyActive(commonConfig, market, 'realtimeDdsobV2_1')) {
          detectedStrategy = 'realtimeDdsobV2_1';
        } else if (isMarketStrategyActive(commonConfig, market, 'realtimeDdsobV2')) {
          detectedStrategy = 'realtimeDdsobV2';
        } else {
          // 현재 시장에서 활성이 아니면 다른 시장 확인
          const otherMarket: MarketType = market === 'domestic' ? 'overseas' : 'domestic';
          if (isMarketStrategyActive(commonConfig, otherMarket, 'realtimeDdsobV2_1')) {
            market = otherMarket;
            detectedStrategy = 'realtimeDdsobV2_1';
          } else if (isMarketStrategyActive(commonConfig, otherMarket, 'realtimeDdsobV2')) {
            market = otherMarket;
            detectedStrategy = 'realtimeDdsobV2';
          }
        }
      }

      // state에서 market 보정 (config가 없는 잔여 포지션)
      const stateDoc = await db.doc(`users/${userId}/accounts/${accountId}/realtimeDdsobV2State/${ticker}`).get();
      if (!stateDoc.exists) {
        // config에서도 확인
        const strategyConfig = await getMarketStrategyConfig<RealtimeDdsobV2Config>(db, userId, accountId, market, detectedStrategy);
        if (!strategyConfig || !extractTickerConfigsV2(strategyConfig).find(t => t.ticker === ticker)) {
          res.status(404).json({ error: `Ticker ${ticker} not found in config or state` });
          return;
        }
      } else {
        market = stateDoc.data()!.market || market;
      }

      const result = await forceStopRealtimeDdsobV2Ticker(userId, accountId, ticker, market, db, 'force_stop', detectedStrategy);

      // 텔레그램 알림 (공통)
      const chatId = await getUserTelegramChatId(userId);
      if (chatId && result.success) {
        await sendTelegramMessage(chatId,
          `🛑 <b>전량매도 완료</b> [${ticker}]\n\n${result.message}\n\n(웹에서 실행)`
        );
      }

      res.json(result);
    } catch (error) {
      console.error(`Force stop error - userId: ${userId}, ticker: ${ticker}:`, error);
      res.status(500).json({
        success: false,
        soldQty: 0,
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }
);
