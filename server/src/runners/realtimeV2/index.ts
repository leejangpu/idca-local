/**
 * 실사오팔v2 트리거 엔트리포인트
 * US / KR 각각 1분 간격 실행, onSchedule 제거 → plain async 함수
 */

import { config } from '../../config';
import * as localStore from '../../lib/localStore';
import { isUSMarketOpen, getUSMarketHolidayName } from '../../lib/usMarketHolidays';
import {
  isMarketStrategyActive,
  getCommonConfig,
  getMarketStrategyConfig,
  type AccountStrategy,
} from '../../lib/configHelper';
import {
  getMarketType,
  isKRMarketOpen,
  getKRMarketHolidayName,
  getKSTCurrentMinute,
  getETCurrentMinute,
} from '../../lib/marketUtils';
import {
  type RealtimeDdsobV2Config,
  type RealtimeDdsobV2_1Config,
  type RealtimeDdsobV2TickerConfig,
  type AutoSelectConfig,
  type AutoSelectConfigUS,
  extractTickerConfigsV2,
  buildTickerConfigFromStateV2,
} from './types';
import { processRealtimeDdsobV2Trading } from './process';
import {
  processAutoSelectEOD,
  processAutoSelectStocks,
  processAutoSelectStocksUS,
  processAutoSelectStocksV2_1US,
} from './autoSelect';

// 동시 실행 방어: 이전 트리거가 실행 중이면 다음 트리거를 스킵
let usTriggerRunningV2 = false;
let krTriggerRunningV2 = false;

// ---------- 단일 유저/계정 ----------
const userId = config.userId;
const accountId = config.accountId;

/**
 * 실사오팔v2 미국장 러너
 * 1분마다 호출, overseas 티커만 처리
 */
export async function runRealtimeV2US(): Promise<void> {
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
    let processedCount = 0;

    const commonConfig = getCommonConfig();
    if (!commonConfig?.tradingEnabled) { return; }
    const isV2Active = isMarketStrategyActive(commonConfig, 'overseas', 'realtimeDdsobV2');
    const isV2_1Active = isMarketStrategyActive(commonConfig, 'overseas', 'realtimeDdsobV2_1');
    const isActiveStrategy = isV2Active || isV2_1Active;

    // 전략이 다를 때: 잔여 포지션이 있으면 매도 전용 모드, 없으면 스킵
    if (!isActiveStrategy) {
      const allStates = localStore.getAllStates<Record<string, unknown>>('realtimeDdsobV2State');
      let hasActiveOverseas = false;
      for (const [, stateData] of allStates) {
        if (stateData.status === 'active') {
          const stateMarket = stateData.market || getMarketType(stateData.ticker as string);
          if (stateMarket === 'overseas') { hasActiveOverseas = true; break; }
        }
      }
      if (!hasActiveOverseas) return;
      console.log(`[RealtimeDdsobV2:US] ${userId}/${accountId} — 매도 전용 모드 (잔여 포지션 존재)`);
    }

    const rdConfig = isV2_1Active
      ? getMarketStrategyConfig<RealtimeDdsobV2_1Config>('overseas', 'realtimeDdsobV2_1')
      : getMarketStrategyConfig<RealtimeDdsobV2Config>('overseas', 'realtimeDdsobV2');
    if (!rdConfig) return;

    const tickerConfigs = extractTickerConfigsV2(rdConfig as unknown as Record<string, unknown>);
    const overseasConfigTickers = tickerConfigs.filter(t => t.market === 'overseas');
    const isUSAutoSelectEnabled = isV2_1Active
      ? (rdConfig as RealtimeDdsobV2_1Config).autoSelectEnabledUS === true
      : (rdConfig as RealtimeDdsobV2Config).autoSelectEnabledUS === true;
    const isUSEODTime = currentMinute >= 945;

    // ======== 활성 state 조회 + config 매핑 ========
    const allStatesMap = localStore.getAllStates<Record<string, unknown>>('realtimeDdsobV2State');
    const configTickerMap = new Map(overseasConfigTickers.map(t => [t.ticker, t]));

    // 활성 overseas state 분류: EOD 대상 vs 일반 매매
    const eodTickers: RealtimeDdsobV2TickerConfig[] = [];
    const normalStateTickers: { ticker: string; tc: RealtimeDdsobV2TickerConfig }[] = [];

    for (const [ticker, stateData] of allStatesMap) {
      if (stateData.status !== 'active') continue;
      const stateMarket = stateData.market || getMarketType(ticker);
      if (stateMarket !== 'overseas') continue;

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
        await processAutoSelectEOD(eodTickers, rdConfig as unknown as Record<string, unknown>, 'overseas', eodStrategyId);
      } catch (err) {
        console.error(`[RealtimeDdsobV2:US] EOD error ${userId}/${accountId}:`, err);
      }
    }

    // ======== EOD 이후 일반 매매 차단 ========
    if (isUSEODTime) {
      console.log(`[RealtimeDdsobV2:US] Processed ${processedCount} tickers`);
      return;
    }

    // ======== 2. 활성 state 기반 일반 매매 처리 (병렬, 300ms 스태거) ========
    {
      const tradingStrategyId: AccountStrategy = isV2_1Active ? 'realtimeDdsobV2_1' : 'realtimeDdsobV2';
      const tasks = normalStateTickers
        .filter(({ tc }) => currentMinute % tc.intervalMinutes === 0)
        .map(({ ticker, tc }, i) => {
          processedCount++;
          return new Promise<void>(resolve => setTimeout(resolve, i * 300)).then(async () => {
            try {
              await processRealtimeDdsobV2Trading(userId, accountId, tc, rdConfig as unknown as Record<string, unknown>, 'overseas',
                !isActiveStrategy ? { sellOnly: true, strategyId: tradingStrategyId } : { strategyId: tradingStrategyId });
            } catch (err) {
              console.error(`[RealtimeDdsobV2:US] Error ${userId}/${accountId}/${ticker}:`, err);
            }
          });
        });
      await Promise.all(tasks);
    }

    // 매도 전용 모드: 신규 사이클 시작 및 자동선별 스킵
    if (!isActiveStrategy) {
      console.log(`[RealtimeDdsobV2:US] Processed ${processedCount} tickers`);
      return;
    }

    // ======== 3. config에만 있고 state가 없는 종목 → 신규 사이클 시작 (병렬, 300ms 스태거) ========
    {
      const tradingStrategyId2: AccountStrategy = isV2_1Active ? 'realtimeDdsobV2_1' : 'realtimeDdsobV2';
      const activeStateTickers = new Set(allStatesMap.keys());
      const newTasks = overseasConfigTickers
        .filter(tc => !activeStateTickers.has(tc.ticker) && currentMinute % tc.intervalMinutes === 0)
        .map((tc, i) => {
          processedCount++;
          return new Promise<void>(resolve => setTimeout(resolve, i * 300)).then(async () => {
            try {
              await processRealtimeDdsobV2Trading(userId, accountId, tc, rdConfig as unknown as Record<string, unknown>, 'overseas', { strategyId: tradingStrategyId2 });
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
          ? getMarketStrategyConfig<RealtimeDdsobV2_1Config>('overseas', 'realtimeDdsobV2_1')
          : getMarketStrategyConfig<RealtimeDdsobV2Config>('overseas', 'realtimeDdsobV2');
        if (latestRdConfig) {
          const latestTickers = extractTickerConfigsV2(latestRdConfig as unknown as Record<string, unknown>);
          const currentUSAutoCount = latestTickers.filter(t => t.autoSelected && t.market === 'overseas').length;

          if (isV2_1Active) {
            const autoConfigV2_1 = (latestRdConfig as RealtimeDdsobV2_1Config).autoSelectConfigUS;
            if (autoConfigV2_1 && autoConfigV2_1.stockCount > 0) {
              const emptySlots = autoConfigV2_1.stockCount - currentUSAutoCount;
              if (emptySlots > 0) {
                console.log(`[RealtimeDdsobV2.1:US] Empty slots detected: ${emptySlots}`);
                const newTickers = await processAutoSelectStocksV2_1US(autoConfigV2_1, latestRdConfig as unknown as Record<string, unknown>, { mode: 'refill' });
                for (const ntc of newTickers) {
                  processedCount++;
                  try {
                    await processRealtimeDdsobV2Trading(userId, accountId, ntc, latestRdConfig as unknown as Record<string, unknown>, 'overseas', { strategyId: 'realtimeDdsobV2_1' });
                  } catch (err) {
                    console.error(`[RealtimeDdsobV2.1:US] Refill immediate trade error ${ntc.ticker}:`, err);
                  }
                  await new Promise(resolve => setTimeout(resolve, 500));
                }
              }
            }
          } else {
            const autoConfigUS = (latestRdConfig as RealtimeDdsobV2Config).autoSelectConfigUS as unknown as AutoSelectConfigUS;
            if (autoConfigUS && autoConfigUS.stockCount > 0) {
              const emptySlots = autoConfigUS.stockCount - currentUSAutoCount;
              if (emptySlots > 0) {
                console.log(`[RealtimeDdsobV2:US] Empty slots detected: ${emptySlots} (target=${autoConfigUS.stockCount}, current=${currentUSAutoCount})`);
                const newTickers = await processAutoSelectStocksUS(autoConfigUS, latestRdConfig as unknown as Record<string, unknown>, { mode: 'refill' });
                for (const ntc of newTickers) {
                  processedCount++;
                  try {
                    await processRealtimeDdsobV2Trading(userId, accountId, ntc, latestRdConfig as unknown as Record<string, unknown>, 'overseas');
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

    console.log(`[RealtimeDdsobV2:US] Processed ${processedCount} tickers`);
  } catch (error) {
    console.error('[RealtimeDdsobV2:US] Trigger error:', error);
  } finally {
    usTriggerRunningV2 = false;
  }
}

/**
 * 실사오팔v2 한국장 러너
 * 1분마다 호출, domestic 티커만 처리
 */
export async function runRealtimeV2KR(): Promise<void> {
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
    let processedCount = 0;

    const commonConfig = getCommonConfig();
    if (!commonConfig?.tradingEnabled) { return; }
    const isActiveStrategy = isMarketStrategyActive(commonConfig, 'domestic', 'realtimeDdsobV2');

    // 전략이 다를 때: 잔여 포지션이 있으면 매도 전용 모드, 없으면 스킵
    if (!isActiveStrategy) {
      const allStates = localStore.getAllStates<Record<string, unknown>>('realtimeDdsobV2State');
      let hasActiveDomestic = false;
      for (const [ticker, stateData] of allStates) {
        if (stateData.status === 'active') {
          const stateMarket = stateData.market || getMarketType(ticker);
          if (stateMarket === 'domestic') { hasActiveDomestic = true; break; }
        }
      }
      if (!hasActiveDomestic) return;
      console.log(`[RealtimeDdsobV2:KR] ${userId}/${accountId} — 매도 전용 모드 (잔여 포지션 존재)`);
    }

    const rdConfig = getMarketStrategyConfig<RealtimeDdsobV2Config>('domestic', 'realtimeDdsobV2');
    if (!rdConfig) return;

    const tickerConfigs = extractTickerConfigsV2(rdConfig as unknown as Record<string, unknown>);
    const domesticConfigTickers = tickerConfigs.filter(t => t.market === 'domestic');
    const isEODTime = currentMinute >= 915;

    // ======== 활성 state 조회 + config 매핑 ========
    const allStatesMap = localStore.getAllStates<Record<string, unknown>>('realtimeDdsobV2State');
    const configTickerMap = new Map(domesticConfigTickers.map(t => [t.ticker, t]));

    // 활성 domestic state 분류: EOD 대상 vs 일반 매매
    const eodTickers: RealtimeDdsobV2TickerConfig[] = [];
    const normalStateTickers: { ticker: string; tc: RealtimeDdsobV2TickerConfig }[] = [];

    for (const [ticker, stateData] of allStatesMap) {
      if (stateData.status !== 'active') continue;
      const stateMarket = stateData.market || getMarketType(ticker);
      if (stateMarket !== 'domestic') continue;

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
        await processAutoSelectEOD(eodTickers, rdConfig as unknown as Record<string, unknown>);
      } catch (err) {
        console.error(`[RealtimeDdsobV2:KR] EOD error ${userId}/${accountId}:`, err);
      }
    }

    // ======== EOD 이후 일반 매매 차단 ========
    if (isEODTime) {
      console.log(`[RealtimeDdsobV2:KR] Processed ${processedCount} tickers`);
      return;
    }

    // ======== 2. 활성 state 기반 일반 매매 처리 (병렬, 300ms 스태거) ========
    {
      const tasks = normalStateTickers
        .filter(({ tc }) => currentMinute % tc.intervalMinutes === 0)
        .map(({ ticker, tc }, i) => {
          processedCount++;
          return new Promise<void>(resolve => setTimeout(resolve, i * 300)).then(async () => {
            try {
              await processRealtimeDdsobV2Trading(userId, accountId, tc, rdConfig as unknown as Record<string, unknown>, 'domestic',
                !isActiveStrategy ? { sellOnly: true } : undefined);
            } catch (err) {
              console.error(`[RealtimeDdsobV2:KR] Error ${userId}/${accountId}/${ticker}:`, err);
            }
          });
        });
      await Promise.all(tasks);
    }

    // 매도 전용 모드: 신규 사이클 시작 및 자동선별 스킵
    if (!isActiveStrategy) {
      console.log(`[RealtimeDdsobV2:KR] Processed ${processedCount} tickers`);
      return;
    }

    // 점심시간 신규진입 차단 (11:30~13:00 KST) — 기존 사이클은 위에서 정상 처리됨
    const isLunchBreak = currentMinute >= 690 && currentMinute < 780;
    if (isLunchBreak) {
      console.log(`[RealtimeDdsobV2:KR] Lunch break (11:30~13:00) — skipping new cycle entries`);
      console.log(`[RealtimeDdsobV2:KR] Processed ${processedCount} tickers`);
      return;
    }

    // ======== 3. config에만 있고 state가 없는 종목 → 신규 사이클 시작 (병렬, 300ms 스태거) ========
    {
      const activeStateTickers = new Set(allStatesMap.keys());
      const newTasks = domesticConfigTickers
        .filter(tc => !activeStateTickers.has(tc.ticker) && currentMinute % tc.intervalMinutes === 0)
        .map((tc, i) => {
          processedCount++;
          return new Promise<void>(resolve => setTimeout(resolve, i * 300)).then(async () => {
            try {
              await processRealtimeDdsobV2Trading(userId, accountId, tc, rdConfig as unknown as Record<string, unknown>, 'domestic');
            } catch (err) {
              console.error(`[RealtimeDdsobV2:KR] New cycle error ${tc.ticker}:`, err);
            }
          });
        });
      await Promise.all(newTasks);
    }

    // ======== 빈 슬롯 재선택 (매매 처리와 독립적으로 실행) ========
    const reselectionCutoff = 14 * 60 + 30; // 14:30 KST
    if (rdConfig.autoSelectEnabled && currentMinute < reselectionCutoff) {
      const autoConfig = rdConfig.autoSelectConfig as AutoSelectConfig | undefined;
      if (autoConfig && autoConfig.stockCount > 0) {
        try {
          // config 재조회 (매매 처리 중 사이클 종료로 변경되었을 수 있음)
          const latestRdConfig = getMarketStrategyConfig<RealtimeDdsobV2Config>('domestic', 'realtimeDdsobV2');
          if (latestRdConfig) {
            const latestTickers = extractTickerConfigsV2(latestRdConfig as unknown as Record<string, unknown>);
            const currentAutoCount = latestTickers.filter(t => t.autoSelected && t.market === 'domestic').length;
            const emptySlots = autoConfig.stockCount - currentAutoCount;

            if (emptySlots > 0) {
              console.log(`[RealtimeDdsobV2:KR] Empty slots detected: ${emptySlots} (target=${autoConfig.stockCount}, current=${currentAutoCount})`);
              const newTickers = await processAutoSelectStocks(autoConfig, latestRdConfig as unknown as Record<string, unknown>, { mode: 'refill' });

              // refill로 추가된 종목 즉시 매매 시작 (다음 틱까지 기다리지 않음)
              for (const ntc of newTickers) {
                processedCount++;
                try {
                  await processRealtimeDdsobV2Trading(userId, accountId, ntc, latestRdConfig as unknown as Record<string, unknown>, 'domestic');
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

    console.log(`[RealtimeDdsobV2:KR] Processed ${processedCount} tickers`);
  } catch (error) {
    console.error('[RealtimeDdsobV2:KR] Trigger error:', error);
  } finally {
    krTriggerRunningV2 = false;
  }
}
