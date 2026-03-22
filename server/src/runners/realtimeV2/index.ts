/**
 * 실사오팔v2 트리거 엔트리포인트
 * US / KR 각각 1분 간격 실행, onSchedule 제거 → plain async 함수
 */

import { config } from '../../config';
import * as localStore from '../../lib/localStore';
import { AccountContext } from '../../lib/accountContext';
import { isUSMarketOpen, getUSMarketHolidayName } from '../../lib/usMarketHolidays';
import {
  isMarketStrategyActive,
  getCommonConfig,
  getMarketStrategyConfig,
  type CommonConfig,
} from '../../lib/configHelper';
import {
  getMarketType,
  isKRMarketOpen,
  getKRMarketHolidayName,
  getKSTCurrentMinute,
  getETCurrentMinute,
  getKSTDateString,
} from '../../lib/marketUtils';
import {
  type RealtimeDdsobV2Config,
  type RealtimeDdsobV2TickerConfig,
  type AutoSelectConfig,
  extractTickerConfigsV2,
  buildTickerConfigFromStateV2,
} from './types';
import { processRealtimeDdsobV2Trading } from './process';
import {
  processAutoSelectEOD,
  processAutoSelectStocks,
  processAutoSelectStocksUS,
} from './autoSelect';
import {
  getOrCreateProvider,
  subscribeWithRef,
  unsubscribeWithRef,
  unsubscribeAllByConsumer,
  subscribeOrderbookWithRef,
  unsubscribeOrderbookWithRef,
  unsubscribeAllOrderbookByConsumer,
  type ExecutionNotification,
} from '../../lib/marketDataProvider';

// 동시 실행 방어: 이전 트리거가 실행 중이면 다음 트리거를 스킵 (계정별)
const usRunning = new Map<string, boolean>();
const krRunning = new Map<string, boolean>();

// ---------- 단일 유저/계정 (default fallback) ----------
const userId = config.userId;
const accountId = config.accountId;

// ========================================
// WS 체결통보 버퍼 (H0STCNI0)
// ========================================

// accountId → ticker → Array<{ orderNo, side, qty, price, amount }>
const executionBuffers = new Map<string, Map<string, Array<{ orderNo: string; side: string; qty: number; price: number; amount: number }>>>();

// accountId → 체결통보 구독 완료 여부
const executionSubscribed = new Set<string>();

// 이전에 구독 중이던 종목 (계정별)
const prevSubscribedTickers = new Map<string, Set<string>>();

function getExecutionBuffer(acctId: string): Map<string, Array<{ orderNo: string; side: string; qty: number; price: number; amount: number }>> {
  if (!executionBuffers.has(acctId)) {
    executionBuffers.set(acctId, new Map());
  }
  return executionBuffers.get(acctId)!;
}

function handleExecution(acctId: string, exec: ExecutionNotification): void {
  const buffer = getExecutionBuffer(acctId);
  if (!buffer.has(exec.ticker)) {
    buffer.set(exec.ticker, []);
  }
  buffer.get(exec.ticker)!.push({
    orderNo: exec.orderNo,
    side: exec.side,
    qty: exec.filledQty,
    price: exec.filledPrice,
    amount: exec.filledPrice * exec.filledQty,
  });
}

// provider가 start()된 적 있는 계정
const providerStarted = new Set<string>();

/**
 * WS provider 초기화 + 체결통보 구독 (계정별 1회)
 */
async function ensureProviderAndExecution(ctx: AccountContext): Promise<void> {
  const acctId = ctx.accountId;
  const provider = getOrCreateProvider(acctId, ctx, 'websocket');

  // provider가 아직 시작되지 않았으면 시작 (단타가 이미 만들어서 start한 경우 스킵)
  if (!providerStarted.has(acctId)) {
    // getOrCreateProvider가 새로 만들었을 때만 start
    // 이미 단타 등이 start한 provider는 다시 start하지 않음
    if (provider.getSubscriptions().length === 0 && !provider.isFallbackActive()) {
      try {
        await provider.start();
      } catch (err) {
        console.error(`[RealtimeDdsobV2:KR] Provider start failed for ${acctId}:`, err);
      }
    }
    providerStarted.add(acctId);
  }

  // 체결통보 구독 (HTS ID)
  if (!executionSubscribed.has(acctId) && ctx.credentials.htsUserId) {
    provider.subscribeExecution(ctx.credentials.htsUserId);
    provider.onExecution((exec) => handleExecution(acctId, exec));
    executionSubscribed.add(acctId);
    console.log(`[RealtimeDdsobV2:KR] H0STCNI0 subscribed for ${acctId} (htsId=${ctx.credentials.htsUserId})`);
  }
}

/**
 * 활성 종목 목록에 맞춰 WS 구독 동기화
 */
function syncSubscriptions(acctId: string, activeTickers: Set<string>): void {
  const prev = prevSubscribedTickers.get(acctId) || new Set<string>();
  const consumer = 'realtimeV2';

  // 새로 추가된 종목: 구독
  for (const ticker of activeTickers) {
    if (!prev.has(ticker)) {
      subscribeWithRef(acctId, ticker, consumer);
      subscribeOrderbookWithRef(acctId, ticker, consumer);
    }
  }

  // 제거된 종목: 구독 해제
  for (const ticker of prev) {
    if (!activeTickers.has(ticker)) {
      unsubscribeWithRef(acctId, ticker, consumer);
      unsubscribeOrderbookWithRef(acctId, ticker, consumer);
    }
  }

  prevSubscribedTickers.set(acctId, new Set(activeTickers));
}

/**
 * 실사오팔v2 미국장 러너
 * 1분마다 호출, overseas 티커만 처리
 */
export async function runRealtimeV2US(ctx?: AccountContext): Promise<void> {
  if (!isUSMarketOpen()) return;

  const runKey = ctx?.accountId ?? 'default';

  // 이전 트리거가 아직 실행 중이면 스킵
  if (usRunning.get(runKey)) {
    console.log('[RealtimeDdsobV2:US] Previous trigger still running, skipping');
    return;
  }
  usRunning.set(runKey, true);

  console.log('[RealtimeDdsobV2:US] Trigger started');

  const currentMinute = getETCurrentMinute();

  // 실사오팔v2: 장 시작 20분 후부터 매매 (09:50 ET~)
  if (currentMinute < 9 * 60 + 50) { usRunning.set(runKey, false); return; }

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
    usRunning.set(runKey, false);
    return;
  }

  try {
    let processedCount = 0;
    const store = ctx?.store ?? localStore;

    const commonConfig = ctx
      ? ctx.store.getTradingConfig<CommonConfig>()
      : getCommonConfig();
    if (!commonConfig?.tradingEnabled) { return; }
    const isActiveStrategy = isMarketStrategyActive(commonConfig, 'overseas', 'realtimeDdsobV2');

    // 전략이 다를 때: 잔여 포지션이 있으면 매도 전용 모드, 없으면 스킵
    if (!isActiveStrategy) {
      const allStates = store.getAllStates<Record<string, unknown>>('realtimeDdsobV2State');
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

    const rdConfig = ctx
      ? ctx.store.getStrategyConfig<RealtimeDdsobV2Config>('overseas', 'realtimeDdsobV2')
      : getMarketStrategyConfig<RealtimeDdsobV2Config>('overseas', 'realtimeDdsobV2');
    if (!rdConfig) return;

    const tickerConfigs = extractTickerConfigsV2(rdConfig as unknown as Record<string, unknown>);
    const overseasConfigTickers = tickerConfigs.filter(t => t.market === 'overseas');
    const isUSAutoSelectEnabled = rdConfig.autoSelectEnabledUS === true;
    const isUSEODTime = currentMinute >= 945;

    // ======== 활성 state 조회 + config 매핑 ========
    const allStatesMap = store.getAllStates<Record<string, unknown>>('realtimeDdsobV2State');
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
    if (isUSEODTime && eodTickers.length > 0 && isActiveStrategy) {
      const eodFlagKey = `us_${getKSTDateString()}`;
      const eodAlreadyDone = store.getState<{ done: boolean }>('realtimeV2EodLog', eodFlagKey);
      if (!eodAlreadyDone?.done) {
        store.setState('realtimeV2EodLog', eodFlagKey, { done: true });
        try {
          await processAutoSelectEOD(eodTickers, rdConfig as unknown as Record<string, unknown>, 'overseas', 'realtimeDdsobV2', ctx);
        } catch (err) {
          console.error(`[RealtimeDdsobV2:US] EOD error ${userId}/${accountId}:`, err);
        }
      }
    }

    // ======== EOD 이후 일반 매매 차단 ========
    if (isUSEODTime) {
      console.log(`[RealtimeDdsobV2:US] Processed ${processedCount} tickers`);
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
              await processRealtimeDdsobV2Trading(userId, accountId, tc, rdConfig as unknown as Record<string, unknown>, 'overseas',
                !isActiveStrategy ? { sellOnly: true } : undefined, ctx);
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
      const activeStateTickers = new Set(allStatesMap.keys());
      const newTasks = overseasConfigTickers
        .filter(tc => !activeStateTickers.has(tc.ticker) && currentMinute % tc.intervalMinutes === 0)
        .map((tc, i) => {
          processedCount++;
          return new Promise<void>(resolve => setTimeout(resolve, i * 300)).then(async () => {
            try {
              await processRealtimeDdsobV2Trading(userId, accountId, tc, rdConfig as unknown as Record<string, unknown>, 'overseas', undefined, ctx);
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
      const autoConfigUS = rdConfig.autoSelectConfigUS as AutoSelectConfig | undefined;
      if (autoConfigUS && autoConfigUS.stockCount > 0) {
        try {
          const latestRdConfig = ctx
            ? ctx.store.getStrategyConfig<RealtimeDdsobV2Config>('overseas', 'realtimeDdsobV2')
            : getMarketStrategyConfig<RealtimeDdsobV2Config>('overseas', 'realtimeDdsobV2');
          if (latestRdConfig) {
            const latestTickers = extractTickerConfigsV2(latestRdConfig as unknown as Record<string, unknown>);
            const currentUSAutoCount = latestTickers.filter(t => t.autoSelected && t.market === 'overseas').length;

            // state 기반 가드: 활성 overseas state 수도 슬롯 점유로 간주
            const freshUSStates = store.getAllStates<Record<string, unknown>>('realtimeDdsobV2State');
            let activeUSStateCount = 0;
            for (const [tk, st] of freshUSStates) {
              if (st.status === 'active' && (st.market || getMarketType(tk)) === 'overseas') {
                activeUSStateCount++;
              }
            }
            const usOccupiedCount = Math.max(currentUSAutoCount, activeUSStateCount);
            const emptySlots = autoConfigUS.stockCount - usOccupiedCount;

            if (emptySlots > 0) {
              console.log(`[RealtimeDdsobV2:US] Empty slots detected: ${emptySlots} (target=${autoConfigUS.stockCount}, configAuto=${currentUSAutoCount}, activeStates=${activeUSStateCount})`);
              const newTickers = await processAutoSelectStocksUS(autoConfigUS, latestRdConfig as unknown as Record<string, unknown>, { mode: 'refill' }, ctx);

              for (const ntc of newTickers) {
                processedCount++;
                try {
                  await processRealtimeDdsobV2Trading(userId, accountId, ntc, latestRdConfig as unknown as Record<string, unknown>, 'overseas', undefined, ctx);
                } catch (err) {
                  console.error(`[RealtimeDdsobV2:US] Refill immediate trade error ${ntc.ticker}:`, err);
                }
                await new Promise(resolve => setTimeout(resolve, 500));
              }
            }
          }
        } catch (err) {
          console.error(`[RealtimeDdsobV2:US] Refill error ${userId}/${accountId}:`, err);
        }
      }
    }

    console.log(`[RealtimeDdsobV2:US] Processed ${processedCount} tickers`);
  } catch (error) {
    console.error('[RealtimeDdsobV2:US] Trigger error:', error);
  } finally {
    usRunning.set(runKey, false);
  }
}

/**
 * 실사오팔v2 한국장 러너
 * 1분마다 호출, domestic 티커만 처리
 */
export async function runRealtimeV2KR(ctx?: AccountContext): Promise<void> {
  if (!isKRMarketOpen()) return;

  const runKey = ctx?.accountId ?? 'default';

  // 이전 트리거가 아직 실행 중이면 스킵
  if (krRunning.get(runKey)) {
    console.log('[RealtimeDdsobV2:KR] Previous trigger still running, skipping');
    return;
  }
  krRunning.set(runKey, true);

  console.log('[RealtimeDdsobV2:KR] Trigger started');

  const now = new Date();
  const kstTime = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  const currentMinute = getKSTCurrentMinute();

  // 실사오팔v2: 장 시작 20분 후부터 매매 (09:20 KST~)
  if (currentMinute < 9 * 60 + 20) { krRunning.set(runKey, false); return; }

  // 휴장일 확인
  const holidayName = getKRMarketHolidayName(kstTime);
  if (holidayName) {
    console.log(`[RealtimeDdsobV2:KR] Holiday: ${holidayName}`);
    krRunning.set(runKey, false);
    return;
  }

  try {
    let processedCount = 0;
    const acctId = ctx?.accountId ?? accountId;
    const store = ctx?.store ?? localStore;

    const commonConfig = ctx
      ? ctx.store.getTradingConfig<CommonConfig>()
      : getCommonConfig();
    if (!commonConfig?.tradingEnabled) { return; }
    const isActiveStrategy = isMarketStrategyActive(commonConfig, 'domestic', 'realtimeDdsobV2');

    // 전략이 다를 때: 잔여 포지션이 있으면 매도 전용 모드, 없으면 스킵
    if (!isActiveStrategy) {
      const allStates = store.getAllStates<Record<string, unknown>>('realtimeDdsobV2State');
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

    const rdConfig = ctx
      ? ctx.store.getStrategyConfig<RealtimeDdsobV2Config>('domestic', 'realtimeDdsobV2')
      : getMarketStrategyConfig<RealtimeDdsobV2Config>('domestic', 'realtimeDdsobV2');
    if (!rdConfig) return;

    // ======== WS Provider 초기화 + 체결통보 구독 ========
    if (ctx) {
      await ensureProviderAndExecution(ctx);
    }

    const tickerConfigs = extractTickerConfigsV2(rdConfig as unknown as Record<string, unknown>);
    const domesticConfigTickers = tickerConfigs.filter(t => t.market === 'domestic');
    const isEODTime = currentMinute >= 915;

    // ======== 활성 state 조회 + config 매핑 ========
    const allStatesMap = store.getAllStates<Record<string, unknown>>('realtimeDdsobV2State');
    const configTickerMap = new Map(domesticConfigTickers.map(t => [t.ticker, t]));

    // 활성 domestic state 분류: EOD 대상 vs 일반 매매
    const eodTickers: RealtimeDdsobV2TickerConfig[] = [];
    const normalStateTickers: { ticker: string; tc: RealtimeDdsobV2TickerConfig }[] = [];

    // 활성 종목 목록 수집 (WS 구독 동기화용)
    const activeDomesticTickers = new Set<string>();

    for (const [ticker, stateData] of allStatesMap) {
      if (stateData.status !== 'active') continue;
      const stateMarket = stateData.market || getMarketType(ticker);
      if (stateMarket !== 'domestic') continue;

      activeDomesticTickers.add(ticker);
      const tc = configTickerMap.get(ticker) || buildTickerConfigFromStateV2(stateData);

      if (isEODTime && (tc.autoSelected || tc.forceLiquidateAtClose)) {
        eodTickers.push(tc);
      } else {
        normalStateTickers.push({ ticker, tc });
      }
    }

    // config에만 있고 state가 없는 종목도 구독 대상 포함
    for (const tc of domesticConfigTickers) {
      activeDomesticTickers.add(tc.ticker);
    }

    // WS 구독 동기화
    if (ctx) {
      syncSubscriptions(acctId, activeDomesticTickers);
    }

    // 체결통보 버퍼 스냅샷 (이번 틱에서 사용 후 클리어)
    const execBuffer = getExecutionBuffer(acctId);

    // ======== 1. EOD 일괄 처리 (autoSelected/forceLiquidateAtClose) ========
    if (isEODTime && eodTickers.length > 0 && isActiveStrategy) {
      const eodFlagKey = `kr_${getKSTDateString()}`;
      const eodAlreadyDone = store.getState<{ done: boolean }>('realtimeV2EodLog', eodFlagKey);
      if (!eodAlreadyDone?.done) {
        store.setState('realtimeV2EodLog', eodFlagKey, { done: true });
        try {
          await processAutoSelectEOD(eodTickers, rdConfig as unknown as Record<string, unknown>, 'domestic', 'realtimeDdsobV2', ctx);
        } catch (err) {
          console.error(`[RealtimeDdsobV2:KR] EOD error ${userId}/${accountId}:`, err);
        }
      }
    }

    // ======== EOD 이후: 매매 차단 + 장마감 시 구독 해제 ========
    if (isEODTime) {
      // 장마감 시 WS 구독 해제
      if (currentMinute >= 930 && ctx) {
        unsubscribeAllByConsumer(acctId, 'realtimeV2');
        unsubscribeAllOrderbookByConsumer(acctId, 'realtimeV2');
        prevSubscribedTickers.delete(acctId);
        // 체결통보 버퍼 + 상태 플래그 클리어 (다음 날 재구독 위해)
        executionBuffers.delete(acctId);
        executionSubscribed.delete(acctId);
        providerStarted.delete(acctId);
      }
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
                !isActiveStrategy ? { sellOnly: true, executionBuffer: execBuffer } : { executionBuffer: execBuffer }, ctx);
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
              await processRealtimeDdsobV2Trading(userId, accountId, tc, rdConfig as unknown as Record<string, unknown>, 'domestic',
                { executionBuffer: execBuffer }, ctx);
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
          const latestRdConfig = ctx
            ? ctx.store.getStrategyConfig<RealtimeDdsobV2Config>('domestic', 'realtimeDdsobV2')
            : getMarketStrategyConfig<RealtimeDdsobV2Config>('domestic', 'realtimeDdsobV2');
          if (latestRdConfig) {
            const latestTickers = extractTickerConfigsV2(latestRdConfig as unknown as Record<string, unknown>);
            const currentAutoCount = latestTickers.filter(t => t.autoSelected && t.market === 'domestic').length;

            // state 기반 가드: 활성 domestic state 수도 슬롯 점유로 간주
            const freshStates = store.getAllStates<Record<string, unknown>>('realtimeDdsobV2State');
            let activeDomesticStateCount = 0;
            for (const [tk, st] of freshStates) {
              if (st.status === 'active' && (st.market || getMarketType(tk)) === 'domestic') {
                activeDomesticStateCount++;
              }
            }
            const occupiedCount = Math.max(currentAutoCount, activeDomesticStateCount);
            const emptySlots = autoConfig.stockCount - occupiedCount;

            if (emptySlots > 0) {
              console.log(`[RealtimeDdsobV2:KR] Empty slots detected: ${emptySlots} (target=${autoConfig.stockCount}, configAuto=${currentAutoCount}, activeStates=${activeDomesticStateCount})`);
              const newTickers = await processAutoSelectStocks(autoConfig, latestRdConfig as unknown as Record<string, unknown>, { mode: 'refill' }, ctx);

              // refill로 추가된 종목 즉시 매매 시작 (다음 틱까지 기다리지 않음)
              for (const ntc of newTickers) {
                processedCount++;
                try {
                  await processRealtimeDdsobV2Trading(userId, accountId, ntc, latestRdConfig as unknown as Record<string, unknown>, 'domestic',
                    { executionBuffer: execBuffer }, ctx);
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

    // 체결통보 버퍼 클리어 (이번 틱 처리 완료)
    execBuffer.clear();

    console.log(`[RealtimeDdsobV2:KR] Processed ${processedCount} tickers`);
  } catch (error) {
    console.error('[RealtimeDdsobV2:KR] Trigger error:', error);
  } finally {
    krRunning.set(runKey, false);
  }
}
