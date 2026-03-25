/**
 * 단타 v2 — 실행 엔진
 *
 * 2개 루프:
 * 1. candidatePoller: 15초 간격, 조건검색 → 즉시 매수
 * 2. positionMonitor: 300~500ms 간격, 보유 포지션 감시 → 청산 판단
 *
 * v1의 후보 등록/눌림/돌파 단계를 제거.
 * 조건검색 결과를 즉시 매수하는 단순한 구조.
 */

import { type AccountContext } from '../../lib/accountContext';
import { getOrRefreshToken } from '../../lib/kisApi';
import { getKSTDateString } from '../../lib/marketUtils';
import { getOccupiedTickersExcluding, invalidateCache } from '../../lib/activeTickerRegistry';
import {
  type DantaV2Config,
  type DantaV2State,
  DANTA_STATE_COLLECTION,
} from './dantaTypes';
import {
  evaluateExit,
  calculateQuantity,
  calculateEntryPrices,
} from './dantaStrategy';
import { executeBuy, executeSell } from './dantaExecution';
import { canOpenPosition, recordEntry, onPositionClosed, isOnCooldown } from './dantaRisk';
import { logConditionResult, logEntryDetail, logExitDetail, logError } from './dantaLogger';
import { type MarketDataProvider, getProvider, setProvider } from '../../lib/marketDataProvider';
import { inc, record, M } from './dantaMetrics';

const TAG = '[DantaV2:Engine]';

// MarketDataProvider: 공유 레지스트리로 위임
export function setMarketDataProvider(accountId: string, provider: MarketDataProvider): void {
  setProvider(accountId, provider);
}

export function getMarketDataProvider(accountId: string): MarketDataProvider | undefined {
  return getProvider(accountId);
}

// 토큰 캐시 (REST 호출용 — 조건검색 등 WebSocket 미지원 API)
const tokenCache = new Map<string, { token: string; expiresAt: number }>();

async function getToken(ctx: AccountContext): Promise<string> {
  const key = ctx.accountId;
  const cached = tokenCache.get(key);
  if (cached && Date.now() < cached.expiresAt) return cached.token;

  const { appKey, appSecret } = ctx.credentials;
  const token = await getOrRefreshToken('', ctx.accountId, { appKey, appSecret }, ctx.kisClient);
  tokenCache.set(key, { token, expiresAt: Date.now() + 60_000 });
  return token;
}

function getKSTMinute(): number {
  const kst = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Seoul' }));
  return kst.getHours() * 60 + kst.getMinutes();
}

// ========================================
// Safe mode 로그 rate limiter
// ========================================

interface SafeModeLogState {
  wasInSafeMode: boolean;
  lastPeriodicLogAt: number;
}

const safeModeLogStates = new Map<string, SafeModeLogState>();

function getSafeModeLogState(accountId: string): SafeModeLogState {
  if (!safeModeLogStates.has(accountId)) {
    safeModeLogStates.set(accountId, { wasInSafeMode: false, lastPeriodicLogAt: 0 });
  }
  return safeModeLogStates.get(accountId)!;
}

function logSafeModeThrottled(
  accountId: string,
  inSafeMode: boolean,
  fallbackDurationSec: number,
  context: string,
): void {
  const state = getSafeModeLogState(accountId);
  const now = Date.now();

  if (inSafeMode && !state.wasInSafeMode) {
    console.log(`${TAG} [SafeMode] ENTERED — ${context}, fallback ${fallbackDurationSec}s`);
    state.wasInSafeMode = true;
    state.lastPeriodicLogAt = now;
    inc(accountId, M.SYS_SAFEMODE_EVENT);
  } else if (!inSafeMode && state.wasInSafeMode) {
    console.log(`${TAG} [SafeMode] EXITED — ${context}`);
    state.wasInSafeMode = false;
    state.lastPeriodicLogAt = 0;
  } else if (inSafeMode && now - state.lastPeriodicLogAt >= 30_000) {
    console.log(`${TAG} [SafeMode] ongoing — ${context}, fallback ${fallbackDurationSec}s`);
    state.lastPeriodicLogAt = now;
  }
}

// warm-up 로그 throttle
let lastWarmupLogAt = 0;

// ========================================
// 1. Candidate Poller (15초 간격) — 즉시 매수
// ========================================

export async function candidatePollerTick(ctx: AccountContext, config: DantaV2Config): Promise<void> {
  const provider = getProvider(ctx.accountId);
  const kstMinute = getKSTMinute();
  const todayStr = getKSTDateString();
  const aid = ctx.accountId;

  const inEntryWindow = kstMinute >= config.entryStartMinute && kstMinute <= config.entryEndMinute;
  if (!inEntryWindow) return;

  // 빈 슬롯 없으면 조건검색 자체를 skip
  const positions = ctx.store.getAllStates<DantaV2State>(DANTA_STATE_COLLECTION);
  const activeCount = Array.from(positions.values()).filter(
    s => s.status === 'active' || s.status === 'pending_buy',
  ).length;
  if (activeCount >= config.maxSlots) return;

  // Safe mode 체크
  const isFallback = provider?.isFallbackActive() ?? false;
  const fallbackDuration = provider?.getFallbackDurationMs() ?? 0;
  const inSafeMode = isFallback && fallbackDuration >= config.safeModeAfterFallbackMs;

  logSafeModeThrottled(aid, inSafeMode, Math.round(fallbackDuration / 1000), 'poller');
  if (inSafeMode) return;

  // Warm-up 체크
  if (provider?.isWarmingUp()) {
    const now = Date.now();
    if (now - lastWarmupLogAt >= 5_000) {
      console.log(`${TAG} [WarmUp] Entry paused — waiting for stable WS ticks`);
      lastWarmupLogAt = now;
    }
    return;
  }

  try {
    const { appKey, appSecret } = ctx.credentials;
    const accessToken = await getToken(ctx);

    // 조건검색 호출 (REST)
    const result = await ctx.kisClient.getConditionSearchResult(
      appKey, appSecret, accessToken,
      config.htsUserId,
      config.conditionSeq,
    );

    const candidates = result.output2 || [];
    inc(aid, M.CAND_RECEIVED, candidates.length);

    // 타 전략 점유 종목
    const occupied = getOccupiedTickersExcluding('domestic', 'dantaV2');

    // 현재 보유 종목
    const positions = ctx.store.getAllStates<DantaV2State>(DANTA_STATE_COLLECTION);
    const activeCount = Array.from(positions.values()).filter(
      s => s.status === 'active' || s.status === 'pending_buy',
    ).length;

    let newCount = 0;
    let buyCount = 0;

    for (const c of candidates) {
      // 슬롯 체크
      if (activeCount + buyCount >= config.maxSlots) break;

      const ticker = c.code;

      if (occupied.has(ticker)) { inc(aid, M.CAND_FILTER_OCCUPIED); continue; }
      if (positions.has(ticker)) { inc(aid, M.CAND_FILTER_POSITION); continue; }
      if (config.cooldownAfterStopLossSec > 0 && isOnCooldown(ticker)) { inc(aid, M.CAND_FILTER_COOLDOWN); continue; }
      if (/[5-9]$/.test(ticker)) { inc(aid, M.CAND_FILTER_PREFERRED); continue; }

      newCount++;
      inc(aid, M.CAND_NEW);

      // 리스크 체크
      const riskCheck = canOpenPosition(ticker, todayStr, config, ctx);
      if (!riskCheck.allowed) {
        console.log(`${TAG} Entry blocked: ${ticker} — ${riskCheck.reason}`);
        if (riskCheck.reason.includes('슬롯')) inc(aid, M.ENTRY_BLOCK_SLOT);
        else if (riskCheck.reason.includes('보유')) inc(aid, M.ENTRY_BLOCK_DUPLICATE);
        else if (riskCheck.reason.includes('쿨다운')) inc(aid, M.ENTRY_BLOCK_COOLDOWN);
        else if (riskCheck.reason.includes('연속')) inc(aid, M.ENTRY_BLOCK_REENTRY);
        else if (riskCheck.reason.includes('점유')) inc(aid, M.ENTRY_BLOCK_CROSS);
        continue;
      }

      // 시세 조회: MarketDataProvider 캐시 사용
      const tick = provider?.getLatestTick(ticker);

      // 시세 없으면 조건검색 결과의 가격으로 대체 시도
      let askPrice: number;
      if (tick && (Date.now() - tick.timestamp < 3_000)) {
        askPrice = tick.askPrice;
      } else {
        // WS 시세가 없으면 구독 등록 후 이번 폴에서는 skip
        provider?.subscribe(ticker);
        inc(aid, M.ENTRY_SKIP_STALE);
        continue;
      }

      if (!askPrice) continue;

      // 매수가/익절가/손절가 계산
      const { entryPrice, targetPrice, stopLossPrice } = calculateEntryPrices(askPrice, config);

      const quantity = calculateQuantity(entryPrice, config.amountPerStock);
      if (quantity <= 0) {
        console.log(`${TAG} Entry blocked: ${ticker} — 수량 0`);
        inc(aid, M.ENTRY_BLOCK_QTY);
        continue;
      }

      inc(aid, M.ENTRY_ATTEMPT);

      const buyResult = await executeBuy(ctx, {
        ticker,
        stockName: c.name,
        price: entryPrice,
        quantity,
        targetPrice,
        stopLossPrice,
        allocatedAmount: config.amountPerStock,
      }, config);

      if (buyResult.success) {
        buyCount++;
        inc(aid, M.ENTRY_SUCCESS);
        record(aid, M.DIST_ENTRY_PRICE, entryPrice);

        logEntryDetail({
          ticker,
          stockName: c.name,
          currentPrice: tick.currentPrice,
          askPrice,
          bidPrice: tick.bidPrice,
          entryPrice,
          quantity,
          targetPrice,
          stopLossPrice,
          shadowMode: config.shadowMode,
        }, ctx);

        recordEntry(ticker, todayStr);
        invalidateCache();
        // 구독 유지 (포지션 감시에 필요)
        provider?.subscribe(ticker);
        console.log(`${TAG} Entered ${ticker}: immediate buy @ ${entryPrice}`);
      } else {
        inc(aid, M.ENTRY_BLOCK_ORDER);
      }
    }

    logConditionResult({
      conditionSeq: config.conditionSeq,
      conditionName: config.conditionName,
      totalCandidates: candidates.length,
      newCandidates: newCount,
      bought: buyCount,
      candidates: candidates.slice(0, 30).map(c => ({
        code: c.code,
        name: c.name,
        price: c.price,
        tradeAmt: c.trade_amt,
      })),
    }, ctx);

  } catch (err) {
    logError('candidatePoller', err, ctx);
    inc(aid, M.SYS_ERROR);
  }
}

// ========================================
// 2. Position Monitor (300~500ms 간격)
// ========================================

export async function positionMonitorTick(ctx: AccountContext, config: DantaV2Config): Promise<void> {
  const positions = ctx.store.getAllStates<DantaV2State>(DANTA_STATE_COLLECTION);
  if (positions.size === 0) return;

  const provider = getProvider(ctx.accountId);
  const kstMinute = getKSTMinute();
  const todayStr = getKSTDateString();
  const now = Date.now();
  const aid = ctx.accountId;

  // Safe mode 경고 (포지션 감시는 계속하되 로그 rate limited)
  const isFallback = provider?.isFallbackActive() ?? false;
  const fallbackDuration = provider?.getFallbackDurationMs() ?? 0;
  const inSafeMode = isFallback && fallbackDuration >= (60_000);
  if (inSafeMode) {
    logSafeModeThrottled(
      aid, true,
      Math.round(fallbackDuration / 1000), 'position (exits active)',
    );
  }

  for (const [ticker, position] of positions) {
    if (position.status !== 'active') continue;

    try {
      // ---- 시세 조회: MarketDataProvider 캐시 사용 ----
      const tick = provider?.getLatestTick(ticker);

      let currentPrice: number;
      let bidPrice: number;

      if (tick && (now - tick.timestamp < 3_000)) {
        currentPrice = tick.currentPrice;
        bidPrice = tick.bidPrice;
      } else {
        // fallback: REST 직접 호출 (포지션 감시는 REST 허용)
        try {
          const { appKey, appSecret } = ctx.credentials;
          const accessToken = await getToken(ctx);
          const askingData = await ctx.kisClient.getDomesticAskingPrice(
            appKey, appSecret, accessToken, ticker,
          );

          currentPrice = parseInt(askingData.output2?.stck_prpr || '0', 10);
          bidPrice = parseInt(askingData.output1?.bidp1 || '0', 10);
        } catch (err) {
          logError(`positionMonitor:${ticker}:rest`, err, ctx);
          inc(aid, M.SYS_ERROR);
          continue;
        }
      }

      if (!currentPrice) continue;

      // MFE / MAE 추적
      const profitPct = (currentPrice - position.entryPrice) / position.entryPrice * 100;
      if (position.bestProfitPct === null || profitPct > position.bestProfitPct) {
        position.bestProfitPct = profitPct;
      }
      if (position.worstProfitPct === null || profitPct < position.worstProfitPct) {
        position.worstProfitPct = profitPct;
      }

      // 목표 절반 도달 체크
      if (!position.hasReachedHalfTarget) {
        const halfTargetPrice = Math.round(position.entryPrice * (1 + config.targetPct / 100 / 2));
        if (currentPrice >= halfTargetPrice) {
          position.hasReachedHalfTarget = true;
        }
      }

      // 목표가 도달 체크
      if (!position.hasReachedTarget) {
        if (currentPrice >= position.targetPrice) {
          position.hasReachedTarget = true;
        }
      }

      // 청산 조건 평가
      const exitSignal = evaluateExit(position, currentPrice, bidPrice, now, config, kstMinute);

      if (exitSignal.shouldExit) {
        const result = await executeSell(ctx, position, exitSignal.exitPrice, exitSignal.exitReason, config);

        if (result.success) {
          inc(aid, `exit.${exitSignal.exitReason}`);
          const holdTimeMs = position.filledAt
            ? now - new Date(position.filledAt).getTime()
            : 0;
          record(aid, M.DIST_HOLD_TIME, holdTimeMs);
          record(aid, M.DIST_MFE, position.bestProfitPct ?? 0);
          record(aid, M.DIST_MAE, position.worstProfitPct ?? 0);

          logExitDetail({
            ticker,
            exitReason: exitSignal.exitReason,
            entryPrice: position.entryPrice,
            exitPrice: exitSignal.exitPrice,
            currentPrice,
            bidPrice,
            targetPrice: position.targetPrice,
            stopLossPrice: position.stopLossPrice,
            holdTimeMs,
            mfePct: position.bestProfitPct ?? 0,
            maePct: position.worstProfitPct ?? 0,
            hasReachedHalfTarget: position.hasReachedHalfTarget,
            hasReachedTarget: position.hasReachedTarget,
            kstMinute,
            shadowMode: config.shadowMode,
          }, ctx);

          onPositionClosed(ticker, exitSignal.exitReason, todayStr, config);
          invalidateCache();
          provider?.unsubscribe(ticker);
          console.log(`${TAG} Exited ${ticker}: ${exitSignal.reason}`);
        }
      } else {
        // 상태 갱신
        ctx.store.setState(DANTA_STATE_COLLECTION, ticker, {
          ...position,
          updatedAt: new Date().toISOString(),
        });
      }

    } catch (err) {
      logError(`positionMonitor:${ticker}`, err, ctx);
      inc(aid, M.SYS_ERROR);
    }
  }
}

// ========================================
// 장마감 시 잔존 포지션 강제 청산 (safety net)
// ========================================

export async function forceCloseOrphanPositions(ctx: AccountContext, config: DantaV2Config): Promise<void> {
  const positions = ctx.store.getAllStates<DantaV2State>(DANTA_STATE_COLLECTION);
  const aid = ctx.accountId;

  for (const [ticker, position] of positions) {
    if (position.status === 'pending_buy') {
      console.warn(`${TAG} [OrphanClose] ${ticker} pending_buy at market close — removing state`);
      ctx.store.deleteState(DANTA_STATE_COLLECTION, ticker);
      continue;
    }

    if (position.status === 'pending_sell') {
      console.warn(`${TAG} [OrphanClose] ${ticker} pending_sell at market close — awaiting fill`);
      continue;
    }

    if (position.status !== 'active') continue;

    console.warn(`${TAG} [OrphanClose] ${ticker} still active at market close — force closing`);

    const exitPrice = position.entryPrice; // 최선 추정 (시세 없음)
    const result = await executeSell(ctx, position, exitPrice, 'market_close', config);

    if (result.success) {
      inc(aid, M.EXIT_MARKET_CLOSE);
      const holdTimeMs = position.filledAt
        ? Date.now() - new Date(position.filledAt).getTime()
        : 0;
      record(aid, M.DIST_HOLD_TIME, holdTimeMs);
      record(aid, M.DIST_MFE, position.bestProfitPct ?? 0);
      record(aid, M.DIST_MAE, position.worstProfitPct ?? 0);
    }
  }
}
