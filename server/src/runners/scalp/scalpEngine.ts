/**
 * Quick Scalp v3 — 공통 실행 엔진
 *
 * 기존 momentumScalp.ts(v2.2)를 멀티전략 구조로 리팩터링.
 * 공통 실행 엔진(주문/체결/청산/로그)은 공유하고, 진입 로직만 전략별로 분리.
 *
 * 핵심 변경:
 * - handleNewBuy: 후보 당 전략 3개 병렬 평가
 * - 상태 키: "{strategyId}_{ticker}" (동일 종목 멀티 전략 독립 포지션)
 * - 전략별 독립 슬롯/자본 (shadow에서 전략 간 경쟁 없음)
 * - 확장 로깅: strategyId, strategyVersion, candidateRank, signalMinuteBucket, fillModel, MFE60/120
 */

import { config } from '../../config';
import * as localStore from '../../lib/localStore';
import { KisApiClient, getOrRefreshToken, isTokenExpiredError } from '../../lib/kisApi';
import { type AccountContext } from '../../lib/accountContext';
import {
  sendTelegramMessage,
  getUserTelegramChatId,
} from '../../lib/telegram';
import {
  isKRMarketOpen,
  getKSTCurrentMinute,
  getKSTDateString,
  getKRMarketHolidayName,
  getKoreanTickSize,
  getKRMarketMinutesBetween,
} from '../../lib/marketUtils';
import { type MinuteBar } from '../../lib/rsiCalculator';
import {
  filterQuickScalpCandidate,
  calculateQuickScalpTarget,
  checkMomentumScalpExit,
} from '../../lib/momentumScalpCalculator';
import {
  type MomentumScalpConfig,
  deleteMomentumScalpState,
  getMomentumScalpStateByTicker,
  // v3
  createMomentumScalpStateV3,
  updateScalpStateToActiveV3,
  deleteScalpStateV3,
  updateScalpStateToPendingSellV3,
  revertScalpStateToActiveV3,
  getScalpStateV3,
  getAllScalpStatesV3,
  calculateStrategySlotAvailability,
  getOccupiedStateKeysByStrategy,
  updateScalpStateMFE,
  // v3.1
  createArmedScalpStateV3,
  transitionArmedToPendingBuy,
} from '../../lib/slotAllocator';
import { type CommonConfig, getCommonConfig, getMarketStrategyConfig, isMarketStrategyActive } from '../../lib/configHelper';
import { getOccupiedTickersExcluding } from '../../lib/activeTickerRegistry';

import {
  type StrategyId,
  type MomentumScalpConfigV3,
  type MomentumScalpStateV3,
  type StrategySlotConfig,
  type CandidateContext,
  makeStateKey,
  parseStateKey,
  minuteToBucket,
  ROUND_TRIP_COST_PCT,
} from './scalpTypes';
import {
  writeTradeLog as writeTradeLogV3,
  writeShadowExitLog,
  writeShadowPendingEntryLog,
  writeShadowEntryLog,
  writeShadowCancelLog,
  recordPriceTrail,
  clearPriceTrail,
  writeCandidateMomentLog,
  resetNearMissCounters,
} from './scalpLogger';
import { getEnabledStrategies, type ScalpStrategy } from './strategies';

// ========================================
// 상수
// ========================================

const BUY_START_MINUTE = 9 * 60 + 5;
const BUY_END_MINUTE = 15 * 60 + 15;
const LUNCH_SKIP_START = 11 * 60 + 30;
const LUNCH_SKIP_END = 13 * 60;
const MARKET_CLOSE_AUCTION_MINUTE = 15 * 60 + 20;

const HOLDING_TIMEOUT_MINUTES = 3;
const NO_PROGRESS_CHECK_MINUTES = 2;
const NO_PROGRESS_MFE_THRESHOLD = 0.15;
const DEFAULT_PENDING_BUY_TTL_MS = 15 * 1000;
const MFE30_GATE_SECONDS = 30;

const EXIT_CHECK_INTERVAL_MS = 5000;
const EXIT_CHECK_MAX_ROUNDS = 9;
const PENDING_SELL_TIMEOUT_MS = 5 * 60 * 1000;
const SELL_API_MAX_RETRIES = 3;
const MAX_EVAL_CANDIDATES = 20;
const MAX_ENTRIES_PER_TICKER_PER_DAY = 2;

// 동시 실행 방어
let buyTriggerRunning = false;
let sellTriggerRunning = false;

// 매도 체크 스냅샷 — 분당 1회 flush
const sellCheckSnapshots = new Map<string, Record<string, unknown>>();

// ========================================
// 매수 트리거 (cron에서 호출)
// ========================================

export async function runMomentumScalpBuyKR(ctx?: AccountContext): Promise<void> {
  if (!isKRMarketOpen()) return;

  if (buyTriggerRunning) {
    console.log('[ScalpV3] Previous buy trigger still running, skipping');
    return;
  }
  buyTriggerRunning = true;

  const kstTime = new Date(Date.now() + 9 * 60 * 60 * 1000);
  const currentMinute = getKSTCurrentMinute();
  const todayStr = getKSTDateString();

  const holidayName = getKRMarketHolidayName(kstTime);
  if (holidayName) {
    buyTriggerRunning = false;
    return;
  }

  try {
    await processAccountBuy(currentMinute, todayStr, ctx);
  } catch (err) {
    console.error('[ScalpV3] Buy trigger error:', err);
    await sendAlert('매수 트리거 실패', `${err instanceof Error ? err.message : String(err)}`, ctx);
  } finally {
    buyTriggerRunning = false;
  }
}

// ========================================
// 매도 트리거 (cron에서 호출)
// ========================================

export async function runMomentumScalpSellKR(ctx?: AccountContext): Promise<void> {
  if (!isKRMarketOpen()) return;

  if (sellTriggerRunning) {
    console.log('[ScalpV3-Sell] Previous trigger still running, skipping');
    return;
  }
  sellTriggerRunning = true;

  const kstTime = new Date(Date.now() + 9 * 60 * 60 * 1000);
  const todayStr = getKSTDateString();
  const holidayName = getKRMarketHolidayName(kstTime);
  if (holidayName) {
    sellTriggerRunning = false;
    return;
  }

  const currentMinute = getKSTCurrentMinute();

  try {
    await processSellAccount(todayStr, currentMinute, ctx);
  } catch (err) {
    console.error('[ScalpV3-Sell] Trigger error:', err);
  } finally {
    sellTriggerRunning = false;
  }
}

// ========================================
// forceStop (텔레그램 등에서 호출)
// ========================================

export async function forceStopMomentumScalp(ticker: string, ctx?: AccountContext): Promise<{ success: boolean; message: string }> {
  if (!ticker) return { success: false, message: 'ticker 필수' };

  try {
    const store = ctx?.store ?? localStore;
    const scalpConfig = store.getStrategyConfig<MomentumScalpConfig>('domestic', 'momentumScalp');
    const isShadow = scalpConfig?.shadowMode === true;

    // v3: composite key로 찾기 — 모든 전략에서 해당 ticker 검색
    const allStates = getAllScalpStatesV3(store);
    let found = false;

    for (const [stateKey, state] of allStates) {
      const parsed = parseStateKey(stateKey);
      if (!parsed || parsed.ticker !== ticker) continue;

      found = true;
      const strategyId = parsed.strategyId;

      if (isShadow) {
        const todayStr = getKSTDateString();
        if (state.status !== 'armed' && state.entryPrice && state.entryQuantity) {
          store.appendLog('scalpShadowLogs', todayStr, {
            type: 'FORCE_STOP',
            ticker, stockName: state.stockName || ticker,
            market: 'domestic', strategyId, strategyVersion: state.strategyVersion || '0.0',
            strategy: 'quickScalp',
            entryPrice: state.entryPrice, entryQuantity: state.entryQuantity,
            status: state.status, reason: 'force_stop_shadow',
            createdAt: new Date().toISOString(),
          });
        }
        deleteScalpStateV3(strategyId, ticker, store);
        clearPriceTrail(strategyId, ticker);
      } else {
        // 실전 모드: 기존 v2 forceStop 로직 재사용
        // 간략화 — 실전 모드는 Phase 4에서 점진 전환, 여기서는 v2 함수 호출
        const legacyState = getMomentumScalpStateByTicker(stateKey, store);
        if (legacyState) {
          deleteMomentumScalpState(stateKey, store);
        }
      }
    }

    if (!found) {
      return { success: false, message: `${ticker} 보유 종목이 없습니다` };
    }

    const chatId = await getUserTelegramChatId(config.userId);
    if (chatId) {
      await sendTelegramMessage(chatId, `⚠️ <b>[스캘핑] ${ticker} 강제 청산</b>`, 'HTML');
    }
    return { success: true, message: `${ticker} 강제 청산 완료` };
  } catch (err) {
    console.error('[ScalpV3:ForceStop] Error:', err);
    return { success: false, message: err instanceof Error ? err.message : String(err) };
  }
}

// ========================================
// 매수 처리 메인
// ========================================

async function processAccountBuy(
  currentMinute: number, todayStr: string, ctx?: AccountContext,
): Promise<void> {
  const store = ctx?.store ?? localStore;
  const common = ctx ? ctx.store.getTradingConfig<CommonConfig>() : getCommonConfig();
  if (!common) return;
  if (!isMarketStrategyActive(common, 'domestic', 'momentumScalp')) return;

  const scalpConfig = ctx
    ? ctx.store.getStrategyConfig<MomentumScalpConfig>('domestic', 'momentumScalp')
    : getMarketStrategyConfig<MomentumScalpConfig>('domestic', 'momentumScalp');
  if (!scalpConfig || !scalpConfig.enabled) return;
  if (!scalpConfig.conditionSeq || !scalpConfig.htsUserId) return;

  // v3.1 config 파싱 (하위 호환: strategies 필드 없으면 4전략 기본 활성)
  const v3Config = scalpConfig as unknown as MomentumScalpConfigV3;
  const strategyConfigs: Record<string, StrategySlotConfig> = v3Config.strategies ?? {
    trend_pullback_resume: { enabled: true, maxSlots: 3 },
    compression_pop: { enabled: true, maxSlots: 3 },
    flush_reclaim: { enabled: true, maxSlots: 3 },
    opening_range_break_retest: { enabled: true, maxSlots: 2 },
  };

  const enabledStrategies = getEnabledStrategies(strategyConfigs as Record<StrategyId, StrategySlotConfig>);
  if (enabledStrategies.length === 0) return;

  const credentials = ctx
    ? { appKey: ctx.credentials.appKey, appSecret: ctx.credentials.appSecret }
    : { appKey: config.kis.appKey, appSecret: config.kis.appSecret };
  const kisClient = ctx?.kisClient ?? new KisApiClient();
  const accountNo = ctx?.credentials.accountNo ?? config.kis.accountNo;
  const accountId = ctx?.accountId ?? config.accountId;

  const accessToken = await getOrRefreshToken('', accountId, credentials, kisClient);
  const { appKey, appSecret } = credentials;

  if (currentMinute < BUY_START_MINUTE || currentMinute >= BUY_END_MINUTE) return;
  if (currentMinute >= LUNCH_SKIP_START && currentMinute < LUNCH_SKIP_END) return;

  // v3.1: reset near_miss counters per scan cycle
  resetNearMissCounters();

  await handleNewBuyV3(
    scalpConfig, v3Config, enabledStrategies,
    kisClient, appKey, appSecret, accessToken, accountNo,
    todayStr, currentMinute, store, ctx,
  );
}

// ========================================
// v3 신규 종목 선정 + 전략별 평가 + 매수
// ========================================

async function handleNewBuyV3(
  scalpConfig: MomentumScalpConfig,
  v3Config: MomentumScalpConfigV3,
  strategies: ScalpStrategy[],
  kisClient: KisApiClient,
  appKey: string, appSecret: string, accessToken: string, accountNo: string,
  todayStr: string, currentMinute: number,
  store: localStore.AccountStore | typeof localStore,
  ctx?: AccountContext,
): Promise<void> {
  const isShadow = scalpConfig.shadowMode || false;

  // 전략별 슬롯 여유 사전 체크
  const strategyConfigs = v3Config.strategies ?? {};
  const strategyAvail = new Map<StrategyId, { fillable: boolean; amountPerSlot: number }>();

  for (const strategy of strategies) {
    const sConf = strategyConfigs[strategy.id] ?? { enabled: true, maxSlots: 3 };
    const avail = calculateStrategySlotAvailability(
      strategy.id, sConf, scalpConfig.amountPerStock, isShadow, store as localStore.AccountStore,
    );
    strategyAvail.set(strategy.id, { fillable: avail.fillable, amountPerSlot: avail.amountPerSlot });
  }

  // 슬롯 상태 로그
  const slotStatusLog: Record<string, unknown> = { type: 'SLOT_STATUS', checkedAt: new Date().toISOString() };
  for (const strategy of strategies) {
    const a = strategyAvail.get(strategy.id)!;
    const occupied = getOccupiedStateKeysByStrategy(strategy.id, store as localStore.AccountStore);
    slotStatusLog[`${strategy.id}_occupied`] = occupied.length;
    slotStatusLog[`${strategy.id}_fillable`] = a.fillable;
  }
  store.appendLog('scalpScanLogs', todayStr, slotStatusLog);

  // 진입 가능한 전략이 하나도 없으면 스캔 생략
  const anyFillable = strategies.some(s => strategyAvail.get(s.id)?.fillable);
  if (!anyFillable) {
    console.log('[ScalpV3] 모든 전략 슬롯 풀, 스캔 생략');
    return;
  }

  // HTS 조건검색 (1회 공유)
  const conditionResult = await kisClient.getConditionSearchResult(
    appKey, appSecret, accessToken,
    scalpConfig.htsUserId, scalpConfig.conditionSeq,
  );
  await new Promise(resolve => setTimeout(resolve, 500));

  const candidates = conditionResult.output2 || [];
  if (candidates.length === 0) return;

  // 거래대금 정렬 → Top 20
  candidates.sort((a, b) => parseFloat(b.trade_amt || '0') - parseFloat(a.trade_amt || '0'));
  const topCandidates = candidates.slice(0, MAX_EVAL_CANDIDATES);

  store.appendLog('scalpScanLogs', todayStr, {
    type: 'CONDITION_RESULT',
    conditionSeq: scalpConfig.conditionSeq,
    totalCandidates: candidates.length,
    candidates: topCandidates.map(t => ({ ticker: t.code, name: t.name, tradeAmt: t.trade_amt })),
    checkedAt: new Date().toISOString(),
  });

  // 쿨다운 + 일일 진입 횟수 (전략 무관, 종목 기준)
  const cooldownTickers = new Set<string>();
  if (scalpConfig.cooldownEnabled) {
    const logCol = isShadow ? 'scalpShadowLogs' : 'scalpTradeLogs';
    const todayLogs = store.getLogs<{ ticker: string; exitReason?: string }>(logCol, todayStr);
    for (const log of todayLogs) {
      if (log.exitReason === 'stop_loss' || log.exitReason === 'timeout') {
        cooldownTickers.add(log.ticker);
      }
    }
  }

  const dailyEntryCount = new Map<string, number>();
  const logCollection = isShadow ? 'scalpShadowLogs' : 'scalpTradeLogs';
  const todayTradeLogs = store.getLogs<{ ticker: string; type?: string }>(logCollection, todayStr);
  for (const log of todayTradeLogs) {
    if (log.type === 'ENTRY' || (!log.type && log.ticker)) {
      dailyEntryCount.set(log.ticker, (dailyEntryCount.get(log.ticker) ?? 0) + 1);
    }
  }
  const allStates = getAllScalpStatesV3(store as localStore.AccountStore);
  for (const [, s] of allStates) {
    if (['active', 'pending_buy', 'pending_sell'].includes(s.status)) {
      dailyEntryCount.set(s.ticker, (dailyEntryCount.get(s.ticker) ?? 0) + 1);
    }
  }

  // 타 전략(스윙 등) 점유 종목
  const otherStrategyOccupied = getOccupiedTickersExcluding('domestic', 'momentumScalp');

  // 우선주/점유/쿨다운 사전 필터
  const evalTargets: Array<{ ticker: string; name: string; price: number; rank: number }> = [];
  for (let i = 0; i < topCandidates.length; i++) {
    const c = topCandidates[i];
    const ticker = c.code;
    const name = c.name;
    const price = Math.round(parseFloat(c.price || '0'));

    const isPreferred = (ticker.length === 6 && ticker.endsWith('5')) ||
      /[KLMN]$/.test(ticker) ||
      name.includes('우선') || (name.endsWith('우') && !name.endsWith('건설우'));
    if (isPreferred) continue;
    if (otherStrategyOccupied.has(ticker)) continue;
    if (cooldownTickers.has(ticker)) continue;
    if ((dailyEntryCount.get(ticker) ?? 0) >= MAX_ENTRIES_PER_TICKER_PER_DAY) continue;
    if (price <= 0) continue;

    evalTargets.push({ ticker, name, price, rank: i + 1 });
  }

  // 스캔 통계
  const scanStats = {
    conditionSearchCount: candidates.length,
    evalCount: evalTargets.length,
    invalidPriceCount: 0,
    codeFilterFailCount: 0,
    entrySignalCount: 0,
    perStrategySignals: {} as Record<string, number>,
    perStrategyFails: {} as Record<string, Record<string, number>>,
  };
  for (const s of strategies) {
    scanStats.perStrategySignals[s.id] = 0;
    scanStats.perStrategyFails[s.id] = {};
  }

  const evalDetails: unknown[] = [];

  // ── 후보별 순차 평가 ──
  for (const target of evalTargets) {
    try {
      // 호가 조회 (1회)
      const askingPrice = await kisClient.getDomesticAskingPrice(
        appKey, appSecret, accessToken, target.ticker,
      );
      await new Promise(resolve => setTimeout(resolve, 300));

      const askPrice = parseInt(askingPrice.output1?.askp1 || '0');
      const bidPrice = parseInt(askingPrice.output1?.bidp1 || '0');
      const currentPrice = parseInt(askingPrice.output2?.stck_prpr || '0');

      if (askPrice <= 0 || bidPrice <= 0 || currentPrice <= 0) {
        scanStats.invalidPriceCount++;
        continue;
      }

      // 공통 코드 필터
      const filterResult = filterQuickScalpCandidate({
        ticker: target.ticker, stockName: target.name,
        currentPrice, askPrice, bidPrice,
      });

      if (!filterResult.pass) {
        scanStats.codeFilterFailCount++;
        evalDetails.push({
          ticker: target.ticker, name: target.name, price: currentPrice,
          stage: 'codeFilter', pass: false, reason: filterResult.reason,
          askPrice, bidPrice,
          spreadTicks: filterResult.spreadTicks, targetTicks: filterResult.targetTicks,
        });
        continue;
      }

      // 분봉 fetch (1회, 전 전략 공유)
      const minuteBars = await fetchPaginatedMinuteBars(
        kisClient, appKey, appSecret, accessToken, target.ticker, 15, 1,
      );
      await new Promise(resolve => setTimeout(resolve, 300));

      // CandidateContext 구성
      const candidateCtx: CandidateContext = {
        ticker: target.ticker,
        stockName: target.name,
        currentPrice, askPrice, bidPrice,
        spreadTicks: filterResult.spreadTicks,
        targetTicks: filterResult.targetTicks,
        minuteBars,
        currentMinute,
        todayStr,
        candidateRank: target.rank,
      };

      // ── 전략별 평가 ──
      for (const strategy of strategies) {
        const avail = strategyAvail.get(strategy.id)!;
        if (!avail.fillable) continue;
        if (!strategy.isActiveAt(currentMinute)) continue;

        // composite key 점유 체크
        const existingState = getScalpStateV3(strategy.id, target.ticker, store as localStore.AccountStore);
        if (existingState) continue;

        // 전략 평가 (순수 함수)
        const signal = strategy.evaluate(candidateCtx);

        if (!signal.shouldEnter) {
          const failKey = signal.reason.slice(0, 40);
          scanStats.perStrategyFails[strategy.id][failKey] =
            (scanStats.perStrategyFails[strategy.id][failKey] || 0) + 1;

          // nearMiss → candidate moment 로그
          if (signal.nearMiss) {
            const closes = minuteBars.map(b => b.close);
            const c3ago = closes.length >= 4 ? closes[closes.length - 4] : closes[0];
            const cNow = closes[closes.length - 1];
            const mom3m = c3ago > 0 ? ((cNow - c3ago) / c3ago) * 100 : null;

            writeCandidateMomentLog({
              type: 'CANDIDATE_MOMENT',
              momentType: 'near_miss',
              ticker: target.ticker,
              stockName: target.name,
              strategyId: strategy.id,
              strategyVersion: strategy.version,
              signalReason: signal.reason,
              currentPrice, askPrice, bidPrice,
              triggerLevel: signal.triggerLevel ?? null,
              recent3mMomentumPct: mom3m !== null ? Number(mom3m.toFixed(2)) : null,
              ema10DistancePct: (signal.entryMeta.ema10DistancePct as number) ?? null,
              ema10Slope: (signal.entryMeta.ema10Slope as number) ?? null,
              candidateRank: target.rank,
              signalMinuteBucket: minuteToBucket(currentMinute),
              armElapsedMs: null,
              worstPriceDuringArm: null,
              createdAt: new Date().toISOString(),
            }, ctx);
          }
          continue;
        }

        // 진입 실행
        const buyPrice = bidPrice + getKoreanTickSize(bidPrice);
        const quantity = Math.floor(avail.amountPerSlot / buyPrice);
        if (quantity <= 0) continue;

        const { targetPrice: tp, stopLossPrice: sl } = calculateQuickScalpTarget(buyPrice);
        const signalBucket = minuteToBucket(currentMinute);

        const entryConditions = {
          entryBoxPos: (signal.entryMeta.entryBoxPos as number) ?? null,
          boxRangePct: (signal.entryMeta.boxRangePct as number) ?? null,
          spreadTicks: filterResult.spreadTicks,
          targetTicks: filterResult.targetTicks,
        };

        if (isShadow) {
          // v3.1: armed 분기 — triggerLevel 있으면 armed 상태로 생성
          if (signal.triggerLevel != null) {
            createArmedScalpStateV3(
              strategy.id, strategy.version,
              target.ticker, target.name,
              avail.amountPerSlot,
              signal.triggerLevel,
              signal.triggerDirection ?? 'above',
              signal.armDurationMs ?? 7000,
              signal.reason,
              entryConditions, signal.entryMeta,
              {
                candidateRank: target.rank, signalMinuteBucket: signalBucket,
                fillModel: null,
                entryPrice: buyPrice, entryQuantity: quantity,
                targetPrice: tp, stopLossPrice: sl,
              },
              store as localStore.AccountStore,
            );

            store.appendLog('scalpScanLogs', todayStr, {
              type: 'ARMED',
              ticker: target.ticker, stockName: target.name,
              strategyId: strategy.id, strategyVersion: strategy.version,
              triggerLevel: signal.triggerLevel,
              triggerDirection: signal.triggerDirection ?? 'above',
              armDurationMs: signal.armDurationMs ?? 7000,
              reason: signal.reason,
              buyPrice, quantity, tp, sl,
              createdAt: new Date().toISOString(),
            });

            console.log(`[ScalpV3:${strategy.id}] ARMED: ${target.name}(${target.ticker}) trigger=${signal.triggerLevel} ${signal.armDurationMs ?? 7000}ms`);
          } else {
            // triggerLevel 없음 → 기존 동작 (즉시 pending_buy)
            const now = new Date().toISOString();

            createMomentumScalpStateV3(
              strategy.id, strategy.version,
              target.ticker, target.name,
              avail.amountPerSlot, null,
              entryConditions, signal.entryMeta,
              { candidateRank: target.rank, signalMinuteBucket: signalBucket, fillModel: null },
              store as localStore.AccountStore, now,
            );

            const pendingKey = makeStateKey(strategy.id, target.ticker);
            (store as typeof localStore).updateState('momentumScalpState', pendingKey, {
              entryPrice: buyPrice, entryQuantity: quantity,
              targetPrice: tp, stopLossPrice: sl,
            });

            writeShadowPendingEntryLog({
              ticker: target.ticker, stockName: target.name,
              strategyId: strategy.id, strategyVersion: strategy.version,
              entryPrice: buyPrice, entryQuantity: quantity,
              allocatedAmount: avail.amountPerSlot,
              targetPrice: tp, stopLossPrice: sl,
              entryBoxPos: entryConditions.entryBoxPos,
              boxRangePct: entryConditions.boxRangePct,
              boxHigh: (signal.entryMeta.boxHigh as number) ?? null,
              boxLow: (signal.entryMeta.boxLow as number) ?? null,
              spreadTicks: filterResult.spreadTicks,
              targetTicks: filterResult.targetTicks,
              currentPrice, askPrice, bidPrice,
              recentBars: minuteBars.slice(-10).map(b => ({
                t: b.time, o: b.open, h: b.high, l: b.low, c: b.close,
              })),
              candidateRank: target.rank,
              signalMinuteBucket: signalBucket,
              entryMeta: signal.entryMeta,
            }, ctx);

            console.log(`[ScalpV3:${strategy.id}] PENDING_ENTRY: ${target.name}(${target.ticker}) ${quantity}주 @ ${buyPrice} TP=${tp} SL=${sl}`);
          }
        } else {
          // 실전 모드
          const orderResult = await kisClient.submitDomesticOrder(
            appKey, appSecret, accessToken, accountNo,
            { ticker: target.ticker, side: 'BUY', orderType: 'LIMIT', price: buyPrice, quantity },
          );
          await new Promise(resolve => setTimeout(resolve, 500));

          if (orderResult.output?.ODNO) {
            createMomentumScalpStateV3(
              strategy.id, strategy.version,
              target.ticker, target.name,
              avail.amountPerSlot, orderResult.output.ODNO,
              entryConditions, signal.entryMeta,
              { candidateRank: target.rank, signalMinuteBucket: signalBucket, fillModel: null },
              store as localStore.AccountStore,
            );
            console.log(`[ScalpV3:${strategy.id}] BUY ORDER: ${target.name}(${target.ticker}) ${quantity}주 @ ${buyPrice} (${orderResult.output.ODNO})`);
          }
        }

        scanStats.entrySignalCount++;
        scanStats.perStrategySignals[strategy.id]++;

        // 슬롯 여유 재체크
        const sConf = (v3Config.strategies ?? {})[strategy.id] ?? { enabled: true, maxSlots: 3 };
        const newAvail = calculateStrategySlotAvailability(
          strategy.id, sConf, scalpConfig.amountPerStock, isShadow, store as localStore.AccountStore,
        );
        strategyAvail.set(strategy.id, { fillable: newAvail.fillable, amountPerSlot: newAvail.amountPerSlot });
      }
    } catch (err) {
      console.error(`[ScalpV3] ${target.name}(${target.ticker}) eval error:`, err);
    }
  }

  // 스캔 통계 로그
  try {
    store.appendLog('scalpScanLogs', todayStr, {
      ...scanStats,
      evalDetails,
      currentMinute,
      shadowMode: isShadow,
      strategies: strategies.map(s => s.id),
      createdAt: new Date().toISOString(),
    });
  } catch (logErr) {
    console.error('[ScalpV3] Scan log write failed:', logErr);
  }
}

// ========================================
// 매도 처리 메인
// ========================================

async function processSellAccount(
  todayStr: string, currentMinute: number, ctx?: AccountContext,
): Promise<void> {
  const store = ctx?.store ?? localStore;
  const common = ctx ? ctx.store.getTradingConfig<CommonConfig>() : getCommonConfig();
  if (!common) return;

  const scalpConfig = ctx
    ? ctx.store.getStrategyConfig<MomentumScalpConfig>('domestic', 'momentumScalp')
    : getMarketStrategyConfig<MomentumScalpConfig>('domestic', 'momentumScalp');
  if (!scalpConfig || !scalpConfig.enabled) return;

  const credentials = ctx
    ? { appKey: ctx.credentials.appKey, appSecret: ctx.credentials.appSecret }
    : { appKey: config.kis.appKey, appSecret: config.kis.appSecret };
  const kisClient = ctx?.kisClient ?? new KisApiClient();
  const accountNo = ctx?.credentials.accountNo ?? config.kis.accountNo;
  const accountId = ctx?.accountId ?? config.accountId;
  let accessToken = await getOrRefreshToken('', accountId, credentials, kisClient);
  const chatId = await getUserTelegramChatId(config.userId);
  const { appKey, appSecret } = credentials;
  const isShadow = scalpConfig.shadowMode || false;

  // v3: 전체 상태 조회 (composite key 지원)
  const allStates = getAllScalpStatesV3(store as localStore.AccountStore);

  // ── 1차: pending_sell 체결 확인 ──
  for (const [stateKey, state] of allStates) {
    if (state.status !== 'pending_sell') continue;
    const parsed = parseStateKey(stateKey);
    if (!parsed) continue;

    try {
      accessToken = await handlePendingSellV3(
        state, parsed.strategyId, currentMinute,
        kisClient, appKey, appSecret, accessToken, accountNo,
        todayStr, chatId, store, ctx,
      );
    } catch (err) {
      if (isTokenExpiredError(err)) {
        accessToken = await getOrRefreshToken('', accountId, credentials, kisClient, true);
      }
      console.error(`[ScalpV3-Sell] PendingSell error ${stateKey}:`, err);
    }
    await new Promise(resolve => setTimeout(resolve, 300));
  }

  // ── 장마감 종가 단일가 (15:20+) ──
  if (currentMinute >= MARKET_CLOSE_AUCTION_MINUTE) {
    for (const [stateKey, state] of allStates) {
      const parsed = parseStateKey(stateKey);
      if (!parsed) continue;

      if (state.status === 'armed' || state.status === 'pending_buy') {
        if (!isShadow && state.pendingOrderNo) {
          try {
            await kisClient.cancelDomesticOrder(appKey, appSecret, accessToken, accountNo,
              { orderNo: state.pendingOrderNo, ticker: state.ticker });
          } catch { /* ignore */ }
          await new Promise(resolve => setTimeout(resolve, 300));
        }
        if (isShadow) {
          writeShadowCancelLog({
            ticker: state.ticker, stockName: state.stockName || state.ticker,
            strategyId: parsed.strategyId, strategyVersion: state.strategyVersion || '0.0',
            reason: state.status === 'armed' ? 'market_close_armed_cancel' : 'market_close_pending_buy_cancel',
            elapsedSec: 0, entryPrice: state.entryPrice || 0,
            currentBid: 0, lastAsk: 0,
            fillConservativeAtCancel: false, fillOptimisticAtCancel: false,
            allocatedAmount: state.allocatedAmount,
          }, ctx);
        }
        deleteScalpStateV3(parsed.strategyId, state.ticker, store as localStore.AccountStore);
        clearPriceTrail(parsed.strategyId, state.ticker);
      }

      if (state.status === 'active') {
        if (!state.entryPrice || !state.entryQuantity || state.entryQuantity <= 0) continue;

        if (isShadow) {
          const askingPrice = await kisClient.getDomesticAskingPrice(
            appKey, appSecret, accessToken, state.ticker);
          await new Promise(resolve => setTimeout(resolve, 200));

          const bidPrice = parseInt(askingPrice.output1?.bidp1 || '0');
          const curPrice = parseInt(askingPrice.output2?.stck_prpr || '0');
          const exitPrice = bidPrice > 0 ? bidPrice : curPrice;
          if (exitPrice <= 0) continue;

          writeShadowExitLog({
            ticker: state.ticker, stockName: state.stockName || state.ticker,
            strategyId: parsed.strategyId, strategyVersion: state.strategyVersion || '0.0',
            entryPrice: state.entryPrice, entryQuantity: state.entryQuantity,
            exitPrice, exitReason: 'market_close_auction',
            allocatedAmount: state.allocatedAmount, enteredAt: state.enteredAt,
            entryBoxPos: state.entryBoxPos, boxRangePct: state.boxRangePct,
            spreadTicks: state.spreadTicks, targetTicks: state.targetTicks,
            bestBidAtExit: bidPrice, currentPriceAtExit: curPrice,
            bestProfitPct: state.bestProfitPct,
            mfe60Pct: state.mfe60Pct, mfe120Pct: state.mfe120Pct,
            candidateRank: (state as any).candidateRank,
            signalMinuteBucket: (state as any).signalMinuteBucket,
            fillModel: (state as any).fillModel,
            entryMeta: state.entryMeta,
          }, ctx);

          deleteScalpStateV3(parsed.strategyId, state.ticker, store as localStore.AccountStore);
          clearPriceTrail(parsed.strategyId, state.ticker);
        } else {
          // 실전: MARKET 매도
          try {
            const sellResult = await kisClient.submitDomesticOrder(
              appKey, appSecret, accessToken, accountNo,
              { ticker: state.ticker, side: 'SELL', orderType: 'MARKET', price: 0, quantity: state.entryQuantity },
            );
            if (sellResult.output?.ODNO) {
              updateScalpStateToPendingSellV3(
                parsed.strategyId, state.ticker, sellResult.output.ODNO,
                'market_close_auction', undefined, store as localStore.AccountStore,
              );
            }
          } catch (err) {
            console.error(`[ScalpV3-Sell] ${state.ticker} close auction sell failed:`, err);
          }
        }
        await new Promise(resolve => setTimeout(resolve, 300));
      }
    }
    return;
  }

  // ── 2차: 고속 반복 체크 (5초×9회) ──
  const startMs = Date.now();
  const exitedKeys = new Set<string>();

  for (let round = 0; round < EXIT_CHECK_MAX_ROUNDS; round++) {
    if (Date.now() - startMs > 40000) break;

    const roundStates = getAllScalpStatesV3(store as localStore.AccountStore);
    const activeOrPending = Array.from(roundStates.entries())
      .filter(([, s]) => s.status === 'armed' || s.status === 'pending_buy' || s.status === 'active');

    if (activeOrPending.length === 0 && round === 0) break;

    // [v3.1] armed 상태 체크
    for (const [stateKey, state] of activeOrPending) {
      if (state.status !== 'armed') continue;
      const parsed = parseStateKey(stateKey);
      if (!parsed) continue;

      try {
        accessToken = await handleArmedCheck(
          state, parsed.strategyId,
          kisClient, appKey, appSecret, accessToken,
          todayStr, isShadow, store, ctx,
        );
      } catch (err) {
        if (isTokenExpiredError(err)) {
          accessToken = await getOrRefreshToken('', accountId, credentials, kisClient, true);
        }
      }
      await new Promise(resolve => setTimeout(resolve, 200));
    }

    // pending_buy 체결 확인
    for (const [stateKey, state] of activeOrPending) {
      if (state.status !== 'pending_buy') continue;
      const parsed = parseStateKey(stateKey);
      if (!parsed) continue;

      try {
        accessToken = await handlePendingBuyV3(
          state, parsed.strategyId,
          kisClient, appKey, appSecret, accessToken, accountNo,
          todayStr, chatId, isShadow, store, ctx,
          scalpConfig.pendingBuyTtlMs,
        );
      } catch (err) {
        if (isTokenExpiredError(err)) {
          accessToken = await getOrRefreshToken('', accountId, credentials, kisClient, true);
        }
      }
      await new Promise(resolve => setTimeout(resolve, 200));
    }

    // active 종목 exit 체크
    for (const [stateKey, state] of activeOrPending) {
      if (state.status !== 'active') continue;
      if (exitedKeys.has(stateKey)) continue;
      const parsed = parseStateKey(stateKey);
      if (!parsed) continue;

      try {
        accessToken = await handleSellCheckV3(
          state, parsed.strategyId,
          kisClient, appKey, appSecret, accessToken, accountNo,
          chatId, isShadow, store, ctx,
        );
        // 청산 확인
        const postState = getScalpStateV3(parsed.strategyId, parsed.ticker, store as localStore.AccountStore);
        if (!postState) exitedKeys.add(stateKey);
      } catch (err) {
        if (isTokenExpiredError(err)) {
          accessToken = await getOrRefreshToken('', accountId, credentials, kisClient, true);
        }
      }
      await new Promise(resolve => setTimeout(resolve, 300));
    }

    if (round < EXIT_CHECK_MAX_ROUNDS - 1) {
      await new Promise(resolve => setTimeout(resolve, EXIT_CHECK_INTERVAL_MS));
    }
  }

  // HOLD 스냅샷 flush
  if (sellCheckSnapshots.size > 0) {
    const flushDate = getKSTDateString();
    for (const snapshot of sellCheckSnapshots.values()) {
      store.appendLog('scalpSellCheckLogs', flushDate, snapshot);
    }
    sellCheckSnapshots.clear();
  }
}

// ========================================
// armed 상태 체크 (v3.1)
// ========================================

async function handleArmedCheck(
  state: MomentumScalpStateV3,
  strategyId: StrategyId,
  kisClient: KisApiClient,
  appKey: string, appSecret: string, accessToken: string,
  todayStr: string,
  isShadow: boolean,
  store: localStore.AccountStore | typeof localStore,
  ctx?: AccountContext,
): Promise<string> {
  const { ticker, stockName, armedAt, armedTriggerLevel, armedTriggerDirection, armedDurationMs } = state;
  if (!armedAt || armedTriggerLevel == null || !armedDurationMs) {
    // invalid armed state — clean up
    deleteScalpStateV3(strategyId, ticker, store as localStore.AccountStore);
    return accessToken;
  }

  const armedAtMs = new Date(armedAt).getTime();
  const elapsedMs = Date.now() - armedAtMs;

  // 호가 조회
  const askingPrice = await kisClient.getDomesticAskingPrice(appKey, appSecret, accessToken, ticker);
  await new Promise(resolve => setTimeout(resolve, 200));

  const currentBid = parseInt(askingPrice.output1?.bidp1 || '0');
  const currentAsk = parseInt(askingPrice.output1?.askp1 || '0');
  const currentPrice = parseInt(askingPrice.output2?.stck_prpr || '0');
  if (currentBid <= 0 || currentPrice <= 0) return accessToken;

  // triggerLevel 유지 여부 체크
  const triggerHeld = armedTriggerDirection === 'above'
    ? currentBid >= armedTriggerLevel
    : currentBid <= armedTriggerLevel;

  if (elapsedMs >= armedDurationMs) {
    if (triggerHeld) {
      // armed 확인 성공 → pending_buy 전환
      transitionArmedToPendingBuy(strategyId, ticker, store as localStore.AccountStore);

      // pending_buy에 매수가/수량 설정 (armed 생성 시 이미 설정됨)
      store.appendLog('scalpScanLogs', todayStr, {
        type: 'ARMED_CONFIRMED',
        ticker, stockName: stockName || ticker,
        strategyId, strategyVersion: state.strategyVersion || '0.0',
        triggerLevel: armedTriggerLevel,
        armElapsedMs: elapsedMs,
        currentBid, currentPrice,
        createdAt: new Date().toISOString(),
      });

      // PENDING_ENTRY 로그
      writeShadowPendingEntryLog({
        ticker, stockName: stockName || ticker,
        strategyId, strategyVersion: state.strategyVersion || '0.0',
        entryPrice: state.entryPrice ?? 0,
        entryQuantity: state.entryQuantity ?? 0,
        allocatedAmount: state.allocatedAmount,
        targetPrice: state.targetPrice ?? 0,
        stopLossPrice: state.stopLossPrice ?? 0,
        entryBoxPos: state.entryBoxPos,
        boxRangePct: state.boxRangePct,
        boxHigh: null, boxLow: null,
        spreadTicks: state.spreadTicks,
        targetTicks: state.targetTicks,
        currentPrice, askPrice: currentAsk, bidPrice: currentBid,
        recentBars: [],
        candidateRank: (state as any).candidateRank,
        signalMinuteBucket: (state as any).signalMinuteBucket,
        entryMeta: { ...state.entryMeta, armElapsedMs: elapsedMs },
      }, ctx);

      console.log(`[ScalpV3:${strategyId}] ARMED→PENDING: ${ticker} (${elapsedMs}ms)`);
    } else {
      // armed 타임아웃 — triggerLevel 유지 못함
      writeCandidateMomentLog({
        type: 'CANDIDATE_MOMENT',
        momentType: 'armed_timeout',
        ticker, stockName: stockName || ticker,
        strategyId, strategyVersion: state.strategyVersion || '0.0',
        signalReason: state.armedSignalReason || '',
        currentPrice, askPrice: currentAsk, bidPrice: currentBid,
        triggerLevel: armedTriggerLevel,
        recent3mMomentumPct: null,
        ema10DistancePct: null,
        ema10Slope: null,
        candidateRank: (state as any).candidateRank,
        signalMinuteBucket: (state as any).signalMinuteBucket,
        armElapsedMs: elapsedMs,
        worstPriceDuringArm: currentBid,
        createdAt: new Date().toISOString(),
      }, ctx);

      deleteScalpStateV3(strategyId, ticker, store as localStore.AccountStore);
      console.log(`[ScalpV3:${strategyId}] ARMED_TIMEOUT: ${ticker} (${elapsedMs}ms, bid=${currentBid} < trigger=${armedTriggerLevel})`);
    }
  } else if (!triggerHeld) {
    // armed 기간 미경과 + triggerLevel 이탈 → armed_fail
    writeCandidateMomentLog({
      type: 'CANDIDATE_MOMENT',
      momentType: 'armed_fail',
      ticker, stockName: stockName || ticker,
      strategyId, strategyVersion: state.strategyVersion || '0.0',
      signalReason: state.armedSignalReason || '',
      currentPrice, askPrice: currentAsk, bidPrice: currentBid,
      triggerLevel: armedTriggerLevel,
      recent3mMomentumPct: null,
      ema10DistancePct: null,
      ema10Slope: null,
      candidateRank: (state as any).candidateRank,
      signalMinuteBucket: (state as any).signalMinuteBucket,
      armElapsedMs: elapsedMs,
      worstPriceDuringArm: currentBid,
      createdAt: new Date().toISOString(),
    }, ctx);

    deleteScalpStateV3(strategyId, ticker, store as localStore.AccountStore);
    console.log(`[ScalpV3:${strategyId}] ARMED_FAIL: ${ticker} (${elapsedMs}ms, bid=${currentBid} broke trigger=${armedTriggerLevel})`);
  }
  // else: armed 기간 미경과 + triggerLevel 유지 → 대기 계속

  return accessToken;
}

// ========================================
// pending_buy 체결 확인 (v3)
// ========================================

async function handlePendingBuyV3(
  state: MomentumScalpStateV3,
  strategyId: StrategyId,
  kisClient: KisApiClient,
  appKey: string, appSecret: string, accessToken: string, accountNo: string,
  todayStr: string, chatId: string | null,
  isShadow: boolean,
  store: localStore.AccountStore | typeof localStore,
  ctx?: AccountContext,
  pendingBuyTtlMs?: number,
): Promise<string> {
  const { ticker, stockName } = state;

  if (state.shadowPendingAt) {
    // Shadow fill 확인
    const pendingAtMs = new Date(state.shadowPendingAt).getTime();
    const elapsedMs = Date.now() - pendingAtMs;
    const elapsedSec = Math.round(elapsedMs / 1000);

    const askingPrice = await kisClient.getDomesticAskingPrice(appKey, appSecret, accessToken, ticker);
    await new Promise(resolve => setTimeout(resolve, 200));

    const currentBid = parseInt(askingPrice.output1?.bidp1 || '0');
    const bestAsk = parseInt(askingPrice.output1?.askp1 || '0');
    const entryPrice = state.entryPrice ?? 0;

    const tickSize = getKoreanTickSize(entryPrice || currentBid);
    const fillConservative = bestAsk > 0 && entryPrice > 0 && bestAsk <= entryPrice;
    const fillOptimistic = currentBid > 0 && entryPrice > 0 && (currentBid + tickSize) >= entryPrice;
    const isFillable = fillConservative;

    if (isFillable && elapsedMs >= 5000) {
      updateScalpStateToActiveV3(
        strategyId, ticker,
        entryPrice, state.entryQuantity ?? 0,
        state.targetPrice, state.stopLossPrice,
        'conservative',
        store as localStore.AccountStore,
      );

      writeShadowEntryLog({
        ticker, stockName: stockName || ticker,
        strategyId, strategyVersion: state.strategyVersion || '0.0',
        entryPrice, entryQuantity: state.entryQuantity ?? 0,
        allocatedAmount: state.allocatedAmount,
        targetPrice: state.targetPrice ?? 0,
        stopLossPrice: state.stopLossPrice ?? 0,
        fillElapsedSec: elapsedSec,
        fillBid: currentBid, fillAsk: bestAsk,
        fillModel: 'conservative',
        fillOptimisticWouldFill: fillOptimistic,
        entryBoxPos: state.entryBoxPos,
        boxRangePct: state.boxRangePct,
        spreadTicks: state.spreadTicks,
        targetTicks: state.targetTicks,
        entryMeta: state.entryMeta,
      }, ctx);

      console.log(`[ScalpV3:${strategyId}] FILL: ${ticker} (${elapsedSec}s, conservative)`);
      return accessToken;
    }

    const ttlMs = pendingBuyTtlMs ?? DEFAULT_PENDING_BUY_TTL_MS;
    if (elapsedMs >= ttlMs) {
      writeShadowCancelLog({
        ticker, stockName: stockName || ticker,
        strategyId, strategyVersion: state.strategyVersion || '0.0',
        reason: 'shadow_pending_ttl_expired',
        elapsedSec, entryPrice,
        currentBid, lastAsk: bestAsk,
        fillConservativeAtCancel: fillConservative,
        fillOptimisticAtCancel: fillOptimistic,
        allocatedAmount: state.allocatedAmount,
      }, ctx);

      deleteScalpStateV3(strategyId, ticker, store as localStore.AccountStore);
      console.log(`[ScalpV3:${strategyId}] CANCEL: ${ticker} TTL expired (${elapsedSec}s)`);
      return accessToken;
    }

    return accessToken;
  }

  // 실전 모드 pending_buy
  const { pendingOrderNo } = state;
  const orderHistory = await kisClient.getDomesticOrderHistory(
    appKey, appSecret, accessToken, accountNo, todayStr, todayStr, '01', '02', ticker,
  );
  await new Promise(resolve => setTimeout(resolve, 300));

  const filledOrder = orderHistory.output1?.find(
    o => o.odno === pendingOrderNo && parseInt(o.tot_ccld_qty || '0') > 0,
  );

  if (filledOrder) {
    const entryPrice = parseInt(filledOrder.avg_prvs || '0');
    const quantity = parseInt(filledOrder.tot_ccld_qty || '0');
    const { targetPrice, stopLossPrice } = calculateQuickScalpTarget(entryPrice);

    updateScalpStateToActiveV3(
      strategyId, ticker, entryPrice, quantity, targetPrice, stopLossPrice,
      null, store as localStore.AccountStore,
    );
    console.log(`[ScalpV3:${strategyId}] ${ticker} filled: ${quantity}주 @ ${entryPrice}`);
  } else {
    const updatedAtMs = state.updatedAt ? new Date(state.updatedAt).getTime() : 0;
    const realTtlMs = pendingBuyTtlMs ?? DEFAULT_PENDING_BUY_TTL_MS;
    if (Date.now() - updatedAtMs >= realTtlMs) {
      if (pendingOrderNo) {
        try {
          await kisClient.cancelDomesticOrder(appKey, appSecret, accessToken, accountNo,
            { orderNo: pendingOrderNo, ticker });
        } catch { /* ignore */ }
        await new Promise(resolve => setTimeout(resolve, 300));
      }
      deleteScalpStateV3(strategyId, ticker, store as localStore.AccountStore);
    }
  }

  return accessToken;
}

// ========================================
// active 종목 매도 판단 (v3)
// ========================================

async function handleSellCheckV3(
  state: MomentumScalpStateV3,
  strategyId: StrategyId,
  kisClient: KisApiClient,
  appKey: string, appSecret: string, accessToken: string, accountNo: string,
  chatId: string | null,
  isShadow: boolean,
  store: localStore.AccountStore | typeof localStore,
  ctx?: AccountContext,
): Promise<string> {
  const { ticker, stockName, entryPrice, entryQuantity, targetPrice, stopLossPrice } = state;
  if (!entryPrice || !entryQuantity || !targetPrice || !stopLossPrice) return accessToken;

  const askingPrice = await kisClient.getDomesticAskingPrice(appKey, appSecret, accessToken, ticker);
  await new Promise(resolve => setTimeout(resolve, 200));

  const currentPrice = parseInt(askingPrice.output2?.stck_prpr || '0');
  const bidPrice = parseInt(askingPrice.output1?.bidp1 || '0');
  if (currentPrice <= 0 || bidPrice <= 0) return accessToken;

  // 가격 궤적 기록
  recordPriceTrail(strategyId, ticker,
    new Date().toISOString().slice(11, 19), bidPrice, currentPrice);

  // 보유시간
  let holdingMinutes = 0;
  if (state.enteredAt) {
    holdingMinutes = getKRMarketMinutesBetween(new Date(state.enteredAt).getTime(), Date.now());
  }
  const holdingSeconds = state.enteredAt
    ? Math.round((Date.now() - new Date(state.enteredAt).getTime()) / 1000)
    : 0;

  // MFE 추적
  const currentProfitPct = ((bidPrice - entryPrice) / entryPrice) * 100;
  const prevBestProfitPct = state.bestProfitPct ?? 0;
  const bestProfitPct = Math.max(prevBestProfitPct, currentProfitPct);

  // MFE + MFE60/MFE120 업데이트
  const mfeUpdates: Record<string, unknown> = {};
  if (currentProfitPct > prevBestProfitPct) {
    mfeUpdates.bestProfitPct = currentProfitPct;
  }
  if (!state.mfe60Checked && holdingSeconds >= 60) {
    mfeUpdates.mfe60Pct = bestProfitPct;
    mfeUpdates.mfe60Checked = true;
  }
  if (!state.mfe120Checked && holdingSeconds >= 120) {
    mfeUpdates.mfe120Pct = bestProfitPct;
    mfeUpdates.mfe120Checked = true;
  }
  if (Object.keys(mfeUpdates).length > 0) {
    updateScalpStateMFE(strategyId, ticker, mfeUpdates as any, store as localStore.AccountStore);
  }

  // ── 30초 MFE 게이트 ──
  if (!state.mfe30GateChecked && holdingSeconds >= MFE30_GATE_SECONDS) {
    const tickSize = getKoreanTickSize(entryPrice);
    const maxBidSinceEntry = entryPrice * (1 + bestProfitPct / 100);
    const mfe30Ticks = Math.floor((maxBidSinceEntry - entryPrice) / tickSize);

    updateScalpStateMFE(strategyId, ticker, { mfe30GateChecked: true }, store as localStore.AccountStore);

    if (mfe30Ticks <= 0) {
      const exitPrice = bidPrice;

      if (isShadow) {
        writeShadowExitLog({
          ticker, stockName: stockName || ticker,
          strategyId, strategyVersion: state.strategyVersion || '0.0',
          entryPrice, entryQuantity, exitPrice,
          exitReason: 'no_follow_through_30s',
          allocatedAmount: state.allocatedAmount, enteredAt: state.enteredAt,
          entryBoxPos: state.entryBoxPos, boxRangePct: state.boxRangePct,
          spreadTicks: state.spreadTicks, targetTicks: state.targetTicks,
          bestBidAtExit: bidPrice, currentPriceAtExit: currentPrice,
          mfe30Ticks, mfe30Gate: 'fail',
          bestProfitPct,
          mfe60Pct: state.mfe60Pct, mfe120Pct: state.mfe120Pct,
          candidateRank: (state as any).candidateRank,
          signalMinuteBucket: (state as any).signalMinuteBucket,
          fillModel: (state as any).fillModel,
          entryMeta: state.entryMeta,
        }, ctx);

        deleteScalpStateV3(strategyId, ticker, store as localStore.AccountStore);
        clearPriceTrail(strategyId, ticker);
        return accessToken;
      } else {
        const sellResult = await kisClient.submitDomesticOrder(
          appKey, appSecret, accessToken, accountNo,
          { ticker, side: 'SELL', orderType: 'MARKET', price: 0, quantity: entryQuantity },
        );
        if (sellResult.output?.ODNO) {
          updateScalpStateToPendingSellV3(
            strategyId, ticker, sellResult.output.ODNO,
            'no_follow_through_30s', bidPrice, store as localStore.AccountStore,
          );
        }
        return accessToken;
      }
    }
  }

  // ── 타임아웃 체크 ──
  let isTimeout = false;
  if (holdingMinutes >= NO_PROGRESS_CHECK_MINUTES && bestProfitPct < NO_PROGRESS_MFE_THRESHOLD) {
    isTimeout = true;
  }
  if (!isTimeout && holdingMinutes >= HOLDING_TIMEOUT_MINUTES) {
    const breakEvenPrice = entryPrice * (1 + ROUND_TRIP_COST_PCT);
    const isNetProfitable = bidPrice > breakEvenPrice;
    if (!isNetProfitable) {
      isTimeout = true;
    } else if (holdingMinutes >= HOLDING_TIMEOUT_MINUTES + 1) {
      isTimeout = true;
    }
  }

  // ── 매도 판단 ──
  let exitReason: 'target' | 'stop_loss' | 'timeout' | 'market_close_auction' | 'no_follow_through_30s';

  if (isTimeout) {
    exitReason = 'timeout';
  } else {
    const exitResult = checkMomentumScalpExit({ currentPrice, targetPrice, stopLossPrice, bidPrice });
    if (!exitResult.shouldSell || !exitResult.exitReason) {
      // HOLD
      const stateKey = makeStateKey(strategyId, ticker);
      sellCheckSnapshots.set(stateKey, {
        ticker, stockName: stockName || ticker, strategyId,
        action: 'HOLD', entryPrice, currentPrice, bidPrice,
        targetPrice, stopLossPrice,
        profitPct: parseFloat(((bidPrice - entryPrice) / entryPrice * 100).toFixed(2)),
        targetGapPct: parseFloat(((targetPrice - bidPrice) / targetPrice * 100).toFixed(2)),
        stopGapPct: parseFloat(((bidPrice - stopLossPrice) / stopLossPrice * 100).toFixed(2)),
        holdingMin: holdingMinutes, timeoutMin: HOLDING_TIMEOUT_MINUTES,
        checkedAt: new Date().toISOString(),
      });
      return accessToken;
    }
    exitReason = exitResult.exitReason;
  }

  // ── 매도 실행 ──
  const todayStr = getKSTDateString();
  store.appendLog('scalpSellCheckLogs', todayStr, {
    ticker, stockName: stockName || ticker, strategyId,
    action: exitReason.toUpperCase(),
    entryPrice, currentPrice, bidPrice, targetPrice, stopLossPrice,
    profitPct: parseFloat(((bidPrice - entryPrice) / entryPrice * 100).toFixed(2)),
    holdingMin: holdingMinutes,
    checkedAt: new Date().toISOString(),
  });

  if (isShadow) {
    const tickSizeForLog = getKoreanTickSize(entryPrice);
    const maxBidForLog = entryPrice * (1 + bestProfitPct / 100);
    const mfe30TicksForLog = state.mfe30GateChecked
      ? Math.floor((maxBidForLog - entryPrice) / tickSizeForLog)
      : null;

    writeShadowExitLog({
      ticker, stockName: stockName || ticker,
      strategyId, strategyVersion: state.strategyVersion || '0.0',
      entryPrice, entryQuantity, exitPrice: bidPrice,
      exitReason,
      allocatedAmount: state.allocatedAmount, enteredAt: state.enteredAt,
      entryBoxPos: state.entryBoxPos, boxRangePct: state.boxRangePct,
      spreadTicks: state.spreadTicks, targetTicks: state.targetTicks,
      bestBidAtExit: bidPrice, currentPriceAtExit: currentPrice,
      mfe30Ticks: mfe30TicksForLog, mfe30Gate: state.mfe30GateChecked ? 'pass' : 'pending',
      positiveScore: state.positiveScore,
      positiveScoreDetails: state.positiveScoreDetails,
      bestProfitPct,
      mfe60Pct: state.mfe60Pct, mfe120Pct: state.mfe120Pct,
      candidateRank: (state as any).candidateRank,
      signalMinuteBucket: (state as any).signalMinuteBucket,
      fillModel: (state as any).fillModel,
      entryMeta: state.entryMeta,
    }, ctx);

    deleteScalpStateV3(strategyId, ticker, store as localStore.AccountStore);
    clearPriceTrail(strategyId, ticker);
    return accessToken;
  }

  // 실전 모드: MARKET 매도 (최대 3회 재시도)
  const accountId = ctx?.accountId ?? config.accountId;
  for (let attempt = 1; attempt <= SELL_API_MAX_RETRIES; attempt++) {
    try {
      const sellResult = await kisClient.submitDomesticOrder(
        appKey, appSecret, accessToken, accountNo,
        { ticker, side: 'SELL', orderType: 'MARKET', price: 0, quantity: entryQuantity },
      );
      if (sellResult.output?.ODNO) {
        updateScalpStateToPendingSellV3(
          strategyId, ticker, sellResult.output.ODNO,
          exitReason, bidPrice, store as localStore.AccountStore,
        );
        return accessToken;
      }
    } catch (err) {
      if (isTokenExpiredError(err)) {
        accessToken = await getOrRefreshToken('', accountId, { appKey, appSecret }, kisClient, true);
      }
      if (attempt < SELL_API_MAX_RETRIES) {
        await new Promise(resolve => setTimeout(resolve, 500));
      }
    }
  }

  return accessToken;
}

// ========================================
// pending_sell 체결 확인 (v3)
// ========================================

async function handlePendingSellV3(
  state: MomentumScalpStateV3,
  strategyId: StrategyId,
  _currentMinute: number,
  kisClient: KisApiClient,
  appKey: string, appSecret: string, accessToken: string, accountNo: string,
  todayStr: string, chatId: string | null,
  store: localStore.AccountStore | typeof localStore,
  ctx?: AccountContext,
): Promise<string> {
  const { ticker, stockName, sellOrderNo, sellExitReason, entryPrice, entryQuantity, allocatedAmount } = state;

  // 오버나이트 체크
  if (state.updatedAt) {
    const updatedDate = new Date(new Date(state.updatedAt).getTime() + 9 * 60 * 60 * 1000);
    const updatedDateStr = `${updatedDate.getUTCFullYear()}${String(updatedDate.getUTCMonth() + 1).padStart(2, '0')}${String(updatedDate.getUTCDate()).padStart(2, '0')}`;
    if (updatedDateStr !== todayStr) {
      revertScalpStateToActiveV3(strategyId, ticker, store as localStore.AccountStore);
      return accessToken;
    }
  }

  if (!sellOrderNo) {
    revertScalpStateToActiveV3(strategyId, ticker, store as localStore.AccountStore);
    return accessToken;
  }

  const sellHistory = await kisClient.getDomesticOrderHistory(
    appKey, appSecret, accessToken, accountNo, todayStr, todayStr, '01', '01', ticker,
  );
  await new Promise(resolve => setTimeout(resolve, 200));

  const filledSell = sellHistory.output1?.find(
    o => o.odno === sellOrderNo && parseInt(o.tot_ccld_qty || '0') > 0,
  );

  if (filledSell) {
    const exitPrice = parseInt(filledSell.avg_prvs || '0');
    const exitQuantity = parseInt(filledSell.tot_ccld_qty || '0');

    if (entryPrice && entryQuantity) {
      writeTradeLogV3({
        ticker, stockName: stockName || ticker,
        strategyId, strategyVersion: state.strategyVersion || '0.0',
        entryPrice, entryQuantity,
        exitPrice, exitQuantity,
        exitReason: sellExitReason || 'stop_loss',
        allocatedAmount, enteredAt: state.enteredAt,
        entryBoxPos: state.entryBoxPos, boxRangePct: state.boxRangePct,
        spreadTicks: state.spreadTicks, targetTicks: state.targetTicks,
        bestBidAtExit: state.bestBidAtExit,
        bestProfitPct: state.bestProfitPct,
        mfe60Pct: state.mfe60Pct, mfe120Pct: state.mfe120Pct,
        candidateRank: (state as any).candidateRank,
        signalMinuteBucket: (state as any).signalMinuteBucket,
        fillModel: (state as any).fillModel,
        entryMeta: state.entryMeta,
      }, ctx);
    }

    deleteScalpStateV3(strategyId, ticker, store as localStore.AccountStore);
    clearPriceTrail(strategyId, ticker);

    if (chatId && entryPrice && entryQuantity) {
      const profitRate = ((exitPrice - entryPrice) / entryPrice * 100).toFixed(2);
      const emoji = sellExitReason === 'target' ? '✅' : sellExitReason === 'timeout' ? '⏰' : '🔴';
      await sendTelegramMessage(chatId,
        `${emoji} <b>[스캘핑:${strategyId}] ${stockName} ${sellExitReason}</b>\n` +
        `${profitRate}% | ${entryPrice.toLocaleString()} → ${exitPrice.toLocaleString()}`,
        'HTML',
      );
    }
    return accessToken;
  }

  // 미체결 타임아웃
  const pendingTimeout = state.updatedAt
    ? new Date(state.updatedAt).getTime() + PENDING_SELL_TIMEOUT_MS
    : 0;

  if (Date.now() > pendingTimeout) {
    if (sellExitReason === 'market_close_auction') return accessToken;

    try {
      await kisClient.cancelDomesticOrder(appKey, appSecret, accessToken, accountNo,
        { orderNo: sellOrderNo, ticker });
    } catch { /* ignore */ }
    await new Promise(resolve => setTimeout(resolve, 300));

    revertScalpStateToActiveV3(strategyId, ticker, store as localStore.AccountStore);
  }

  return accessToken;
}

// ========================================
// 유틸리티
// ========================================

function formatKSTHour(): string {
  const now = new Date();
  const kst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  const h = kst.getUTCHours().toString().padStart(2, '0');
  const m = kst.getUTCMinutes().toString().padStart(2, '0');
  const s = kst.getUTCSeconds().toString().padStart(2, '0');
  return `${h}${m}${s}`;
}

async function fetchPaginatedMinuteBars(
  kisClient: KisApiClient,
  appKey: string, appSecret: string, accessToken: string,
  ticker: string, targetCount = 15, maxPages = 1,
): Promise<MinuteBar[]> {
  const allBars: MinuteBar[] = [];
  let nextHour = formatKSTHour();
  const todayDate = getKSTDateString();

  for (let page = 0; page < maxPages; page++) {
    const resp = await kisClient.getDomesticMinuteBars(
      appKey, appSecret, accessToken, ticker, nextHour,
    );
    await new Promise(resolve => setTimeout(resolve, 300));

    const rawBars = resp.output2 || [];
    if (rawBars.length === 0) break;

    const todayBars = rawBars.filter((b: any) => b.stck_bsop_date === todayDate);
    if (todayBars.length === 0) break;

    const parsed = todayBars
      .map((bar: any) => ({
        time: bar.stck_cntg_hour,
        date: bar.stck_bsop_date,
        open: parseInt(bar.stck_oprc),
        high: parseInt(bar.stck_hgpr),
        low: parseInt(bar.stck_lwpr),
        close: parseInt(bar.stck_prpr),
        volume: bar.cntg_vol ? parseInt(bar.cntg_vol) : undefined,
      }))
      .reverse();

    allBars.push(...parsed);
    if (allBars.length >= targetCount) break;
    if (todayBars.length < rawBars.length) break;

    const earliest = todayBars[todayBars.length - 1];
    if (!earliest?.stck_cntg_hour) break;
    nextHour = earliest.stck_cntg_hour;
  }

  const seen = new Set<string>();
  const unique = allBars.filter(bar => {
    const key = `${bar.date}_${bar.time}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  unique.sort((a, b) => `${a.date}_${a.time}`.localeCompare(`${b.date}_${b.time}`));

  return unique.slice(-targetCount);
}

async function sendAlert(title: string, detail: string, _ctx?: AccountContext): Promise<void> {
  try {
    const chatId = await getUserTelegramChatId(config.userId);
    if (chatId) {
      await sendTelegramMessage(chatId, `⚠️ <b>[스캘핑] ${title}</b>\n\n${detail}`, 'HTML');
    }
  } catch (err) {
    console.error('[ScalpV3] Alert failed:', err);
  }
}
