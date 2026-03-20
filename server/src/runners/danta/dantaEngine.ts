/**
 * 단타 v1 — 실행 엔진
 *
 * 3개 루프의 실제 로직 구현:
 * 1. candidatePoller: 15초 간격, 조건검색 → 후보 등록
 * 2. entryMonitor: 1초 간격, 후보 감시 → 매수 판단
 * 3. positionMonitor: 300~500ms 간격, 보유 포지션 감시 → 청산 판단
 *
 * 시세 데이터는 MarketDataProvider를 통해 수신.
 * - WebSocket 모드: 체결 즉시 콜백으로 수신 (entryMonitor/positionMonitor는 캐시 참조)
 * - REST 모드: provider 내부 polling으로 캐시 갱신
 *
 * 상태 머신:
 *   NEW_CANDIDATE → WAIT_PULLBACK → READY_TO_BREAKOUT → ENTERED → EXITED
 */

import { type AccountContext } from '../../lib/accountContext';
import { getOrRefreshToken } from '../../lib/kisApi';
import { getKSTDateString } from '../../lib/marketUtils';
import { getOccupiedTickersExcluding, invalidateCache } from '../../lib/activeTickerRegistry';
import {
  type DantaCandidate,
  type DantaV1Config,
  type DantaV1State,
  DANTA_STATE_COLLECTION,
} from './dantaTypes';
import {
  calculateTriggerHigh,
  evaluateCandidatePhase,
  evaluateEntry,
  evaluateExit,
  calculateQuantity,
} from './dantaStrategy';
import { executeBuy, executeSell } from './dantaExecution';
import { canOpenPosition, recordEntry, onPositionClosed, isOnCooldown } from './dantaRisk';
import { logConditionResult, logCandidatePhaseChange, logEntryDetail, logExitDetail, logError } from './dantaLogger';
import { priceUpTicks } from './tickSize';
import { type MarketDataProvider, getProvider, setProvider } from '../../lib/marketDataProvider';
import { inc, record, M } from './dantaMetrics';

const TAG = '[DantaV1:Engine]';

// 후보 풀 상한 (fallback 중 무한 증가 방지)
const MAX_POOL_SIZE = 30;

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

// warm-up 로그 throttle (5초간 매초 로그 방지)
let lastWarmupLogAt = 0;

// ========================================
// 후보 풀 (in-memory, 계좌별)
// ========================================

const candidatePools = new Map<string, Map<string, DantaCandidate>>();

export function getCandidatePool(accountId: string): Map<string, DantaCandidate> {
  if (!candidatePools.has(accountId)) {
    candidatePools.set(accountId, new Map());
  }
  return candidatePools.get(accountId)!;
}

// MarketDataProvider: 공유 레지스트리로 위임
export function setMarketDataProvider(accountId: string, provider: MarketDataProvider): void {
  setProvider(accountId, provider);
}

export function getMarketDataProvider(accountId: string): MarketDataProvider | undefined {
  return getProvider(accountId);
}

// 토큰 캐시 (REST 호출용 — 조건검색, 분봉 등 WebSocket 미지원 API)
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

function getKSTTime(): Date {
  return new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Seoul' }));
}

// ========================================
// 1. Candidate Poller (15초 간격)
// ========================================
// 조건검색은 REST API만 지원 → WebSocket 전환 대상 아님

export async function candidatePollerTick(ctx: AccountContext, config: DantaV1Config): Promise<void> {
  const pool = getCandidatePool(ctx.accountId);
  const provider = getProvider(ctx.accountId);
  const kstMinute = getKSTMinute();
  const aid = ctx.accountId;

  const inEntryWindow = kstMinute >= config.entryStartMinute && kstMinute <= config.entryEndMinute;

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
    const occupied = getOccupiedTickersExcluding('domestic', 'dantaV1');

    // 현재 보유 종목
    const positions = ctx.store.getAllStates<DantaV1State>(DANTA_STATE_COLLECTION);

    let newCount = 0;

    for (const c of candidates) {
      const ticker = c.code;

      if (occupied.has(ticker)) { inc(aid, M.CAND_FILTER_OCCUPIED); continue; }
      if (positions.has(ticker)) { inc(aid, M.CAND_FILTER_POSITION); continue; }
      if (pool.has(ticker)) { inc(aid, M.CAND_FILTER_DUPLICATE); continue; }
      if (isOnCooldown(ticker)) { inc(aid, M.CAND_FILTER_COOLDOWN); continue; }
      if (!inEntryWindow) { inc(aid, M.CAND_FILTER_WINDOW); continue; }
      if (/[5-9]$/.test(ticker)) { inc(aid, M.CAND_FILTER_PREFERRED); continue; }

      // 풀 상한: phase 우선순위 + 거래대금으로 evict 대상 선정
      // READY_TO_BREAKOUT 보호, NEW_CANDIDATE(triggerHigh 미계산) 우선 제거
      if (pool.size >= MAX_POOL_SIZE) {
        const newTradeAmt = parseFloat(c.trade_amt) || 0;
        let evictTicker: string | null = null;
        let evictScore = Infinity; // 낮을수록 evict 우선

        for (const [t, existing] of pool) {
          // phase별 가중치: NEW(no trigger)=0, NEW(trigger)=1, WAIT=2, READY=3
          let phaseWeight: number;
          if (existing.phase === 'NEW_CANDIDATE' && !existing.triggerHigh) phaseWeight = 0;
          else if (existing.phase === 'NEW_CANDIDATE') phaseWeight = 1;
          else if (existing.phase === 'WAIT_PULLBACK') phaseWeight = 2;
          else phaseWeight = 3; // READY_TO_BREAKOUT — 보호

          // 점수: phase 가중 * 10억 + 거래대금 (phase가 낮으면 무조건 우선 제거)
          const score = phaseWeight * 1_000_000_000 + existing.tradeAmt;
          if (score < evictScore) {
            evictScore = score;
            evictTicker = t;
          }
        }

        // READY_TO_BREAKOUT만 남아있으면 새 후보 포기
        if (!evictTicker || evictScore >= 3_000_000_000) continue;

        // 새 후보(NEW_CANDIDATE)가 evict 대상보다 낮은 가치면 skip
        // 새 후보 phase=0(NEW, no trigger), 거래대금으로만 비교
        const newScore = newTradeAmt; // phase 0 → score = 0 + tradeAmt
        if (evictScore > 2_000_000_000 && newScore <= (evictScore - 2_000_000_000)) continue;

        pool.delete(evictTicker);
        provider?.unsubscribe(evictTicker);
      }

      pool.set(ticker, {
        ticker,
        stockName: c.name,
        phase: 'NEW_CANDIDATE',
        discoveredAt: Date.now(),
        tradeAmt: parseFloat(c.trade_amt) || 0,
        bidQty1: 0,
        triggerHigh: null,
        triggerHighSetAt: null,
        pullbackLow: null,
        pullbackDetectedAt: null,
        lastPrice: parseFloat(c.price) || 0,
        lastAskPrice: 0,
        lastBidPrice: 0,
        lastUpdatedAt: Date.now(),
      });
      newCount++;
      inc(aid, M.CAND_NEW);

      // 새 후보를 MarketDataProvider에 구독 등록
      if (provider) {
        provider.subscribe(ticker);
      }
    }

    // 만료된 후보 제거
    const now = Date.now();
    for (const [ticker, cand] of pool) {
      // NEW_CANDIDATE TTL: triggerHigh 미계산 상태로 오래 머문 후보 폐기
      if (cand.phase === 'NEW_CANDIDATE' && !cand.triggerHigh
          && now - cand.discoveredAt > config.newCandidateTtlMs) {
        logCandidatePhaseChange(cand, 'NEW_CANDIDATE', 'EXPIRED',
          `triggerHigh 미계산 ${Math.round((now - cand.discoveredAt) / 1000)}초 초과`, ctx);
        record(aid, M.DIST_CAND_SURVIVAL, now - cand.discoveredAt);
        inc(aid, M.CAND_EXPIRED_TTL);
        pool.delete(ticker);
        provider?.unsubscribe(ticker);
        continue;
      }
      if (now - cand.discoveredAt > 180_000) {
        logCandidatePhaseChange(cand, cand.phase, 'EXPIRED', '3분 초과 만료', ctx);
        record(aid, M.DIST_CAND_SURVIVAL, now - cand.discoveredAt);
        inc(aid, M.CAND_EXPIRED_3MIN);
        pool.delete(ticker);
        provider?.unsubscribe(ticker);
        continue;
      }
      if (cand.phase === 'INVALIDATED') {
        record(aid, M.DIST_CAND_SURVIVAL, now - cand.discoveredAt);
        inc(aid, M.CAND_INVALIDATED);
        pool.delete(ticker);
        provider?.unsubscribe(ticker);
      }
    }

    logConditionResult({
      conditionSeq: config.conditionSeq,
      conditionName: config.conditionName,
      totalCandidates: candidates.length,
      newCandidates: newCount,
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
// 2. Entry Monitor (1초 간격)
// ========================================
// 시세 데이터를 MarketDataProvider 캐시에서 읽음 (REST 호출 제거)
// 분봉 조회만 REST로 유지 (triggerHigh 계산 시 1회)

export async function entryMonitorTick(ctx: AccountContext, config: DantaV1Config): Promise<void> {
  const pool = getCandidatePool(ctx.accountId);
  if (pool.size === 0) return;

  const provider = getProvider(ctx.accountId);
  const kstMinute = getKSTMinute();
  const todayStr = getKSTDateString();
  const aid = ctx.accountId;

  if (kstMinute < config.entryStartMinute || kstMinute > config.entryEndMinute) return;

  // Safe mode: fallback이 일정 시간 이상 지속되면 신규 진입 중단
  const isFallback = provider?.isFallbackActive() ?? false;
  const fallbackDuration = provider?.getFallbackDurationMs() ?? 0;
  const inSafeMode = isFallback && fallbackDuration >= config.safeModeAfterFallbackMs;

  // safe mode 로그 (rate limited: 진입/해제 1회, 유지 30초 간격)
  logSafeModeThrottled(
    aid, inSafeMode,
    Math.round(fallbackDuration / 1000), 'entry',
  );

  if (inSafeMode) return;

  // Warm-up: fallback 종료 직후 5초간 tick 수신 확인 → 신규 진입 보류
  if (provider?.isWarmingUp()) {
    const now = Date.now();
    if (now - lastWarmupLogAt >= 5_000) {
      console.log(`${TAG} [WarmUp] Entry paused — waiting for stable WS ticks`);
      lastWarmupLogAt = now;
    }
    return;
  }

  const positions = ctx.store.getAllStates<DantaV1State>(DANTA_STATE_COLLECTION);
  const activeCount = Array.from(positions.values()).filter(
    s => s.status === 'active' || s.status === 'pending_buy',
  ).length;
  if (activeCount >= config.maxSlots) return;

  try {
    // 후보를 거래대금 순 정렬
    const sorted = Array.from(pool.values())
      .filter(c => c.phase !== 'INVALIDATED')
      .sort((a, b) => {
        if (b.tradeAmt !== a.tradeAmt) return b.tradeAmt - a.tradeAmt;
        return b.bidQty1 - a.bidQty1;
      })
      .slice(0, 10);

    for (const candidate of sorted) {
      // 포지션 재확인
      const currentPositions = ctx.store.getAllStates<DantaV1State>(DANTA_STATE_COLLECTION);
      const currentActive = Array.from(currentPositions.values()).filter(
        s => s.status === 'active' || s.status === 'pending_buy',
      ).length;
      if (currentActive >= config.maxSlots) break;

      try {
        // ---- 시세 조회: MarketDataProvider 캐시 사용 ----
        const tick = provider?.getLatestTick(candidate.ticker);

        if (!tick || (Date.now() - tick.timestamp >= 3_000)) {
          inc(aid, M.ENTRY_SKIP_STALE);
          continue;
        }

        const currentPrice = tick.currentPrice;
        const askPrice = tick.askPrice;
        const bidPrice = tick.bidPrice;
        const bidQty1 = tick.bidQty1;

        if (!currentPrice || !askPrice) continue;

        // 시세 갱신
        candidate.lastPrice = currentPrice;
        candidate.lastAskPrice = askPrice;
        candidate.lastBidPrice = bidPrice;
        candidate.bidQty1 = bidQty1;
        candidate.lastUpdatedAt = Date.now();

        // Phase: NEW_CANDIDATE → triggerHigh 계산 (분봉은 REST만 지원, 1회 고정)
        if (candidate.phase === 'NEW_CANDIDATE' && !candidate.triggerHigh) {
          if (isFallback) {
            inc(aid, M.ENTRY_SKIP_FALLBACK);
            continue;
          }
          try {
            const { appKey, appSecret } = ctx.credentials;
            const accessToken = await getToken(ctx);
            const kstTime = getKSTTime();
            const hourStr = `${String(kstTime.getHours()).padStart(2, '0')}${String(kstTime.getMinutes()).padStart(2, '0')}00`;

            const minuteBarResult = await ctx.kisClient.getDomesticMinuteBars(
              appKey, appSecret, accessToken,
              candidate.ticker, hourStr,
            );

            const bars = minuteBarResult.output2 || [];
            const completedBars = bars.slice(1);
            const highs = completedBars.slice(0, 3).map(b => parseInt(b.stck_hgpr, 10));

            const triggerHigh = calculateTriggerHigh(highs);
            if (triggerHigh) {
              const oldPhase = candidate.phase;
              candidate.triggerHigh = triggerHigh;
              candidate.triggerHighSetAt = Date.now();
              candidate.phase = 'WAIT_PULLBACK';
              logCandidatePhaseChange(candidate, oldPhase, 'WAIT_PULLBACK',
                `triggerHigh=${triggerHigh} (봉 고가: ${highs.join(',')})`, ctx);
              inc(aid, M.CAND_TRIGGER_OK);
              inc(aid, M.PHASE_NEW_TO_WAIT);
            } else {
              inc(aid, M.CAND_TRIGGER_FAIL);
            }
          } catch (err) {
            inc(aid, M.SYS_MINBAR_FAIL);
            logError(`entryMonitor:${candidate.ticker}:minbar`, err, ctx);
          }
          continue;
        }

        // Phase 전이 평가
        const transition = evaluateCandidatePhase(candidate, currentPrice, config);
        if (transition.newPhase !== candidate.phase) {
          const oldPhase = candidate.phase;
          candidate.phase = transition.newPhase;
          Object.assign(candidate, transition.updatedCandidate);
          logCandidatePhaseChange(candidate, oldPhase, transition.newPhase, transition.reason, ctx);

          // 전이 메트릭
          if (oldPhase === 'WAIT_PULLBACK' && transition.newPhase === 'READY_TO_BREAKOUT') {
            inc(aid, M.PHASE_WAIT_TO_READY);
          } else if (oldPhase === 'WAIT_PULLBACK' && transition.newPhase === 'INVALIDATED') {
            inc(aid, M.PHASE_WAIT_TO_INVALID);
          } else if (oldPhase === 'READY_TO_BREAKOUT' && transition.newPhase === 'INVALIDATED') {
            inc(aid, M.PHASE_READY_TO_INVALID);
          }

          if (transition.newPhase === 'INVALIDATED') {
            pool.delete(candidate.ticker);
            provider?.unsubscribe(candidate.ticker);
            continue;
          }
        } else {
          Object.assign(candidate, transition.updatedCandidate);
        }

        // READY_TO_BREAKOUT → 매수 판단
        if (candidate.phase === 'READY_TO_BREAKOUT') {
          const entrySignal = evaluateEntry(candidate, currentPrice, askPrice, config);

          if (entrySignal.shouldEnter) {
            inc(aid, M.ENTRY_ATTEMPT);

            const riskCheck = canOpenPosition(candidate.ticker, todayStr, config, ctx);
            if (!riskCheck.allowed) {
              console.log(`${TAG} Entry blocked: ${candidate.ticker} — ${riskCheck.reason}`);
              // 리스크 차단 사유별 메트릭
              if (riskCheck.reason.includes('슬롯')) inc(aid, M.ENTRY_BLOCK_SLOT);
              else if (riskCheck.reason.includes('보유')) inc(aid, M.ENTRY_BLOCK_DUPLICATE);
              else if (riskCheck.reason.includes('쿨다운')) inc(aid, M.ENTRY_BLOCK_COOLDOWN);
              else if (riskCheck.reason.includes('연속')) inc(aid, M.ENTRY_BLOCK_REENTRY);
              else if (riskCheck.reason.includes('점유')) inc(aid, M.ENTRY_BLOCK_CROSS);
              continue;
            }

            const quantity = calculateQuantity(entrySignal.entryPrice, config.amountPerStock);
            if (quantity <= 0) {
              console.log(`${TAG} Entry blocked: ${candidate.ticker} — 수량 0`);
              inc(aid, M.ENTRY_BLOCK_QTY);
              continue;
            }

            const buyResult = await executeBuy(ctx, {
              ticker: candidate.ticker,
              stockName: candidate.stockName,
              price: entrySignal.entryPrice,
              quantity,
              targetPrice: entrySignal.targetPrice,
              stopLossPrice: entrySignal.stopLossPrice,
              pullbackLow: entrySignal.pullbackLow,
              triggerHigh: candidate.triggerHigh!,
              allocatedAmount: config.amountPerStock,
            }, config);

            if (buyResult.success) {
              inc(aid, M.ENTRY_SUCCESS);
              record(aid, M.DIST_ENTRY_PRICE, entrySignal.entryPrice);
              record(aid, M.DIST_ENTRY_LATENCY, Date.now() - candidate.discoveredAt);
              record(aid, M.DIST_CAND_SURVIVAL, Date.now() - candidate.discoveredAt);

              // 진입 상세 로그 (shadow 검증용)
              logEntryDetail({
                ticker: candidate.ticker,
                stockName: candidate.stockName,
                triggerHigh: candidate.triggerHigh!,
                breakoutLevel: priceUpTicks(candidate.triggerHigh!, config.breakoutConfirmTicks),
                pullbackLow: entrySignal.pullbackLow,
                currentPrice,
                askPrice,
                bidPrice,
                bidQty1,
                entryPrice: entrySignal.entryPrice,
                quantity,
                targetPrice: entrySignal.targetPrice,
                stopLossPrice: entrySignal.stopLossPrice,
                candidateAgeMs: Date.now() - candidate.discoveredAt,
                shadowMode: config.shadowMode,
              }, ctx);

              recordEntry(candidate.ticker, todayStr);
              invalidateCache();
              logCandidatePhaseChange(candidate, 'READY_TO_BREAKOUT', 'ENTERED', entrySignal.reason, ctx);
              pool.delete(candidate.ticker);
              // 구독은 유지 (포지션 감시에 필요)
            } else {
              inc(aid, M.ENTRY_BLOCK_ORDER);
            }

            break; // maxSlots=1
          }
        }

      } catch (err) {
        logError(`entryMonitor:${candidate.ticker}`, err, ctx);
        inc(aid, M.SYS_ERROR);
      }
    }
  } catch (err) {
    logError('entryMonitor', err, ctx);
    inc(aid, M.SYS_ERROR);
  }
}

// ========================================
// 3. Position Monitor (300~500ms 간격)
// ========================================
// 시세 데이터를 MarketDataProvider 캐시에서 읽음 (REST 호출 제거)

export async function positionMonitorTick(ctx: AccountContext, config: DantaV1Config): Promise<void> {
  const positions = ctx.store.getAllStates<DantaV1State>(DANTA_STATE_COLLECTION);
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

      // +1틱 도달 체크
      if (!position.hasReachedPlusOneTick) {
        const plusOne = priceUpTicks(position.entryPrice, 1);
        if (currentPrice >= plusOne) {
          position.hasReachedPlusOneTick = true;
        }
      }

      // +2틱 도달 체크
      if (!position.hasReachedPlusTwoTicks) {
        const plusTwo = priceUpTicks(position.entryPrice, 2);
        if (currentPrice >= plusTwo) {
          position.hasReachedPlusTwoTicks = true;
        }
      }

      // 청산 조건 평가
      const exitSignal = evaluateExit(position, currentPrice, bidPrice, now, config, kstMinute);

      if (exitSignal.shouldExit) {
        const result = await executeSell(ctx, position, exitSignal.exitPrice, exitSignal.exitReason, config);

        if (result.success) {
          // 청산 메트릭
          inc(aid, `exit.${exitSignal.exitReason}`);
          const holdTimeMs = position.filledAt
            ? now - new Date(position.filledAt).getTime()
            : 0;
          record(aid, M.DIST_HOLD_TIME, holdTimeMs);
          record(aid, M.DIST_MFE, position.bestProfitPct ?? 0);
          record(aid, M.DIST_MAE, position.worstProfitPct ?? 0);

          // 청산 상세 로그
          logExitDetail({
            ticker,
            exitReason: exitSignal.exitReason,
            entryPrice: position.entryPrice,
            exitPrice: exitSignal.exitPrice,
            currentPrice,
            bidPrice,
            targetPrice: position.targetPrice,
            stopLossPrice: position.stopLossPrice,
            pullbackLow: position.pullbackLow,
            triggerHigh: position.triggerHigh,
            holdTimeMs,
            mfePct: position.bestProfitPct ?? 0,
            maePct: position.worstProfitPct ?? 0,
            hasReachedPlusOneTick: position.hasReachedPlusOneTick,
            hasReachedPlusTwoTicks: position.hasReachedPlusTwoTicks,
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
//
// 현재 shadow mode 전용. real mode 전환 시 아래 처리가 추가로 필요:
//
// [pending_buy]
//   1. pendingOrderNo로 미체결 주문 조회 (KIS 주문체결조회 API)
//   2. 미체결 잔량 > 0 이면 주문 취소 API 호출
//   3. 부분 체결 시 체결 수량만큼 active 전환 후 즉시 market_close 매도
//   4. 전량 미체결이면 상태 삭제
//
// [pending_sell]
//   1. sellOrderNo로 체결 상태 확인
//   2. 미체결이면 주문 취소 후 시장가 재매도 또는 익일 동시호가 처리
//   3. 체결 완료면 상태 삭제 + 거래 로그 기록
//   4. 익일까지 미확인 시 장전 상태 동기화 로직 필요
// ========================================

export async function forceCloseOrphanPositions(ctx: AccountContext, config: DantaV1Config): Promise<void> {
  const positions = ctx.store.getAllStates<DantaV1State>(DANTA_STATE_COLLECTION);
  const aid = ctx.accountId;

  for (const [ticker, position] of positions) {
    if (position.status === 'pending_buy') {
      // shadow: 가상 주문이므로 즉시 삭제
      // TODO(real mode): 미체결 주문 취소 API 호출 → 부분체결 확인 → 잔량 처리
      console.warn(`${TAG} [OrphanClose] ${ticker} pending_buy at market close — removing state`);
      ctx.store.deleteState(DANTA_STATE_COLLECTION, ticker);
      continue;
    }

    if (position.status === 'pending_sell') {
      // shadow: 가상 체결이므로 이미 처리 완료 상태
      // TODO(real mode): 체결 상태 확인 → 미체결 시 취소 후 시장가 재매도 또는 익일 처리
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
