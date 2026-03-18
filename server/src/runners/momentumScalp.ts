/**
 * 빠른 회전 스캘핑 트리거 (v2) — 로컬 러너
 *
 * 1분 간격 스케줄러: HTS 조건검색 → 코드필터 → 박스하단진입 → 0.5% 익절/손절/5분 타임아웃
 * 장 시간대별 분기:
 *   09:00~09:04 KST → 보유 종목 매도 판단만 (오버나이트 종목 포함)
 *   09:05~15:15 KST → 신규 매수
 *   15:15~15:19 KST → 매수 중단, 보유종목 매도만
 *   15:20~ KST → 종가 단일가 청산 모드 (잔여 active 전부 MARKET 매도)
 * 보유시간 5분: 손실 중→즉시 timeout, 수익 중→1분 연장(최대 6분)
 * 오버나이트 불허 — 15:30 종가 미체결 시 경보 + 수동 개입
 *
 * 원본: idca-functions/src/functions/momentumScalp.ts
 * 변경: Firebase onSchedule/onRequest → 단순 async 함수, Firestore → localStore
 */

import { config } from '../config';
import * as localStore from '../lib/localStore';
import { KisApiClient, getOrRefreshToken, isTokenExpiredError } from '../lib/kisApi';
import { type AccountContext } from '../lib/accountContext';
import {
  sendTelegramMessage,
  getUserTelegramChatId,
} from '../lib/telegram';
import {
  isKRMarketOpen,
  getKSTCurrentMinute,
  getKSTDateString,
  getKRMarketHolidayName,
  getKoreanTickSize,
  getKRMarketMinutesBetween,
} from '../lib/marketUtils';
import { type MinuteBar } from '../lib/rsiCalculator';
import {
  filterQuickScalpCandidate,
  checkBoxEntry,
  calculateQuickScalpTarget,
  checkMomentumScalpExit,
  calculatePositiveScore,
} from '../lib/momentumScalpCalculator';
import {
  type MomentumScalpConfig,
  type MomentumScalpState,
  processSlotRefill,
  createMomentumScalpState,
  updateMomentumScalpStateToActive,
  updateMomentumScalpStateToPendingSell,
  revertMomentumScalpStateToActive,
  deleteMomentumScalpState,
  getMomentumScalpStateByTicker,
} from '../lib/slotAllocator';
import { type CommonConfig, getCommonConfig, getMarketStrategyConfig, isMarketStrategyActive } from '../lib/configHelper';
import { getOccupiedTickersExcluding } from '../lib/activeTickerRegistry';

// 동시 실행 방어
let buyTriggerRunning = false;

// 신규 매수 시작 시간 (09:05 KST = 545분)
const BUY_START_MINUTE = 9 * 60 + 5;

// 신규 매수 마감 시간 (15:15 KST = 915분)
const BUY_END_MINUTE = 15 * 60 + 15;

// 점심시간 매수 스킵 (11:30~13:00 KST) — 유동성 저하 구간
const LUNCH_SKIP_START = 11 * 60 + 30;
const LUNCH_SKIP_END = 13 * 60;

// 종가 단일가 전환 시각 (15:20 KST = 920분) — 접속매매 종료, 이후 close auction
const MARKET_CLOSE_AUCTION_MINUTE = 15 * 60 + 20;

// v2.1: 보유시간 제한 (3분, 기존 5분)
const HOLDING_TIMEOUT_MINUTES = 3;

// v2.1: no-progress exit — 120초 경과 시 MFE < 0.15%이면 조기 청산
const NO_PROGRESS_CHECK_MINUTES = 2;      // 120초
const NO_PROGRESS_MFE_THRESHOLD = 0.15;   // %

// pending_buy 타임아웃 — v2.2: config에서 오버라이드 가능, 기본 15초
const DEFAULT_PENDING_BUY_TTL_MS = 15 * 1000;

// v2.2: 30초 MFE 게이트 — 진입 후 30초 시점, bid가 1틱도 못 올렸으면 즉시 청산
const MFE30_GATE_SECONDS = 30;

// 매도 체크 스냅샷 — 매 라운드 최신값 덮어쓰기, 분당 1회 flush
const sellCheckSnapshots = new Map<string, Record<string, unknown>>();

// 보유 중 가격 궤적 — 5초 간격 bid/current 기록, EXIT 시 함께 저장
const priceTrails = new Map<string, Array<{ t: string; bid: number; cur: number }>>();

// ========================================
// 매수 트리거 (1분 간격)
// ========================================

export async function runMomentumScalpBuyKR(ctx?: AccountContext): Promise<void> {
  if (!isKRMarketOpen()) return;

  if (buyTriggerRunning) {
    console.log('[QuickScalp] Previous trigger still running, skipping');
    return;
  }
  buyTriggerRunning = true;

  console.log('[QuickScalp] Trigger started');

  const now = new Date();
  const kstTime = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  const currentMinute = getKSTCurrentMinute();
  const todayStr = getKSTDateString();

  // 휴장일 확인
  const holidayName = getKRMarketHolidayName(kstTime);
  if (holidayName) {
    console.log(`[QuickScalp] Holiday: ${holidayName}`);
    buyTriggerRunning = false;
    return;
  }

  try {
    try {
      await processAccount(currentMinute, todayStr, ctx);
    } catch (err) {
      console.error(`[QuickScalp] Error:`, err);
      await sendAlert('처리 실패',
        `계좌 처리 중 오류: ${err instanceof Error ? err.message : String(err)}`, ctx);
    }

    console.log('[QuickScalp] Trigger completed');
  } catch (error) {
    console.error('[QuickScalp] Trigger error:', error);
  } finally {
    buyTriggerRunning = false;
  }
}

// ========================================
// 계좌별 처리 메인 로직
// ========================================

async function processAccount(
  currentMinute: number,
  todayStr: string,
  ctx?: AccountContext
): Promise<void> {
  const common = ctx ? ctx.store.getTradingConfig<CommonConfig>() : getCommonConfig();
  if (!common) return;

  if (!isMarketStrategyActive(common, 'domestic', 'momentumScalp')) return;

  const scalpConfig = ctx
    ? ctx.store.getStrategyConfig<MomentumScalpConfig>('domestic', 'momentumScalp')
    : getMarketStrategyConfig<MomentumScalpConfig>('domestic', 'momentumScalp');
  if (!scalpConfig || !scalpConfig.enabled) return;

  // 조건검색 설정 확인
  if (!scalpConfig.conditionSeq || !scalpConfig.htsUserId) {
    console.log(`[QuickScalp] 조건검색 미설정 (htsUserId/conditionSeq 필요)`);
    return;
  }

  const credentials = ctx
    ? { appKey: ctx.credentials.appKey, appSecret: ctx.credentials.appSecret }
    : { appKey: config.kis.appKey, appSecret: config.kis.appSecret };
  const kisClient = ctx?.kisClient ?? new KisApiClient();
  const accountNo = ctx?.credentials.accountNo ?? config.kis.accountNo;
  const accountId = ctx?.accountId ?? config.accountId;
  const userId = config.userId;

  console.log(`[QuickScalp] Processing ${userId}/${accountId}`);

  // 자격증명 & 토큰
  let accessToken = await getOrRefreshToken('', accountId, credentials, kisClient);
  const chatId = await getUserTelegramChatId(userId);

  const { appKey, appSecret } = credentials;

  // pending_buy 체결 확인은 매도 트리거(5초 루프)에서 처리 (single owner 원칙)

  // ======== 신규 종목 선정 (09:05~15:15 KST) ========

  if (currentMinute < BUY_START_MINUTE || currentMinute >= BUY_END_MINUTE) {
    console.log(`[QuickScalp] Outside buy window (${BUY_START_MINUTE}~${BUY_END_MINUTE}), skip new buy`);
    return;
  }

  if (currentMinute >= LUNCH_SKIP_START && currentMinute < LUNCH_SKIP_END) {
    console.log(`[QuickScalp] 점심시간 스킵 (11:30~13:00), skip new buy`);
    return;
  }

  try {
    await handleNewBuy(
      scalpConfig,
      kisClient, appKey, appSecret, accessToken, accountNo,
      todayStr, chatId, currentMinute, ctx
    );
  } catch (err) {
    console.error(`[QuickScalp] New buy error:`, err);
    await sendAlert('신규 매수 실패',
      `${err instanceof Error ? err.message : String(err)}`, ctx);
  }
}

// ========================================
// pending_buy 체결 확인
// ========================================

async function handlePendingBuy(
  state: MomentumScalpState,
  kisClient: KisApiClient,
  appKey: string,
  appSecret: string,
  accessToken: string,
  accountNo: string,
  todayStr: string,
  chatId: string | null,
  ctx?: AccountContext,
  pendingBuyTtlMs?: number
): Promise<string> {
  const { ticker, stockName, pendingOrderNo } = state;
  const store = ctx?.store ?? localStore;

  // ── v2.1: shadow pending_buy fill 확인 ──
  if (state.shadowPendingAt) {
    const pendingAtMs = new Date(state.shadowPendingAt).getTime();
    const nowMs = Date.now();
    const elapsedMs = nowMs - pendingAtMs;
    const elapsedSec = Math.round(elapsedMs / 1000);

    // 호가 조회로 현재 bid 확인
    const askingPrice = await kisClient.getDomesticAskingPrice(
      appKey, appSecret, accessToken, ticker
    );
    await new Promise(resolve => setTimeout(resolve, 200));

    const currentBid = parseInt(askingPrice.output1?.bidp1 || '0');
    const bestAsk = parseInt(askingPrice.output1?.askp1 || '0');
    const entryPrice = state.entryPrice ?? 0;

    // fill 모델: conservative (bestAsk <= entryPrice) vs optimistic (bid+1tick >= entryPrice)
    const tickSize = getKoreanTickSize(entryPrice || currentBid);
    const fillConservative = bestAsk > 0 && entryPrice > 0 && bestAsk <= entryPrice;
    const fillOptimistic = currentBid > 0 && entryPrice > 0 && (currentBid + tickSize) >= entryPrice;
    const isFillable = fillConservative;  // 보수적 모델 기본 사용

    if (isFillable && elapsedMs >= 5000) {
      // 5초 이상 경과 + bestAsk <= entryPrice → fill 확정, active 전환
      updateMomentumScalpStateToActive(
        ticker,
        entryPrice, state.entryQuantity ?? 0,
        state.targetPrice, state.stopLossPrice,
        store
      );
      console.log(`👻 [QuickScalp-Shadow] ${ticker} pending_buy fill 확정 (${elapsedSec}초, ask=${bestAsk}, bid=${currentBid}) → active`);

      // fill 확정 → ENTRY 로그 기록 (dailyEntryCount 및 분석 1:1 매칭에 사용)
      store.appendLog('scalpShadowLogs', todayStr, {
        type: 'ENTRY',
        ticker,
        stockName: stockName || ticker,
        market: 'domestic',
        strategy: 'quickScalp',
        entryPrice,
        entryQuantity: state.entryQuantity ?? 0,
        entryAmount: entryPrice * (state.entryQuantity ?? 0),
        allocatedAmount: state.allocatedAmount,
        targetPrice: state.targetPrice,
        stopLossPrice: state.stopLossPrice,
        shadowFilled: true,
        fillElapsedSec: elapsedSec,
        fillBid: currentBid,
        fillAsk: bestAsk,
        fillModel: 'conservative',
        fillOptimisticWouldFill: fillOptimistic,
        entryBoxPos: state.entryBoxPos,
        boxRangePct: state.boxRangePct,
        spreadTicks: state.spreadTicks,
        targetTicks: state.targetTicks,
        createdAt: new Date().toISOString(),
      });

      return accessToken;
    }

    // v2.2: 설정 가능 TTL (기본 15초)
    const ttlMs = pendingBuyTtlMs ?? DEFAULT_PENDING_BUY_TTL_MS;
    if (elapsedMs >= ttlMs) {
      console.log(`👻 [QuickScalp-Shadow] ${ticker} pending_buy ${elapsedSec}초 경과 (TTL=${ttlMs/1000}s, ask=${bestAsk}, bid=${currentBid}, entry=${entryPrice}) → unfilled, 취소`);
      store.appendLog('scalpShadowLogs', todayStr, {
        type: 'CANCEL',
        ticker,
        stockName: stockName || ticker,
        market: 'domestic',
        strategy: 'quickScalp',
        reason: 'shadow_pending_ttl_expired',
        elapsedSec,
        entryPrice,
        currentBid,
        lastAsk: bestAsk,
        fillConservativeAtCancel: fillConservative,
        fillOptimisticAtCancel: fillOptimistic,
        allocatedAmount: state.allocatedAmount,
        createdAt: new Date().toISOString(),
      });
      deleteMomentumScalpState(ticker, store);
      return accessToken;
    }

    // soft 경고 (TTL의 2/3 경과 시)
    if (elapsedMs >= ttlMs * 0.67) {
      console.log(`👻 [QuickScalp-Shadow] ${ticker} pending_buy ${elapsedSec}초 경과 (TTL=${ttlMs/1000}s), bid=${currentBid} vs entry=${entryPrice} — 대기 중`);
    }

    return accessToken;
  }

  // ── 실전 모드: 기존 pending_buy 체결 확인 ──
  console.log(`[QuickScalp] Checking pending_buy: ${ticker} (order=${pendingOrderNo})`);

  const orderHistory = await kisClient.getDomesticOrderHistory(
    appKey, appSecret, accessToken, accountNo,
    todayStr, todayStr,
    '01',  // 체결만
    '02',  // 매수만
    ticker
  );
  await new Promise(resolve => setTimeout(resolve, 300));

  const filledOrder = orderHistory.output1?.find(
    o => o.odno === pendingOrderNo && parseInt(o.tot_ccld_qty || '0') > 0
  );

  if (filledOrder) {
    const entryPrice = parseInt(filledOrder.avg_prvs || '0');
    const quantity = parseInt(filledOrder.tot_ccld_qty || '0');
    const { targetPrice, stopLossPrice } = calculateQuickScalpTarget(entryPrice);

    updateMomentumScalpStateToActive(
      ticker,
      entryPrice, quantity, targetPrice, stopLossPrice,
      ctx?.store
    );

    console.log(`[QuickScalp] ${ticker} filled: ${quantity}주 @ ${entryPrice}원 → 목표 ${targetPrice} / 손절 ${stopLossPrice}`);

    if (chatId) {
      await sendTelegramMessage(chatId,
        `📈 <b>[스캘핑] ${stockName} 매수 체결</b>\n` +
        `${quantity}주 @ ${entryPrice.toLocaleString()}원\n` +
        `목표: ${targetPrice.toLocaleString()}원 (+0.5%) / 손절: ${stopLossPrice.toLocaleString()}원 (-0.5%)`,
        'HTML'
      );
    }
  } else {
    // 미체결 — v2.2: 설정 가능 TTL (기본 15초)
    const updatedAtMs = state.updatedAt ? new Date(state.updatedAt).getTime() : 0;
    const nowMs = Date.now();
    const elapsedMs = nowMs - updatedAtMs;
    const realTtlMs = pendingBuyTtlMs ?? DEFAULT_PENDING_BUY_TTL_MS;

    if (elapsedMs >= realTtlMs) {
      console.log(`[QuickScalp] ${ticker} pending_buy ${Math.round(elapsedMs / 1000)}초 경과 (TTL=${realTtlMs/1000}s) → 취소`);

      if (pendingOrderNo) {
        try {
          await kisClient.cancelDomesticOrder(
            appKey, appSecret, accessToken, accountNo,
            { orderNo: pendingOrderNo, ticker }
          );
        } catch (cancelErr) {
          console.error(`[QuickScalp] Cancel order failed ${ticker}:`, cancelErr);
        }
        await new Promise(resolve => setTimeout(resolve, 300));
      }

      deleteMomentumScalpState(ticker, ctx?.store);
      console.log(`[QuickScalp] ${ticker} pending_buy cancelled and state deleted`);
    }
  }

  return accessToken;
}

// ========================================
// 신규 종목 선정 + 매수 주문
// ========================================

async function handleNewBuy(
  scalpConfig: MomentumScalpConfig,
  kisClient: KisApiClient,
  appKey: string,
  appSecret: string,
  accessToken: string,
  accountNo: string,
  todayStr: string,
  chatId: string | null,
  currentMinute: number,
  ctx?: AccountContext
): Promise<void> {
  const store = ctx?.store ?? localStore;
  // 빈 슬롯 + 배분 금액 확인
  const refill = await processSlotRefill(
    scalpConfig,
    kisClient, appKey, appSecret, accessToken, accountNo,
    store
  );

  store.appendLog('scalpScanLogs', todayStr, {
    type: 'SLOT_STATUS',
    fillableSlots: refill.fillableSlotCount,
    amountPerSlot: refill.amountPerSlot,
    occupiedTickers: refill.occupiedTickers,
    skippedReason: refill.skippedReason || null,
    checkedAt: new Date().toISOString(),
  });

  if (refill.fillableSlotCount <= 0) {
    console.log(`[QuickScalp] No fillable slots (reason: ${refill.skippedReason || 'full'})`);
    return;
  }

  console.log(`🔍 [QuickScalp] 종목선정 시작 — 슬롯 ${refill.fillableSlotCount}개 비어있음, ${refill.amountPerSlot.toLocaleString()}원/슬롯`);

  // HTS 조건검색 실행
  const conditionResult = await kisClient.getConditionSearchResult(
    appKey, appSecret, accessToken,
    scalpConfig.htsUserId, scalpConfig.conditionSeq
  );
  await new Promise(resolve => setTimeout(resolve, 500));

  const candidates = conditionResult.output2 || [];
  if (candidates.length === 0) {
    console.log('📊 [QuickScalp] 조건검색 결과 없음');
    return;
  }

  // 거래대금 내림차순 정렬 → 상위 20개만 평가 (유동성 높은 종목 우선)
  const MAX_EVAL_CANDIDATES = 20;
  candidates.sort((a, b) => {
    const amtA = parseFloat(a.trade_amt || '0');
    const amtB = parseFloat(b.trade_amt || '0');
    return amtB - amtA;
  });
  const topCandidates = candidates.slice(0, MAX_EVAL_CANDIDATES);

  store.appendLog('scalpScanLogs', todayStr, {
    type: 'CONDITION_RESULT',
    conditionSeq: scalpConfig.conditionSeq,
    totalCandidates: candidates.length,
    candidates: topCandidates.map(t => ({ ticker: t.code, name: t.name, tradeAmt: t.trade_amt })),
    checkedAt: new Date().toISOString(),
  });

  console.log(`📊 [QuickScalp] 조건검색 ${candidates.length}개 → 거래대금 상위 ${topCandidates.length}개 평가`);

  // 쿨다운: 오늘 손절/타임아웃 종목 재진입 방지 (config.cooldownEnabled=true일 때만)
  const cooldownTickers = new Set<string>();
  if (scalpConfig.cooldownEnabled) {
    const todayLogs = store.getLogs<{
      ticker: string;
      exitReason: string;
      createdAt?: string;
    }>('scalpTradeLogs', todayStr);

    for (const logData of todayLogs) {
      if (logData.exitReason === 'stop_loss' || logData.exitReason === 'timeout') {
        cooldownTickers.add(logData.ticker);
      }
    }
  }

  // v2.1: 종목당 일일 진입 횟수 추적 (max 2/ticker/day)
  const MAX_ENTRIES_PER_TICKER_PER_DAY = 2;
  const dailyEntryCount = new Map<string, number>();
  // 완료된 거래 (실전: scalpTradeLogs, 쉐도우: scalpShadowLogs)
  const logCollection = scalpConfig.shadowMode ? 'scalpShadowLogs' : 'scalpTradeLogs';
  const todayTradeLogs = store.getLogs<{ ticker: string; type?: string }>(logCollection, todayStr);
  for (const logData of todayTradeLogs) {
    // ENTRY 로그만 카운트 (EXIT은 별도)
    if (logData.type === 'ENTRY' || (!logData.type && logData.ticker)) {
      dailyEntryCount.set(logData.ticker, (dailyEntryCount.get(logData.ticker) ?? 0) + 1);
    }
  }
  // 현재 진행 중인 state도 카운트
  const currentStates = store.getAllStates<MomentumScalpState>('momentumScalpState');
  for (const [, s] of currentStates) {
    if (['active', 'pending_buy', 'pending_sell'].includes(s.status)) {
      dailyEntryCount.set(s.ticker, (dailyEntryCount.get(s.ticker) ?? 0) + 1);
    }
  }

  // 점유 종목 + 쿨다운 제외 + 다른 전략 점유 종목
  const occupiedSet = new Set(refill.occupiedTickers);
  for (const t of getOccupiedTickersExcluding('domestic', 'momentumScalp')) {
    occupiedSet.add(t);
  }
  const evalTargets: Array<{ ticker: string; name: string; price: number }> = [];

  for (const candidate of topCandidates) {
    const ticker = candidate.code;
    const name = candidate.name;
    const price = Math.round(parseFloat(candidate.price || '0'));

    // v2.1: 우선주 하드 제외 (ticker 끝자리 5 + 6자리, 또는 이름에 '우' 포함)
    const isPreferred = (ticker.length === 6 && ticker.endsWith('5')) ||
                        /[KLMN]$/.test(ticker) ||
                        name.includes('우선') || (name.endsWith('우') && !name.endsWith('건설우'));
    if (isPreferred) {
      console.log(`🚫 [QuickScalp] ${name}(${ticker}) — 우선주 제외 (skip)`);
      continue;
    }

    if (occupiedSet.has(ticker)) {
      console.log(`⏭️ [QuickScalp] ${name}(${ticker}) — 이미 보유중 (skip)`);
      continue;
    }
    if (cooldownTickers.has(ticker)) {
      console.log(`🧊 [QuickScalp] ${name}(${ticker}) — 오늘 손절/타임아웃 기록, 쿨다운 (skip)`);
      continue;
    }

    // v2.1: max 2/ticker/day
    const entryCount = dailyEntryCount.get(ticker) ?? 0;
    if (entryCount >= MAX_ENTRIES_PER_TICKER_PER_DAY) {
      console.log(`🔢 [QuickScalp] ${name}(${ticker}) — 일일 진입 한도 도달 (${entryCount}/${MAX_ENTRIES_PER_TICKER_PER_DAY}, skip)`);
      continue;
    }

    if (price <= 0) continue;
    evalTargets.push({ ticker, name, price });
  }

  // 순차 평가 (호가 조회 → 코드필터 → 박스진입 → 매수)
  let filledCount = 0;

  // 스캔 통계 카운터
  const scanStats = {
    conditionSearchCount: candidates.length,
    evalCount: evalTargets.length,
    invalidPriceCount: 0,
    codeFilterFailCount: 0,
    boxEntryFailCount: 0,
    quantityZeroCount: 0,
    entrySignalCount: 0,
    codeFilterFailReasons: {} as Record<string, number>,
    boxEntryFailReasons: {} as Record<string, number>,
  };

  // 종목별 상세 평가 기록
  const evalDetails: Array<{
    ticker: string; name: string; price: number;
    stage: string; pass: boolean; reason?: string;
    askPrice?: number; bidPrice?: number;
    spreadTicks?: number; targetTicks?: number;
    boxPos?: number; boxHigh?: number; boxLow?: number;
  }> = [];

  for (const target of evalTargets) {
    if (filledCount >= refill.fillableSlotCount) break;

    try {
      // 호가 조회
      const askingPrice = await kisClient.getDomesticAskingPrice(
        appKey, appSecret, accessToken, target.ticker
      );
      await new Promise(resolve => setTimeout(resolve, 300));

      const askPrice = parseInt(askingPrice.output1?.askp1 || '0');
      const bidPrice = parseInt(askingPrice.output1?.bidp1 || '0');
      const currentPrice = parseInt(askingPrice.output2?.stck_prpr || '0');

      if (askPrice <= 0 || bidPrice <= 0 || currentPrice <= 0) {
        scanStats.invalidPriceCount++;
        evalDetails.push({ ticker: target.ticker, name: target.name, price: currentPrice, stage: 'price', pass: false, reason: '가격 0' });
        continue;
      }

      // 코드 필터: targetTicks≥3, spreadTicks≤2, spread/target≤25%
      const filterResult = filterQuickScalpCandidate({
        ticker: target.ticker,
        stockName: target.name,
        currentPrice,
        askPrice,
        bidPrice,
      });

      if (!filterResult.pass) {
        scanStats.codeFilterFailCount++;
        scanStats.codeFilterFailReasons[filterResult.reason] = (scanStats.codeFilterFailReasons[filterResult.reason] || 0) + 1;
        evalDetails.push({ ticker: target.ticker, name: target.name, price: currentPrice, stage: 'codeFilter', pass: false, reason: filterResult.reason, askPrice, bidPrice, spreadTicks: filterResult.spreadTicks, targetTicks: filterResult.targetTicks });
        console.log(`❌ [QuickScalp] ${target.name}(${target.ticker}) — 코드필터: ${filterResult.reason}`);
        continue;
      }

      // 10분 1분봉 조회 → 박스 하단 진입 판단
      const minuteBars = await fetchPaginatedMinuteBars(
        kisClient, appKey, appSecret, accessToken, target.ticker,
        10, 1  // 10개만 필요, 1페이지
      );
      await new Promise(resolve => setTimeout(resolve, 300));

      const spreadPct = (askPrice - bidPrice) / currentPrice * 100;
      const boxResult = checkBoxEntry({ minuteBars, currentPrice, spreadPct, targetTicks: filterResult.targetTicks });

      if (!boxResult.shouldEnter) {
        scanStats.boxEntryFailCount++;
        scanStats.boxEntryFailReasons[boxResult.reason] = (scanStats.boxEntryFailReasons[boxResult.reason] || 0) + 1;
        evalDetails.push({ ticker: target.ticker, name: target.name, price: currentPrice, stage: 'boxEntry', pass: false, reason: boxResult.reason, askPrice, bidPrice, spreadTicks: filterResult.spreadTicks, targetTicks: filterResult.targetTicks, boxPos: boxResult.currentPosition, boxHigh: boxResult.boxHigh, boxLow: boxResult.boxLow });
        console.log(`❌ [QuickScalp] ${target.name}(${target.ticker}) — 박스진입: ${boxResult.reason}`);
        continue;
      }

      // 매수가 = bid + 1틱
      const buyPrice = bidPrice + getKoreanTickSize(bidPrice);

      // 매수 수량 계산
      const quantity = Math.floor(refill.amountPerSlot / buyPrice);
      if (quantity <= 0) {
        scanStats.quantityZeroCount++;
        console.log(`❌ [QuickScalp] ${target.name}(${target.ticker}) — 수량=0 (${buyPrice.toLocaleString()}원)`);
        continue;
      }

      const boxRangePctVal = boxResult.boxHigh > 0 ? ((boxResult.boxHigh - boxResult.boxLow) / currentPrice * 100) : 0;
      const entryConditions = {
        entryBoxPos: boxResult.currentPosition,
        boxRangePct: boxRangePctVal || null,
        spreadTicks: filterResult.spreadTicks,
        targetTicks: filterResult.targetTicks,
      };

      // v2.2: Positive Selection Score 계산 (기록용, 하드 게이트는 config로 별도 ON)
      const scoreResult = calculatePositiveScore({
        recentBars: minuteBars,
        entryBoxPos: boxResult.currentPosition,
        boxRangePct: boxRangePctVal,
        targetTicks: filterResult.targetTicks,
      });

      // v2.2: score 하드 게이트 (config.positiveScoreGateEnabled = true 일 때만)
      if (scalpConfig.positiveScoreGateEnabled) {
        const minScore = scalpConfig.positiveScoreMinimum ?? 3;
        if (scoreResult.score < minScore) {
          console.log(`📊 [QuickScalp] ${target.name}(${target.ticker}) — positiveScore ${scoreResult.score} < ${minScore} (${scoreResult.details.join(', ')}) → 스킵`);
          evalDetails.push({ ticker: target.ticker, name: target.name, price: currentPrice, stage: 'positiveScore', pass: false, reason: `score ${scoreResult.score} < ${minScore}`, askPrice, bidPrice, spreadTicks: filterResult.spreadTicks, targetTicks: filterResult.targetTicks, boxPos: boxResult.currentPosition, boxHigh: boxResult.boxHigh, boxLow: boxResult.boxLow });
          continue;
        }
      }

      console.log(`📊 [QuickScalp] ${target.name}(${target.ticker}) — positiveScore=${scoreResult.score} [${scoreResult.details.join(', ')}] mom=${scoreResult.recentMomentumPct?.toFixed(2) ?? 'N/A'}%`);

      evalDetails.push({ ticker: target.ticker, name: target.name, price: currentPrice, stage: 'entry', pass: true, askPrice, bidPrice, spreadTicks: filterResult.spreadTicks, targetTicks: filterResult.targetTicks, boxPos: boxResult.currentPosition, boxHigh: boxResult.boxHigh, boxLow: boxResult.boxLow });

      if (scalpConfig.shadowMode) {
        // ── v2.1 쉐도우 모드: pending_buy로 생성 → 매도 루프에서 fill 확인 ──
        // 즉시 active 대신 pending_buy 유지, shadowPendingAt 기록
        // 매도 루프의 handlePendingBuy에서 30s soft / 60s hard TTL로 fill 판단
        const { targetPrice: tp, stopLossPrice: sl } = calculateQuickScalpTarget(buyPrice);
        const now = new Date().toISOString();

        createMomentumScalpState(
          target.ticker, target.name,
          refill.amountPerSlot, null, entryConditions, store,
          now  // shadowPendingAt
        );
        // pending_buy 상태로 남김 — 의도 매수가/수량/TP/SL + v2.2 score 저장
        const pendingStore = ctx?.store ?? localStore;
        pendingStore.updateState('momentumScalpState', target.ticker, {
          entryPrice: buyPrice, entryQuantity: quantity,
          targetPrice: tp, stopLossPrice: sl,
          positiveScore: scoreResult.score,
          positiveScoreDetails: scoreResult.details.join(', ') || null,
        });

        scanStats.entrySignalCount++;
        filledCount++;
        occupiedSet.add(target.ticker);

        const ttlLabel = (scalpConfig.pendingBuyTtlMs ?? DEFAULT_PENDING_BUY_TTL_MS) / 1000;
        console.log(`👻 [QuickScalp-Shadow] ${target.name}(${target.ticker}) — 가상 pending_buy: ${quantity}주 @ ${buyPrice.toLocaleString()}원 (bid+1틱) TP=${tp.toLocaleString()} SL=${sl.toLocaleString()} [${ttlLabel}s TTL] score=${scoreResult.score}`);

        // 쉐도우 진입 로그 파일 기록 (PENDING_ENTRY — fill 확정 시 ENTRY로 별도 기록)
        store.appendLog('scalpShadowLogs', todayStr, {
          type: 'PENDING_ENTRY',
          ticker: target.ticker,
          stockName: target.name,
          market: 'domestic',
          strategy: 'quickScalp',
          entryPrice: buyPrice,
          entryQuantity: quantity,
          entryAmount: buyPrice * quantity,
          allocatedAmount: refill.amountPerSlot,
          targetPrice: tp,
          stopLossPrice: sl,
          shadowPending: true,
          // 진입 조건
          entryBoxPos: entryConditions.entryBoxPos,
          boxRangePct: entryConditions.boxRangePct,
          boxHigh: boxResult.boxHigh,
          boxLow: boxResult.boxLow,
          spreadTicks: entryConditions.spreadTicks,
          targetTicks: entryConditions.targetTicks,
          // 시장 가격
          currentPrice,
          askPrice,
          bidPrice,
          // 진입 시점 분봉 (최근 10개 OHLC)
          recentBars: minuteBars.slice(-10).map(b => ({
            t: b.time, o: b.open, h: b.high, l: b.low, c: b.close,
          })),
          // v2.2 positive selection
          positiveScore: scoreResult.score,
          positiveScoreDetails: scoreResult.details.join(', ') || null,
          recentMomentumPct: scoreResult.recentMomentumPct,
          createdAt: now,
        });
      } else {
        // ── 실전 모드: 실제 매수 주문 ──
        const orderResult = await kisClient.submitDomesticOrder(
          appKey, appSecret, accessToken, accountNo,
          { ticker: target.ticker, side: 'BUY', orderType: 'LIMIT', price: buyPrice, quantity }
        );
        await new Promise(resolve => setTimeout(resolve, 500));

        if (orderResult.output?.ODNO) {
          createMomentumScalpState(
            target.ticker, target.name,
            refill.amountPerSlot, orderResult.output.ODNO, entryConditions, store
          );
          // v2.2: score를 state에 저장
          const realStore = ctx?.store ?? localStore;
          realStore.updateState('momentumScalpState', target.ticker, {
            positiveScore: scoreResult.score,
            positiveScoreDetails: scoreResult.details.join(', ') || null,
          });

          scanStats.entrySignalCount++;
          filledCount++;
          occupiedSet.add(target.ticker);

          console.log(`💰 [QuickScalp] ${target.name}(${target.ticker}) — 매수 주문: ${quantity}주 @ ${buyPrice.toLocaleString()}원 (bid+1틱, 주문번호: ${orderResult.output.ODNO})`);

          if (chatId) {
            await sendTelegramMessage(chatId,
              `📈 <b>[스캘핑] ${target.name} 매수 주문</b>\n` +
              `${quantity}주 @ ${buyPrice.toLocaleString()}원 (bid+1틱)\n` +
              `박스위치: ${(boxResult.currentPosition * 100).toFixed(0)}% (하단 ${(boxResult.boxLow).toLocaleString()}~${(boxResult.boxHigh).toLocaleString()})`,
              'HTML'
            );
          }
        }
      }
    } catch (err) {
      console.error(`❌ [QuickScalp] ${target.name}(${target.ticker}) — 주문 오류:`, err);
    }
  }

  console.log(`📋 [QuickScalp] 종목선정 완료 — 후보 ${evalTargets.length}개 중 ${filledCount}개 매수 주문`);

  // 스캔 통계 로그 기록 (scalpScanLogs)
  try {
    store.appendLog('scalpScanLogs', todayStr, {
      ...scanStats,
      evalDetails,
      currentMinute,
      shadowMode: scalpConfig.shadowMode || false,
      createdAt: new Date().toISOString(),
    });
  } catch (logErr) {
    console.error('[QuickScalp] Scan log write failed:', logErr);
  }
}

// ========================================
// TradeLog 기록
// ========================================

function writeTradeLog(
  params: {
    ticker: string;
    stockName: string;
    entryPrice: number;
    entryQuantity: number;
    exitPrice: number;
    exitQuantity: number;
    exitReason: 'target' | 'stop_loss' | 'timeout' | 'market_close_auction' | 'no_follow_through_30s';
    allocatedAmount: number;
    enteredAt: string | null;
    // 진입 조건 기록
    entryBoxPos?: number | null;       // 박스 내 진입 위치 (0~1)
    boxRangePct?: number | null;       // 박스 범위 (%)
    spreadTicks?: number | null;       // 진입 시 스프레드 틱 수
    targetTicks?: number | null;       // 0.5% 도달에 필요한 틱 수
    // 실행 품질 기록
    bestBidAtExit?: number | null;     // 매도 판단 시점의 best bid
    // v2.2
    mfe30Ticks?: number | null;
    mfe30Gate?: string | null;
    positiveScore?: number | null;
    positiveScoreDetails?: string | null;
    bestProfitPct?: number | null;
  },
  ctx?: AccountContext
): void {
  const {
    ticker, stockName, entryPrice, entryQuantity,
    exitPrice, exitQuantity, exitReason,
    allocatedAmount, enteredAt,
    entryBoxPos, boxRangePct, spreadTicks, targetTicks,
    bestBidAtExit,
  } = params;

  const entryAmount = entryPrice * entryQuantity;
  const exitAmount = exitPrice * exitQuantity;
  const profitAmount = exitAmount - entryAmount;
  const profitRate = (exitPrice - entryPrice) / entryPrice;

  // 진입→청산 소요 시간 (초)
  let timeToExitSec: number | null = null;
  if (enteredAt) {
    timeToExitSec = Math.round((Date.now() - new Date(enteredAt).getTime()) / 1000);
  }

  const todayStr = getKSTDateString();
  const store = ctx?.store ?? localStore;
  store.appendLog('scalpTradeLogs', todayStr, {
    ticker,
    stockName,
    market: 'domestic',
    strategy: 'quickScalp',
    entryPrice,
    entryQuantity,
    entryAmount,
    enteredAt: enteredAt || new Date().toISOString(),
    allocatedAmount,
    exitPrice,
    exitQuantity,
    exitAmount,
    exitedAt: new Date().toISOString(),
    exitReason,
    profitAmount,
    profitRate,
    // 진입 조건
    entryBoxPos: entryBoxPos ?? null,
    boxRangePct: boxRangePct ?? null,
    spreadTicks: spreadTicks ?? null,
    targetTicks: targetTicks ?? null,
    // 실행 품질
    bestBidAtExit: bestBidAtExit ?? null,
    timeToExitSec,
    // v2.2
    mfe30Ticks: params.mfe30Ticks ?? null,
    mfe30Gate: params.mfe30Gate ?? null,
    positiveScore: params.positiveScore ?? null,
    positiveScoreDetails: params.positiveScoreDetails ?? null,
    bestProfitPct: params.bestProfitPct ?? null,
    createdAt: new Date().toISOString(),
  });

  console.log(`[QuickScalp] TradeLog: ${ticker} ${exitReason} ${(profitRate * 100).toFixed(2)}% (${timeToExitSec}s)`);
}

/**
 * 쉐도우 매매 로그 기록 — scalpShadowLogs
 * 실전 로그(scalpTradeLogs)와 분리, 가상 체결 데이터 수집용
 */
function writeShadowTradeLog(
  params: {
    ticker: string;
    stockName: string;
    entryPrice: number;
    entryQuantity: number;
    exitPrice: number;
    exitReason: 'target' | 'stop_loss' | 'timeout' | 'market_close_auction' | 'no_follow_through_30s';
    allocatedAmount: number;
    enteredAt: string | null;
    entryBoxPos?: number | null;
    boxRangePct?: number | null;
    spreadTicks?: number | null;
    targetTicks?: number | null;
    bestBidAtExit?: number | null;
    currentPriceAtExit?: number | null;
    // v2.2 로깅
    mfe30Ticks?: number | null;
    mfe30Gate?: 'pass' | 'fail' | 'pending' | null;
    positiveScore?: number | null;
    positiveScoreDetails?: string | null;
    recentMomentumPct?: number | null;
    bestProfitPct?: number | null;
  },
  ctx?: AccountContext
): void {
  const {
    ticker, stockName, entryPrice, entryQuantity,
    exitPrice, exitReason, allocatedAmount, enteredAt,
    entryBoxPos, boxRangePct, spreadTicks, targetTicks,
    bestBidAtExit, currentPriceAtExit,
  } = params;

  const entryAmount = entryPrice * entryQuantity;
  const exitAmount = exitPrice * entryQuantity;
  const profitAmount = exitAmount - entryAmount;
  const profitRate = (exitPrice - entryPrice) / entryPrice;

  let timeToExitSec: number | null = null;
  if (enteredAt) {
    timeToExitSec = Math.round((Date.now() - new Date(enteredAt).getTime()) / 1000);
  }

  const todayStr = getKSTDateString();
  const store = ctx?.store ?? localStore;
  store.appendLog('scalpShadowLogs', todayStr, {
    type: 'EXIT',
    ticker,
    stockName,
    market: 'domestic',
    strategy: 'quickScalp',
    entryPrice,
    entryQuantity,
    entryAmount,
    enteredAt: enteredAt || new Date().toISOString(),
    allocatedAmount,
    exitPrice,
    exitAmount,
    exitedAt: new Date().toISOString(),
    exitReason,
    profitAmount,
    profitRate,
    profitRatePct: Number((profitRate * 100).toFixed(2)),
    // 진입 조건
    entryBoxPos: entryBoxPos ?? null,
    boxRangePct: boxRangePct ?? null,
    spreadTicks: spreadTicks ?? null,
    targetTicks: targetTicks ?? null,
    // 실행 품질
    bestBidAtExit: bestBidAtExit ?? null,
    currentPriceAtExit: currentPriceAtExit ?? null,
    timeToExitSec,
    // 보유 중 가격 궤적 (5초 간격 bid/current)
    priceTrail: priceTrails.get(ticker) || [],
    // v2.2 분석용 필드
    mfe30Ticks: params.mfe30Ticks ?? null,
    mfe30Gate: params.mfe30Gate ?? null,
    positiveScore: params.positiveScore ?? null,
    positiveScoreDetails: params.positiveScoreDetails ?? null,
    recentMomentumPct: params.recentMomentumPct ?? null,
    bestProfitPct: params.bestProfitPct ?? null,
    createdAt: new Date().toISOString(),
  });

  // trail 정리
  priceTrails.delete(ticker);

  console.log(`👻 [QuickScalp-Shadow] TradeLog: ${ticker} ${exitReason} ${(profitRate * 100).toFixed(2)}% (${timeToExitSec}s)`);
}

// ========================================
// 매도 전용 트리거 (1분 간격)
// ========================================

let sellTriggerRunning = false;

// pending_sell 타임아웃 (5분)
const PENDING_SELL_TIMEOUT_MS = 5 * 60 * 1000;

// 매도 API 최대 재시도 횟수
const SELL_API_MAX_RETRIES = 3;

export async function runMomentumScalpSellKR(ctx?: AccountContext): Promise<void> {
  if (!isKRMarketOpen()) return;

  if (sellTriggerRunning) {
    console.log('[QuickScalp-Sell] Previous trigger still running, skipping');
    return;
  }
  sellTriggerRunning = true;

  const now = new Date();
  const kstTime = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  const todayStr = getKSTDateString();

  const holidayName = getKRMarketHolidayName(kstTime);
  if (holidayName) {
    sellTriggerRunning = false;
    return;
  }

  const currentMinute = getKSTCurrentMinute();

  try {
    try {
      await processSellAccount(todayStr, currentMinute, ctx);
    } catch (err) {
      console.error(`[QuickScalp-Sell] Error:`, err);
    }
  } catch (error) {
    console.error('[QuickScalp-Sell] Trigger error:', error);
  } finally {
    sellTriggerRunning = false;
  }
}

async function processSellAccount(
  todayStr: string,
  currentMinute: number,
  ctx?: AccountContext
): Promise<void> {
  const store = ctx?.store ?? localStore;
  const common = ctx ? ctx.store.getTradingConfig<CommonConfig>() : getCommonConfig();
  if (!common) return;

  if (!isMarketStrategyActive(common, 'domestic', 'momentumScalp')) {
    // 매도 전용 모드: 활성 슬롯이 있으면 매도만 처리
    const activeStates = store.getStatesWhere<MomentumScalpState & Record<string, unknown>>(
      'momentumScalpState',
      s => s.status === 'active' || s.status === 'pending_sell'
    );
    if (activeStates.size === 0) return;
    console.log(`[QuickScalp] 매도 전용 모드`);
  }

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
  const userId = config.userId;
  let accessToken = await getOrRefreshToken('', accountId, credentials, kisClient);
  const chatId = await getUserTelegramChatId(userId);
  const { appKey, appSecret } = credentials;

  // ── 1차: pending_sell 체결 확인 (1회만) ──
  const allStates = store.getAllStates<MomentumScalpState>('momentumScalpState');

  for (const [, state] of allStates) {
    if (state.status !== 'pending_sell') continue;

    try {
      accessToken = await handlePendingSell(
        state, currentMinute,
        kisClient, appKey, appSecret, accessToken, accountNo,
        todayStr, chatId, ctx
      );
    } catch (err) {
      if (isTokenExpiredError(err)) {
        accessToken = await getOrRefreshToken(
          '', accountId, credentials, kisClient, true
        );
      }
      console.error(`[QuickScalp-Sell] PendingSell error ${state.ticker}:`, err);
    }
    await new Promise(resolve => setTimeout(resolve, 300));
  }

  // ── 장마감 종가 단일가 청산 (15:20 이후) ──
  // 15:20부터 접속매매 종료 → bestBid 기반 5초 루프 의미 없음
  // active 전부 종가 단일가 MARKET 매도 1회 제출, pending_sell은 유지
  if (currentMinute >= MARKET_CLOSE_AUCTION_MINUTE) {
    console.log(`[QuickScalp-Sell] 15:20 종가 단일가 전환 — 잔여 포지션 청산 모드`);

    // pending_buy는 취소/삭제
    for (const [, state] of allStates) {
      if (state.status !== 'pending_buy') continue;

      if (!scalpConfig.shadowMode && state.pendingOrderNo) {
        try {
          await kisClient.cancelDomesticOrder(
            appKey, appSecret, accessToken, accountNo,
            { orderNo: state.pendingOrderNo, ticker: state.ticker }
          );
        } catch (cancelErr) {
          console.error(`[QuickScalp-Sell] Close auction pending_buy cancel failed ${state.ticker}:`, cancelErr);
        }
        await new Promise(resolve => setTimeout(resolve, 300));
      }
      if (scalpConfig.shadowMode) {
        store.appendLog('scalpShadowLogs', todayStr, {
          type: 'CANCEL',
          ticker: state.ticker,
          stockName: state.stockName || state.ticker,
          market: 'domestic',
          strategy: 'quickScalp',
          reason: 'market_close_pending_buy_cancel',
          allocatedAmount: state.allocatedAmount,
          createdAt: new Date().toISOString(),
        });
      }
      deleteMomentumScalpState(state.ticker, store);
      console.log(`[QuickScalp-Sell] ${state.ticker} pending_buy 취소 (장마감)${scalpConfig.shadowMode ? ' [shadow]' : ''}`);
    }

    // active → 장마감 청산
    for (const [, state] of allStates) {
      if (state.status !== 'active') continue;

      const { ticker, stockName, entryPrice, entryQuantity } = state;
      if (!entryQuantity || entryQuantity <= 0) continue;

      if (scalpConfig.shadowMode) {
        // ── 쉐도우: 호가 조회 → bestBid로 가상 체결 ──
        if (!entryPrice) continue;

        const askingPrice = await kisClient.getDomesticAskingPrice(
          appKey, appSecret, accessToken, ticker
        );
        await new Promise(resolve => setTimeout(resolve, 200));

        const bidPrice = parseInt(askingPrice.output1?.bidp1 || '0');
        const currentPrice = parseInt(askingPrice.output2?.stck_prpr || '0');
        const exitPrice = bidPrice > 0 ? bidPrice : currentPrice;

        if (exitPrice <= 0) continue;

        writeShadowTradeLog({
          ticker,
          stockName: stockName || ticker,
          entryPrice,
          entryQuantity,
          exitPrice,
          exitReason: 'market_close_auction',
          allocatedAmount: state.allocatedAmount,
          enteredAt: state.enteredAt,
          entryBoxPos: state.entryBoxPos,
          boxRangePct: state.boxRangePct,
          spreadTicks: state.spreadTicks,
          targetTicks: state.targetTicks,
          bestBidAtExit: bidPrice,
          currentPriceAtExit: currentPrice,
        }, ctx);

        deleteMomentumScalpState(ticker, store);
        const profitRate = ((exitPrice - entryPrice) / entryPrice * 100).toFixed(2);
        console.log(`👻 [QuickScalp-Shadow] ${ticker} 장마감 가상 청산: ${profitRate}% exit@${exitPrice.toLocaleString()}`);
      } else {
        // ── 실전: 종가 단일가 MARKET 매도 ──
        console.log(`[QuickScalp-Sell] ${ticker} 종가 단일가 MARKET 매도 ${entryQuantity}주`);

        try {
          const sellResult = await kisClient.submitDomesticOrder(
            appKey, appSecret, accessToken, accountNo,
            {
              ticker,
              side: 'SELL',
              orderType: 'MARKET',
              price: 0,
              quantity: entryQuantity,
            }
          );

          if (sellResult.output?.ODNO) {
            updateMomentumScalpStateToPendingSell(
              ticker,
              sellResult.output.ODNO,
              'market_close_auction',
              undefined,
              store
            );
            console.log(`[QuickScalp-Sell] ${ticker} 종가 단일가 매도 주문: ${sellResult.output.ODNO} → pending_sell`);

            if (chatId) {
              await sendTelegramMessage(chatId,
                `🔔 <b>[스캘핑] ${stockName} 장마감 청산</b>\n` +
                `${entryQuantity}주 @ 종가 단일가 시장가\n` +
                `15:30 종가 체결 대기`,
                'HTML'
              );
            }
          }
        } catch (err) {
          console.error(`[QuickScalp-Sell] ${ticker} 종가 단일가 매도 실패:`, err);
          if (isTokenExpiredError(err)) {
            accessToken = await getOrRefreshToken(
              '', accountId,
              { appKey, appSecret },
              kisClient, true
            );
          }
          if (chatId) {
            await sendTelegramMessage(chatId,
              `⚠️ <b>[스캘핑] ${stockName} 장마감 청산 실패</b>\n` +
              `수동 확인 필요`,
              'HTML'
            );
          }
        }
      }
      await new Promise(resolve => setTimeout(resolve, 300));
    }

    // 15:20 이후에는 일반 TP/SL 루프 스킵 (종가 단일가에서 bestBid 체크 무의미)
    return;
  }

  // ── 2차: pending_buy 체결확인 + active 종목 고속 반복 체크 (5초×9회, 최대 ~45초) ──
  const EXIT_CHECK_INTERVAL_MS = 5000;
  const EXIT_CHECK_MAX_ROUNDS = 9;
  const startMs = Date.now();
  const exitedTickers = new Set<string>(); // 이번 실행에서 이미 청산한 ticker — 중복 청산 방지

  for (let round = 0; round < EXIT_CHECK_MAX_ROUNDS; round++) {
    // 안전 타임아웃: 실행 시작 후 45초 초과 시 중단
    if (Date.now() - startMs > 40000) {
      console.log(`[QuickScalp-Sell] 고속 체크 시간 초과 (${round}회 완료)`);
      break;
    }

    // 매 라운드마다 전체 상태 재조회
    const roundStates = store.getStatesWhere<MomentumScalpState & Record<string, unknown>>(
      'momentumScalpState',
      s => s.status === 'pending_buy' || s.status === 'active'
    );

    if (roundStates.size === 0) {
      if (round === 0) console.log(`[QuickScalp-Sell] pending_buy/active 종목 없음, 스킵`);
      break;
    }

    // pending_buy 체결 확인 (single owner: 매도 트리거만 담당)
    for (const [, state] of roundStates) {
      if (state.status !== 'pending_buy') continue;

      try {
        accessToken = await handlePendingBuy(
          state,
          kisClient, appKey, appSecret, accessToken, accountNo,
          todayStr, chatId, ctx,
          scalpConfig.pendingBuyTtlMs
        );
      } catch (err) {
        if (isTokenExpiredError(err)) {
          accessToken = await getOrRefreshToken(
            '', accountId, credentials, kisClient, true
          );
        }
        console.error(`[QuickScalp-Sell] PendingBuy check error ${state.ticker}:`, err);
      }
      await new Promise(resolve => setTimeout(resolve, 200));
    }

    // active 종목 exit 체크 (이미 청산한 ticker 제외)
    const activeStates = Array.from(roundStates.values())
      .filter(s => s.status === 'active' && !exitedTickers.has(s.ticker));

    if (activeStates.length === 0 && round > 0) {
      // pending_buy만 남아있으면 계속 체결 확인 루프
    }

    if (round > 0 && activeStates.length > 0) {
      console.log(`[QuickScalp-Sell] 고속 체크 ${round + 1}/${EXIT_CHECK_MAX_ROUNDS} (active ${activeStates.length}종목)`);
    }

    for (const state of activeStates) {
      try {
        accessToken = await handleSellCheck(
          state,
          kisClient, appKey, appSecret, accessToken, accountNo,
          chatId, scalpConfig.shadowMode, ctx
        );
        // 청산 완료 확인: state가 삭제되었으면 exitedTickers에 추가
        const postState = getMomentumScalpStateByTicker(state.ticker, store);
        if (!postState) {
          exitedTickers.add(state.ticker);
        }
      } catch (err) {
        if (isTokenExpiredError(err)) {
          accessToken = await getOrRefreshToken(
            '', accountId, credentials, kisClient, true
          );
        }
        console.error(`[QuickScalp-Sell] SellCheck error ${state.ticker}:`, err);
      }
      await new Promise(resolve => setTimeout(resolve, 300));
    }

    // 다음 라운드 전 대기 (마지막 라운드는 대기 불필요)
    if (round < EXIT_CHECK_MAX_ROUNDS - 1) {
      await new Promise(resolve => setTimeout(resolve, EXIT_CHECK_INTERVAL_MS));
    }
  }

  // 루프 종료 — HOLD 스냅샷 분당 1회 flush
  if (sellCheckSnapshots.size > 0) {
    const flushStore = ctx?.store ?? localStore;
    const flushDate = getKSTDateString();
    for (const snapshot of sellCheckSnapshots.values()) {
      flushStore.appendLog('scalpSellCheckLogs', flushDate, snapshot);
    }
    sellCheckSnapshots.clear();
  }
}

/**
 * active 종목 매도 판단 — +0.5% 익절 / -0.5% 손절 / 5분 타임아웃
 */
async function handleSellCheck(
  state: MomentumScalpState,
  kisClient: KisApiClient,
  appKey: string,
  appSecret: string,
  accessToken: string,
  accountNo: string,
  chatId: string | null,
  shadowMode = false,
  ctx?: AccountContext
): Promise<string> {
  const { ticker, stockName, entryPrice, entryQuantity, targetPrice, stopLossPrice } = state;

  if (!entryPrice || !entryQuantity || !targetPrice || !stopLossPrice) {
    console.log(`[QuickScalp-Sell] ${ticker} active but missing price info, skip`);
    return accessToken;
  }

  // 현재가 + 호가 조회
  const askingPrice = await kisClient.getDomesticAskingPrice(
    appKey, appSecret, accessToken, ticker
  );
  await new Promise(resolve => setTimeout(resolve, 200));

  const currentPrice = parseInt(askingPrice.output2?.stck_prpr || '0');
  const bidPrice = parseInt(askingPrice.output1?.bidp1 || '0');

  if (currentPrice <= 0 || bidPrice <= 0) {
    console.log(`[QuickScalp-Sell] ${ticker} invalid price data, skip`);
    return accessToken;
  }

  // 가격 궤적 기록
  if (!priceTrails.has(ticker)) priceTrails.set(ticker, []);
  priceTrails.get(ticker)!.push({
    t: new Date().toISOString().slice(11, 19),
    bid: bidPrice,
    cur: currentPrice,
  });

  // 보유시간 계산
  let holdingMinutes = 0;
  if (state.enteredAt) {
    holdingMinutes = getKRMarketMinutesBetween(new Date(state.enteredAt).getTime(), Date.now());
  }

  // v2.1: MFE(최대 수익률) 추적 — state에 bestProfitPct 갱신
  const currentProfitPct = ((bidPrice - entryPrice) / entryPrice) * 100;
  const prevBestProfitPct = state.bestProfitPct ?? 0;
  if (currentProfitPct > prevBestProfitPct) {
    const storeForUpdate = ctx?.store ?? localStore;
    storeForUpdate.updateState('momentumScalpState', ticker, {
      bestProfitPct: currentProfitPct,
    });
  }
  const bestProfitPct = Math.max(prevBestProfitPct, currentProfitPct);

  // 보유 경과시간 (초)
  const holdingSeconds = state.enteredAt
    ? Math.round((Date.now() - new Date(state.enteredAt).getTime()) / 1000)
    : 0;

  // ── v2.2: 30초 MFE 게이트 ──
  // 진입 후 30초 경과 && 아직 미평가 → bid가 1틱이라도 올라왔는지 판정
  // mfe30GateChecked로 1회만 평가 (5초 주기 지터에도 안전)
  if (!state.mfe30GateChecked && holdingSeconds >= MFE30_GATE_SECONDS) {
    const tickSize = getKoreanTickSize(entryPrice);
    const maxBidSinceEntry = entryPrice * (1 + bestProfitPct / 100);
    const mfe30Ticks = Math.floor((maxBidSinceEntry - entryPrice) / tickSize);

    // state에 gate 평가 완료 기록
    const storeForGate = ctx?.store ?? localStore;
    storeForGate.updateState('momentumScalpState', ticker, {
      mfe30GateChecked: true,
    });

    if (mfe30Ticks <= 0) {
      // 30초 내 1틱도 못 밀어줌 → 즉시 청산
      console.log(`🚫 [QuickScalp-Sell] ${ticker} MFE30 게이트 실패: mfe30Ticks=${mfe30Ticks} (bestProfitPct=${bestProfitPct.toFixed(3)}%, ${holdingSeconds}s) → 즉시 청산`);

      const exitPrice = bidPrice;
      const profitRate = ((exitPrice - entryPrice) / entryPrice * 100).toFixed(2);
      const profitAmount = (exitPrice - entryPrice) * entryQuantity;

      if (shadowMode) {
        writeShadowTradeLog({
          ticker,
          stockName: stockName || ticker,
          entryPrice,
          entryQuantity,
          exitPrice,
          exitReason: 'no_follow_through_30s',
          allocatedAmount: state.allocatedAmount,
          enteredAt: state.enteredAt,
          entryBoxPos: state.entryBoxPos,
          boxRangePct: state.boxRangePct,
          spreadTicks: state.spreadTicks,
          targetTicks: state.targetTicks,
          bestBidAtExit: bidPrice,
          currentPriceAtExit: currentPrice,
          mfe30Ticks: mfe30Ticks,
          mfe30Gate: 'fail',
          positiveScore: state.positiveScore,
          positiveScoreDetails: state.positiveScoreDetails,
          bestProfitPct: bestProfitPct,
        }, ctx);

        deleteMomentumScalpState(ticker, ctx?.store);
        console.log(`👻 [QuickScalp-Shadow] ${ticker} MFE30 게이트 청산: ${profitRate}% (${profitAmount.toLocaleString()}원)`);
        return accessToken;
      } else {
        // 실전 모드: MARKET 매도
        const sellResult = await kisClient.submitDomesticOrder(
          appKey, appSecret, accessToken, accountNo,
          { ticker, side: 'SELL', orderType: 'MARKET', price: 0, quantity: entryQuantity }
        );
        if (sellResult.output?.ODNO) {
          updateMomentumScalpStateToPendingSell(
            ticker, sellResult.output.ODNO,
            'no_follow_through_30s',
            bidPrice, ctx?.store
          );
          console.log(`[QuickScalp-Sell] ${ticker} MFE30 게이트 매도 주문: ${sellResult.output.ODNO}`);
          if (chatId) {
            await sendTelegramMessage(chatId,
              `🚫 <b>[스캘핑] ${stockName} MFE30 게이트 청산</b>\n` +
              `${entryQuantity}주 @ 시장가\n` +
              `30초 내 follow-through 없음 (mfe30Ticks=${mfe30Ticks})`,
              'HTML'
            );
          }
        }
        return accessToken;
      }
    } else {
      console.log(`✅ [QuickScalp-Sell] ${ticker} MFE30 게이트 통과: mfe30Ticks=${mfe30Ticks} (bestProfitPct=${bestProfitPct.toFixed(3)}%, ${holdingSeconds}s)`);
    }
  }

  // 보유시간 타임아웃 체크 (v2.1: 3분, 수익 중이면 +1분 연장)
  const ROUND_TRIP_COST_PCT = 0.0023; // ~0.23% (수수료 0.015%×2 + 세금 0.18%, BanKIS 기준)
  let isTimeout = false;

  // v2.1: no-progress exit — 120초 경과 시 MFE < 0.15%이면 조기 청산
  if (!isTimeout && holdingMinutes >= NO_PROGRESS_CHECK_MINUTES && bestProfitPct < NO_PROGRESS_MFE_THRESHOLD) {
    isTimeout = true;
    console.log(`[QuickScalp-Sell] ${ticker} 보유 ${holdingMinutes}분, MFE ${bestProfitPct.toFixed(2)}% < ${NO_PROGRESS_MFE_THRESHOLD}% → no-progress timeout`);
  }

  if (!isTimeout && holdingMinutes >= HOLDING_TIMEOUT_MINUTES) {
    const breakEvenPrice = entryPrice * (1 + ROUND_TRIP_COST_PCT);
    const isNetProfitable = bidPrice > breakEvenPrice;

    if (!isNetProfitable) {
      isTimeout = true;
      console.log(`[QuickScalp-Sell] ${ticker} 보유 ${holdingMinutes}분, 순손실 (bid ${bidPrice} <= breakEven ${Math.ceil(breakEvenPrice)}) → 즉시 timeout`);
    } else if (holdingMinutes >= HOLDING_TIMEOUT_MINUTES + 1) {
      isTimeout = true;
      console.log(`[QuickScalp-Sell] ${ticker} 보유 ${holdingMinutes}분, 순수익 중이나 연장 한도(${HOLDING_TIMEOUT_MINUTES + 1}분) 도달 → timeout`);
    } else {
      console.log(`[QuickScalp-Sell] ${ticker} 보유 ${holdingMinutes}분, 순수익 (bid ${bidPrice} > breakEven ${Math.ceil(breakEvenPrice)}) → 1분 연장`);
    }
  }

  // 매도 판단 — 모든 매도는 MARKET (bestBid 기준 판단, 즉시 청산)
  let exitReason: 'target' | 'stop_loss' | 'timeout' | 'market_close_auction' | 'no_follow_through_30s';

  if (isTimeout) {
    exitReason = 'timeout';
  } else {
    const exitResult = checkMomentumScalpExit({
      currentPrice,
      targetPrice,
      stopLossPrice,
      bidPrice,
    });

    if (!exitResult.shouldSell || !exitResult.exitReason) {
      // HOLD 결과를 인메모리에 저장 (루프 종료 후 분당 1회 flush)
      sellCheckSnapshots.set(ticker, {
        ticker,
        stockName: stockName || ticker,
        action: 'HOLD' as const,
        entryPrice,
        currentPrice,
        bidPrice,
        targetPrice,
        stopLossPrice,
        profitPct: parseFloat(((bidPrice - entryPrice) / entryPrice * 100).toFixed(2)),
        targetGapPct: parseFloat(((targetPrice - bidPrice) / targetPrice * 100).toFixed(2)),
        stopGapPct: parseFloat(((bidPrice - stopLossPrice) / stopLossPrice * 100).toFixed(2)),
        holdingMin: holdingMinutes,
        timeoutMin: HOLDING_TIMEOUT_MINUTES,
        checkedAt: new Date().toISOString(),
      });
      return accessToken;
    }
    exitReason = exitResult.exitReason;
  }

  console.log(`[QuickScalp-Sell] ${ticker} ${exitReason} 감지 (시장가): bestBid=${bidPrice} 현재가=${currentPrice} 목표=${targetPrice} 손절=${stopLossPrice}`);

  // 매도 실행 로그
  {
    const store = ctx?.store ?? localStore;
    const todayStr = getKSTDateString();
    const profitPct = ((bidPrice - entryPrice) / entryPrice * 100).toFixed(2);
    store.appendLog('scalpSellCheckLogs', todayStr, {
      ticker,
      stockName: stockName || ticker,
      action: exitReason.toUpperCase(),
      entryPrice,
      currentPrice,
      bidPrice,
      targetPrice,
      stopLossPrice,
      profitPct: parseFloat(profitPct),
      holdingMin: holdingMinutes,
      checkedAt: new Date().toISOString(),
    });
  }

  if (shadowMode) {
    // ── 쉐도우 모드: 주문 없이 가상 체결 (bestBid 기준) ──
    const exitPrice = bidPrice;
    const profitRate = ((exitPrice - entryPrice) / entryPrice * 100).toFixed(2);
    const profitAmount = (exitPrice - entryPrice) * entryQuantity;

    // v2.2: MFE30 게이트 결과 계산 (로깅용)
    const tickSizeForLog = getKoreanTickSize(entryPrice);
    const maxBidForLog = entryPrice * (1 + bestProfitPct / 100);
    const mfe30TicksForLog = state.mfe30GateChecked
      ? Math.floor((maxBidForLog - entryPrice) / tickSizeForLog)
      : null;
    const mfe30GateForLog = state.mfe30GateChecked ? 'pass' : 'pending';

    writeShadowTradeLog({
      ticker,
      stockName: stockName || ticker,
      entryPrice,
      entryQuantity,
      exitPrice,
      exitReason,
      allocatedAmount: state.allocatedAmount,
      enteredAt: state.enteredAt,
      entryBoxPos: state.entryBoxPos,
      boxRangePct: state.boxRangePct,
      spreadTicks: state.spreadTicks,
      targetTicks: state.targetTicks,
      bestBidAtExit: bidPrice,
      currentPriceAtExit: currentPrice,
      mfe30Ticks: mfe30TicksForLog,
      mfe30Gate: mfe30GateForLog,
      positiveScore: state.positiveScore,
      positiveScoreDetails: state.positiveScoreDetails,
      bestProfitPct: bestProfitPct,
    }, ctx);

    deleteMomentumScalpState(ticker, ctx?.store);
    console.log(`👻 [QuickScalp-Shadow] ${ticker} 가상 ${exitReason}: ${profitRate}% (${profitAmount.toLocaleString()}원) exit@${exitPrice.toLocaleString()}`);
    return accessToken;
  }

  // ── 실전 모드: 매도 주문 — 최대 3회 재시도 ──
  const accountId = ctx?.accountId ?? config.accountId;
  for (let attempt = 1; attempt <= SELL_API_MAX_RETRIES; attempt++) {
    try {
      const sellResult = await kisClient.submitDomesticOrder(
        appKey, appSecret, accessToken, accountNo,
        {
          ticker,
          side: 'SELL',
          orderType: 'MARKET',
          price: 0,
          quantity: entryQuantity,
        }
      );

      if (sellResult.output?.ODNO) {
        updateMomentumScalpStateToPendingSell(
          ticker,
          sellResult.output.ODNO,
          exitReason,
          bidPrice,
          ctx?.store
        );

        console.log(`[QuickScalp-Sell] ${ticker} 매도 주문: ${sellResult.output.ODNO} (${exitReason}, 시장가) → pending_sell`);

        if (chatId) {
          const emoji = exitReason === 'target' ? '📤' : exitReason === 'timeout' ? '📤⏰' : '📤🔴';
          const reasonLabel = exitReason === 'target' ? `목표 도달 (bestBid ${bidPrice.toLocaleString()} >= ${targetPrice.toLocaleString()})`
            : exitReason === 'timeout' ? `보유시간 초과 (${HOLDING_TIMEOUT_MINUTES}분)`
            : `손절 (bestBid ${bidPrice.toLocaleString()} <= ${stopLossPrice.toLocaleString()})`;
          await sendTelegramMessage(chatId,
            `${emoji} <b>[스캘핑] ${stockName} 매도 주문</b>\n` +
            `${entryQuantity}주 @ 시장가\n` +
            `사유: ${reasonLabel}`,
            'HTML'
          );
        }

        return accessToken;
      }
    } catch (err) {
      console.error(`[QuickScalp-Sell] ${ticker} 매도 주문 실패 (${attempt}/${SELL_API_MAX_RETRIES}):`, err);

      if (isTokenExpiredError(err)) {
        accessToken = await getOrRefreshToken(
          '', accountId,
          { appKey, appSecret },
          kisClient, true
        );
      }

      if (attempt < SELL_API_MAX_RETRIES) {
        await new Promise(resolve => setTimeout(resolve, 500));
      }
    }
  }

  console.log(`[QuickScalp-Sell] ${ticker} 매도 주문 ${SELL_API_MAX_RETRIES}회 실패, active 유지`);
  return accessToken;
}

/**
 * pending_sell 종목 체결 확인 + 타임아웃 처리
 */
async function handlePendingSell(
  state: MomentumScalpState,
  _currentMinute: number,
  kisClient: KisApiClient,
  appKey: string,
  appSecret: string,
  accessToken: string,
  accountNo: string,
  todayStr: string,
  chatId: string | null,
  ctx?: AccountContext
): Promise<string> {
  const { ticker, stockName, sellOrderNo, sellExitReason, entryPrice, entryQuantity, allocatedAmount } = state;

  // 오버나이트 pending_sell 처리
  if (state.updatedAt) {
    const updatedDate = new Date(new Date(state.updatedAt).getTime() + 9 * 60 * 60 * 1000);
    const updatedDateStr = `${updatedDate.getUTCFullYear()}${String(updatedDate.getUTCMonth() + 1).padStart(2, '0')}${String(updatedDate.getUTCDate()).padStart(2, '0')}`;
    if (updatedDateStr !== todayStr) {
      console.log(`[QuickScalp-Sell] ${ticker} 오버나이트 pending_sell → active 복귀`);
      revertMomentumScalpStateToActive(ticker, ctx?.store);
      return accessToken;
    }
  }

  if (!sellOrderNo) {
    console.log(`[QuickScalp-Sell] ${ticker} pending_sell but no sellOrderNo, reverting to active`);
    revertMomentumScalpStateToActive(ticker, ctx?.store);
    return accessToken;
  }

  // 체결 확인
  const sellHistory = await kisClient.getDomesticOrderHistory(
    appKey, appSecret, accessToken, accountNo,
    todayStr, todayStr,
    '01', '01', ticker
  );
  await new Promise(resolve => setTimeout(resolve, 200));

  const filledSell = sellHistory.output1?.find(
    o => o.odno === sellOrderNo && parseInt(o.tot_ccld_qty || '0') > 0
  );

  if (filledSell) {
    const exitPrice = parseInt(filledSell.avg_prvs || '0');
    const exitQuantity = parseInt(filledSell.tot_ccld_qty || '0');

    if (entryPrice && entryQuantity) {
      writeTradeLog({
        ticker,
        stockName: stockName || ticker,
        entryPrice,
        entryQuantity,
        exitPrice,
        exitQuantity,
        exitReason: sellExitReason || 'stop_loss',
        allocatedAmount,
        enteredAt: state.enteredAt,
        entryBoxPos: state.entryBoxPos,
        boxRangePct: state.boxRangePct,
        spreadTicks: state.spreadTicks,
        targetTicks: state.targetTicks,
        bestBidAtExit: state.bestBidAtExit,
      }, ctx);
    }

    deleteMomentumScalpState(ticker, ctx?.store);

    if (chatId && entryPrice && entryQuantity) {
      const profitRate = ((exitPrice - entryPrice) / entryPrice * 100).toFixed(2);
      const profitAmount = (exitPrice - entryPrice) * exitQuantity;

      if (sellExitReason === 'target') {
        await sendTelegramMessage(chatId,
          `✅ <b>[스캘핑] ${stockName} 익절 체결</b>\n` +
          `+${profitRate}% (${profitAmount.toLocaleString()}원)\n` +
          `${entryPrice.toLocaleString()}원 → ${exitPrice.toLocaleString()}원`,
          'HTML'
        );
      } else if (sellExitReason === 'timeout') {
        await sendTelegramMessage(chatId,
          `⏰ <b>[스캘핑] ${stockName} 타임아웃 체결</b>\n` +
          `${profitRate}% (${profitAmount.toLocaleString()}원)\n` +
          `${entryPrice.toLocaleString()}원 → ${exitPrice.toLocaleString()}원`,
          'HTML'
        );
      } else if (sellExitReason === 'market_close_auction') {
        await sendTelegramMessage(chatId,
          `🔔 <b>[스캘핑] ${stockName} 종가 청산 체결</b>\n` +
          `${profitRate}% (${profitAmount.toLocaleString()}원)\n` +
          `${entryPrice.toLocaleString()}원 → ${exitPrice.toLocaleString()}원 (종가)`,
          'HTML'
        );
      } else {
        await sendTelegramMessage(chatId,
          `🔴 <b>[스캘핑] ${stockName} 손절 체결</b>\n` +
          `${profitRate}% (${profitAmount.toLocaleString()}원)\n` +
          `${entryPrice.toLocaleString()}원 → ${exitPrice.toLocaleString()}원`,
          'HTML'
        );
      }
    }

    console.log(`[QuickScalp-Sell] ${ticker} ${sellExitReason} 체결 완료`);
    return accessToken;
  }

  // 미체결 — 타임아웃 체크
  const pendingTimeout = state.updatedAt
    ? new Date(state.updatedAt).getTime() + PENDING_SELL_TIMEOUT_MS
    : 0;
  const nowMs = Date.now();

  if (nowMs > pendingTimeout) {
    // 종가 단일가 매도는 15:30 체결 대기 → 타임아웃으로 취소 금지
    if (sellExitReason === 'market_close_auction') {
      console.log(`[QuickScalp-Sell] ${ticker} 종가 단일가 매도 대기 중 — 취소하지 않음`);
      return accessToken;
    }

    console.log(`[QuickScalp-Sell] ${ticker} pending_sell 타임아웃, 주문 취소 후 active 복귀`);

    try {
      await kisClient.cancelDomesticOrder(
        appKey, appSecret, accessToken, accountNo,
        { orderNo: sellOrderNo, ticker }
      );
    } catch (cancelErr) {
      console.error(`[QuickScalp-Sell] Cancel order failed ${ticker}:`, cancelErr);
    }
    await new Promise(resolve => setTimeout(resolve, 300));

    revertMomentumScalpStateToActive(ticker, ctx?.store);
    console.log(`[QuickScalp-Sell] ${ticker} active로 복귀`);
  }

  return accessToken;
}

// ========================================
// forceStopMomentumScalp
// ========================================

export async function forceStopMomentumScalp(ticker: string, ctx?: AccountContext): Promise<{ success: boolean; message: string }> {
  if (!ticker) {
    return { success: false, message: 'ticker 필수' };
  }

  try {
    const store = ctx?.store ?? localStore;
    const state = getMomentumScalpStateByTicker(ticker, store);
    if (!state) {
      return { success: false, message: `${ticker} 보유 종목이 없습니다` };
    }

    // 쉐도우 모드 확인
    const scalpConfig = store.getStrategyConfig<MomentumScalpConfig>('domestic', 'momentumScalp');
    const isShadow = scalpConfig?.shadowMode === true;

    if (isShadow) {
      // 쉐도우 모드: 실제 주문 없이 상태만 삭제 + 로그
      const todayStr = getKSTDateString();
      if (state.entryPrice && state.entryQuantity) {
        store.appendLog('scalpShadowLogs', todayStr, {
          type: 'FORCE_STOP',
          ticker,
          stockName: state.stockName || ticker,
          market: 'domestic',
          strategy: 'quickScalp',
          entryPrice: state.entryPrice,
          entryQuantity: state.entryQuantity,
          status: state.status,
          reason: 'force_stop_shadow',
          createdAt: new Date().toISOString(),
        });
      }
      deleteMomentumScalpState(ticker, store);
      console.log(`[QuickScalp:ForceStop] [SHADOW] ${ticker} 상태 삭제 (실제 주문 없음)`);
      return { success: true, message: `${ticker} 강제 청산 완료 (쉐도우)` };
    }

    const credentials = ctx
      ? { appKey: ctx.credentials.appKey, appSecret: ctx.credentials.appSecret }
      : { appKey: config.kis.appKey, appSecret: config.kis.appSecret };
    const kisClient = ctx?.kisClient ?? new KisApiClient();
    const accountNo = ctx?.credentials.accountNo ?? config.kis.accountNo;
    const accountId = ctx?.accountId ?? config.accountId;
    const accessToken = await getOrRefreshToken('', accountId, credentials, kisClient);
    const { appKey, appSecret } = credentials;

    if (state.status === 'active' && state.entryQuantity && state.entryQuantity > 0) {
      // 시장가 매도
      const sellResult = await kisClient.submitDomesticOrder(
        appKey, appSecret, accessToken, accountNo,
        { ticker, side: 'SELL', orderType: 'MARKET', price: 0, quantity: state.entryQuantity }
      );

      await new Promise(resolve => setTimeout(resolve, 2000));
      const todayStr = getKSTDateString();
      const sellHistory = await kisClient.getDomesticOrderHistory(
        appKey, appSecret, accessToken, accountNo,
        todayStr, todayStr, '01', '01', ticker
      );

      const filledSell = sellHistory.output1?.find(
        o => o.odno === sellResult.output?.ODNO && parseInt(o.tot_ccld_qty || '0') > 0
      );

      if (filledSell && state.entryPrice) {
        const exitPrice = parseInt(filledSell.avg_prvs || '0');
        const exitQuantity = parseInt(filledSell.tot_ccld_qty || '0');

        writeTradeLog({
          ticker,
          stockName: state.stockName || ticker,
          entryPrice: state.entryPrice,
          entryQuantity: state.entryQuantity,
          exitPrice,
          exitQuantity,
          exitReason: 'stop_loss',
          allocatedAmount: state.allocatedAmount,
          enteredAt: state.enteredAt,
          entryBoxPos: state.entryBoxPos,
          boxRangePct: state.boxRangePct,
          spreadTicks: state.spreadTicks,
          targetTicks: state.targetTicks,
        }, ctx);
      }
    } else if (state.status === 'pending_sell' && state.entryQuantity && state.entryQuantity > 0) {
      // 기존 매도 주문 취소 → 시장가 매도
      if (state.sellOrderNo) {
        try {
          await kisClient.cancelDomesticOrder(
            appKey, appSecret, accessToken, accountNo,
            { orderNo: state.sellOrderNo, ticker }
          );
          await new Promise(resolve => setTimeout(resolve, 1000));
        } catch (cancelErr) {
          console.error(`[QuickScalp:ForceStop] ${ticker} 매도 주문 취소 실패:`, cancelErr);
        }
      }

      const sellResult = await kisClient.submitDomesticOrder(
        appKey, appSecret, accessToken, accountNo,
        { ticker, side: 'SELL', orderType: 'MARKET', price: 0, quantity: state.entryQuantity }
      );

      await new Promise(resolve => setTimeout(resolve, 2000));
      const todayStr2 = getKSTDateString();
      const sellHistory2 = await kisClient.getDomesticOrderHistory(
        appKey, appSecret, accessToken, accountNo,
        todayStr2, todayStr2, '01', '01', ticker
      );

      const filledSell2 = sellHistory2.output1?.find(
        o => o.odno === sellResult.output?.ODNO && parseInt(o.tot_ccld_qty || '0') > 0
      );

      if (filledSell2 && state.entryPrice) {
        const exitPrice = parseInt(filledSell2.avg_prvs || '0');
        const exitQuantity = parseInt(filledSell2.tot_ccld_qty || '0');

        writeTradeLog({
          ticker,
          stockName: state.stockName || ticker,
          entryPrice: state.entryPrice,
          entryQuantity: state.entryQuantity,
          exitPrice,
          exitQuantity,
          exitReason: 'stop_loss',
          allocatedAmount: state.allocatedAmount,
          enteredAt: state.enteredAt,
          entryBoxPos: state.entryBoxPos,
          boxRangePct: state.boxRangePct,
          spreadTicks: state.spreadTicks,
          targetTicks: state.targetTicks,
          bestBidAtExit: state.bestBidAtExit,
        }, ctx);
      }
    } else if (state.status === 'pending_buy' && state.pendingOrderNo) {
      try {
        await kisClient.cancelDomesticOrder(
          appKey, appSecret, accessToken, accountNo,
          { orderNo: state.pendingOrderNo, ticker }
        );
      } catch (cancelErr) {
        console.error(`[QuickScalp:ForceStop] Cancel error:`, cancelErr);
      }
    }

    deleteMomentumScalpState(ticker, store);

    const chatId = await getUserTelegramChatId(config.userId);
    if (chatId) {
      await sendTelegramMessage(chatId,
        `⚠️ <b>[스캘핑] ${state.stockName || ticker} 강제 청산</b>`,
        'HTML'
      );
    }

    return { success: true, message: `${ticker} 강제 청산 완료` };
  } catch (err) {
    console.error('[QuickScalp:ForceStop] Error:', err);
    return {
      success: false,
      message: err instanceof Error ? err.message : String(err),
    };
  }
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

/**
 * 분봉 API 페이지네이션 (10개 1분봉만 필요)
 */
async function fetchPaginatedMinuteBars(
  kisClient: KisApiClient,
  appKey: string,
  appSecret: string,
  accessToken: string,
  ticker: string,
  targetCount: number = 10,
  maxPages: number = 1,
): Promise<MinuteBar[]> {
  const allBars: MinuteBar[] = [];
  let nextHour = formatKSTHour();
  const todayDate = getKSTDateString();

  for (let page = 0; page < maxPages; page++) {
    const resp = await kisClient.getDomesticMinuteBars(
      appKey, appSecret, accessToken, ticker, nextHour
    );
    await new Promise(resolve => setTimeout(resolve, 300));

    const rawBars = resp.output2 || [];
    if (rawBars.length === 0) break;

    const todayBars = rawBars.filter(b => b.stck_bsop_date === todayDate);
    if (todayBars.length === 0) break;

    const parsed = parseDomesticMinuteBars(todayBars);
    allBars.push(...parsed);

    if (allBars.length >= targetCount) break;

    if (todayBars.length < rawBars.length) break;

    const earliest = todayBars[todayBars.length - 1];
    if (!earliest?.stck_cntg_hour) break;
    nextHour = earliest.stck_cntg_hour;
  }

  // 중복 제거 + 시간순 정렬
  const seen = new Set<string>();
  const unique = allBars.filter(bar => {
    const key = `${bar.date}_${bar.time}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  unique.sort((a, b) => {
    const ka = `${a.date}_${a.time}`;
    const kb = `${b.date}_${b.time}`;
    return ka.localeCompare(kb);
  });

  return unique.slice(-targetCount);
}

function parseDomesticMinuteBars(
  output2: Array<{
    stck_bsop_date: string;
    stck_cntg_hour: string;
    stck_prpr: string;
    stck_oprc: string;
    stck_hgpr: string;
    stck_lwpr: string;
    cntg_vol?: string;
    [key: string]: string | undefined;
  }>
): MinuteBar[] {
  return output2
    .map(bar => ({
      time: bar.stck_cntg_hour,
      date: bar.stck_bsop_date,
      open: parseInt(bar.stck_oprc),
      high: parseInt(bar.stck_hgpr),
      low: parseInt(bar.stck_lwpr),
      close: parseInt(bar.stck_prpr),
      volume: bar.cntg_vol ? parseInt(bar.cntg_vol) : undefined,
    }))
    .reverse();
}

async function sendAlert(
  title: string,
  detail: string,
  _ctx?: AccountContext
): Promise<void> {
  try {
    const chatId = await getUserTelegramChatId(config.userId);
    if (chatId) {
      await sendTelegramMessage(
        chatId,
        `⚠️ <b>[스캘핑] ${title}</b>\n\n${detail}`,
        'HTML'
      );
    }
  } catch (err) {
    console.error('[QuickScalp] Alert failed:', err);
  }
}
