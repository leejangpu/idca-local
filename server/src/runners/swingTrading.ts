/**
 * 스윙매매 오케스트레이터 — 로컬 버전
 * 원본: idca-functions/src/functions/swingTrading.ts
 * 변경: Firebase → localStore, 단일 사용자, config.kis.* 자격증명
 *
 * [저장소 정책]
 * - 로컬 JSON: 모든 읽기/쓰기 (config, credentials, state, logs)
 * - Firestore 완전 제거
 */

import { config } from '../config';
import * as localStore from '../lib/localStore';
import { AccountStore } from '../lib/localStore';
import { KisApiClient, DomesticDailyBarResponse, DomesticIndexPriceResponse, DomesticIndexDailyPriceResponse, DomesticHolidayResponse, getOrRefreshToken, isTokenExpiredError } from '../lib/kisApi';
import { getCommonConfig, getMarketStrategyConfig, isMarketStrategyActive, type CommonConfig } from '../lib/configHelper';
import { AccountContext } from '../lib/accountContext';
import { getOccupiedTickersExcluding } from '../lib/activeTickerRegistry';
import { getKoreanTickSize, roundToKoreanTickCeil } from '../lib/marketUtils';
import { sendTelegramMessage, getUserTelegramChatId } from '../lib/telegram';
import {
  SwingConfig,
  SwingTickerConfig,
  SwingState,
  SwingIndicators,
  SwingBuyRecord,
  DailyBar,
  MarketContext,
  calculateSwingIndicators,
  calculateSwingEntry,
  calculateSwingExit,
  calculateSwingAdditionalBuy,
  calculateAvgPrice,
  createInitialSwingState,
  determineCheckInterval,
  updateTrailingStop,
  calculateCandidateRankScore,
  SwingEntryResult,
  determinePositionPhase,
} from '../lib/swingCalculator';

// ==================== 로컬 타입 정의 (old localStore에서 이관) ====================

export interface PendingLimitOrder {
  ticker: string;
  stockName: string;
  limitPrice: number;
  signalDate: string;       // setup 계산일 (전일)
  zoneLabel: string;        // zone2_sweet, zone1b_early 등
  riskMultiplier: number;
  readinessScore: number;
  rankScore: number;
  rrRatio: number;
  premiumATR: number | null;
  riskATR: number | null;
  acceptanceScore: number;
  initialTradeStop: number | null;
  /** 주문 제출 여부 (shadow mode에서는 항상 false) */
  submitted: boolean;
  /** KIS 주문번호 (실제 주문 시) */
  orderNo?: string;
}

export interface ShadowFillLog {
  ticker: string;
  signalDate: string;
  fillDate: string;
  limitPrice: number;
  fillPrice: number;       // 실제 체결가 (low <= limitPrice → limitPrice, gap-down → open)
  fillType: 'limit_hit' | 'gap_down' | 'not_filled';
  closeAtFillDay: number;  // 체결일 종가 (미체결 시 해당일 종가)
}

export interface SwingShadowTradeLog {
  timestamp: string;           // ISO timestamp
  action: 'BUY' | 'SELL' | 'ADDITIONAL_BUY' | 'PARTIAL_SELL';
  ticker: string;
  stockName: string;
  price: number;               // 매수/매도 기준가
  quantity: number;
  amount: number;              // price × quantity
  // 진입 정보 (BUY)
  orderType?: string;          // LIMIT, MARKET, etc.
  rankScore?: number;
  readinessScore?: number;
  pullbackState?: string;
  trendScore?: number;
  pullbackScore?: number;
  supportScore?: number;
  triggerScore?: number;
  rrRatio?: number;
  // 청산 정보 (SELL)
  sellReason?: string;
  sellDetail?: string;
  profitRate?: number;         // 수익률 %
  profit?: number;             // 예상 수익금
  holdingDays?: number;
  highestPrice?: number;
  positionPhase?: string;
  // 추가매수 정보 (ADDITIONAL_BUY)
  addBuyReason?: string;
  avgPriceAfter?: number;      // 추가매수 후 평단가
  totalQuantityAfter?: number;
  // 지표
  currentPrice: number;
  indicators?: {
    ema5: number | null;
    ema20: number | null;
    ema60: number | null;
    rsi14: number | null;
    atr14: number | null;
    macdHist: number | null;
  };
  // 포지션 상태
  totalInvested?: number;
  totalQuantity?: number;
  avgPrice?: number;
}

export interface UniverseScanLog {
  date: string;                    // YYYYMMDD
  scannedAt: string;               // ISO timestamp
  universeSize: number;            // 스캔 대상 종목 수
  candidateCount: number;          // shouldBuy 후보 수
  pendingCount: number;            // 최종 pending order 수
  holdingCount: number;            // 현재 보유 종목 수
  universe: UniverseTickerLog[];   // 전체 유니버스 종목 상세
  candidates: CandidateLog[];      // shouldBuy=true 후보 상세 (rankScore 정렬)
  pendingOrders: PendingOrderLog[];// 최종 pending 종목
}

export interface UniverseTickerLog {
  ticker: string;
  stockName: string;
  source: 'manual' | 'auto';      // 수동 등록 vs 자동 스크리닝
  readinessScore?: number;
  pullbackState?: string;
  skipReason?: string;             // 스캔 스킵 사유 (보유중, 데이터부족 등)
}

export interface CandidateLog {
  ticker: string;
  stockName: string;
  rankScore: number;
  readinessScore: number;
  zoneLabel: string;
  limitPrice: number;
  rrRatio: number;
  premiumATR: number | null;
  selected: boolean;               // pending에 포함되었는지
  rejectReason?: string;           // 미선택 사유 (슬롯 부족 등)
}

export interface PendingOrderLog {
  ticker: string;
  stockName: string;
  limitPrice: number;
  zoneLabel: string;
  rankScore: number;
}

// ==================== localStore 래퍼 ====================

function getStore(store?: AccountStore): AccountStore {
  return store ?? localStore as unknown as AccountStore;
}

function getAllSwingStates<T>(store?: AccountStore): Map<string, T> {
  return getStore(store).getAllStates<T>('swingState');
}

function setSwingState(ticker: string, data: unknown, store?: AccountStore): void {
  getStore(store).setState('swingState', ticker, data);
}

function updateSwingState(ticker: string, data: Record<string, unknown>, store?: AccountStore): void {
  getStore(store).updateState('swingState', ticker, data);
}

function deleteSwingState(ticker: string, store?: AccountStore): void {
  getStore(store).deleteState('swingState', ticker);
}

function addSwingCycleHistory(data: Record<string, unknown>, store?: AccountStore): string {
  return getStore(store).addCycleHistory(data);
}

function getPendingOrders(store?: AccountStore): PendingLimitOrder[] {
  const all = getStore(store).getAllStates<PendingLimitOrder>('swingPendingOrders');
  return Array.from(all.values());
}

function setPendingOrders(orders: PendingLimitOrder[], store?: AccountStore): void {
  // Clear existing
  clearPendingOrders(store);
  // Write each order as a separate state file
  for (let i = 0; i < orders.length; i++) {
    const key = `${orders[i].ticker}_${orders[i].signalDate}`;
    getStore(store).setState('swingPendingOrders', key, orders[i]);
  }
}

function clearPendingOrders(store?: AccountStore): void {
  const s = getStore(store);
  const existing = s.getAllStates<PendingLimitOrder>('swingPendingOrders');
  for (const key of existing.keys()) {
    s.deleteState('swingPendingOrders', key);
  }
}

function appendShadowLog(date: string, log: ShadowFillLog, store?: AccountStore): void {
  getStore(store).appendLog<ShadowFillLog>('swingShadowLogs', date, log);
}

function appendScanLog(log: UniverseScanLog, store?: AccountStore): void {
  getStore(store).appendLog<UniverseScanLog>('swingScanLogs', log.date, log);
}

function appendShadowTradeLog(log: SwingShadowTradeLog, store?: AccountStore): void {
  const dateKey = getTodayKST();
  getStore(store).appendLog<SwingShadowTradeLog>('swingShadowTrades', dateKey, log);
}

// ==================== 캐시 ====================

// 일봉 캐시: ticker → { bars, fetchedDate }
const dailyBarCache: Map<string, { bars: DailyBar[]; fetchedDate: string }> = new Map();

// 시장 지수 캐시 (5분 TTL)
let marketContextCache: { context: MarketContext; fetchedAt: number } | null = null;
const MARKET_CONTEXT_TTL_MS = 5 * 60 * 1000;

// 휴장일 캐시 (1일 1회)
let holidayCache: { isOpen: boolean; date: string } | null = null;

function getTodayKST(): string {
  const now = new Date();
  const kst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  return kst.toISOString().slice(0, 10).replace(/-/g, '');
}

function getKSTTimeString(): string {
  const now = new Date();
  const kst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  const h = String(kst.getUTCHours()).padStart(2, '0');
  const m = String(kst.getUTCMinutes()).padStart(2, '0');
  const s = String(kst.getUTCSeconds()).padStart(2, '0');
  return `${h}:${m}:${s}`;
}

/**
 * 장마감 30분 전 이후인지 판단 (15:00 이후)
 * ENTRY_SIGNAL 확정 및 실제 매수는 이 시간 이후에만 허용
 */
function isNearMarketClose(): boolean {
  const now = new Date();
  const kst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  const hour = kst.getUTCHours();
  const minute = kst.getUTCMinutes();
  return hour > 15 || (hour === 15 && minute >= 0);
}

function getKSTMinute(): number {
  const now = new Date();
  const kst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  return kst.getUTCHours() * 60 + kst.getUTCMinutes();
}

// ==================== 일봉 조회 + 지표 계산 ====================

/**
 * KIS 일봉 조회 → DailyBar 배열 변환
 * 120거래일(약 6개월) 조회, 하루 1회 캐시
 */
async function fetchDailyBars(
  kisClient: KisApiClient,
  appKey: string,
  appSecret: string,
  accessToken: string,
  ticker: string,
): Promise<DailyBar[]> {
  const today = getTodayKST();
  const cached = dailyBarCache.get(ticker);
  if (cached && cached.fetchedDate === today) {
    return cached.bars;
  }

  // 120거래일 전 날짜 계산 (약 170일 전)
  const startDate = new Date();
  startDate.setDate(startDate.getDate() - 170);
  const startStr = startDate.toISOString().slice(0, 10).replace(/-/g, '');

  const response: DomesticDailyBarResponse = await kisClient.getDomesticDailyBars(
    appKey, appSecret, accessToken, ticker, startStr, today,
  );

  if (!response.output2 || response.output2.length === 0) {
    console.warn(`[Swing] ${ticker} 일봉 데이터 없음`);
    return cached?.bars || [];
  }

  // KIS는 최신순 → 오래된순으로 뒤집기
  const bars: DailyBar[] = response.output2
    .filter(bar => bar.stck_clpr && Number(bar.stck_clpr) > 0)
    .map(bar => ({
      date: bar.stck_bsop_date,
      open: Number(bar.stck_oprc),
      high: Number(bar.stck_hgpr),
      low: Number(bar.stck_lwpr),
      close: Number(bar.stck_clpr),
      volume: Number(bar.acml_vol),
    }))
    .reverse();

  dailyBarCache.set(ticker, { bars, fetchedDate: today });
  console.log(`[Swing] ${ticker} 일봉 ${bars.length}건 조회 (${bars[0]?.date}~${bars[bars.length - 1]?.date})`);

  return bars;
}

// ==================== 시장 지수 조회 ====================

/**
 * 코스피 현재지수 + 20일 이격도 조회 (5분 캐시)
 */
async function fetchMarketContext(
  kisClient: KisApiClient,
  appKey: string,
  appSecret: string,
  accessToken: string,
): Promise<MarketContext | undefined> {
  // 5분 캐시 확인
  if (marketContextCache && Date.now() - marketContextCache.fetchedAt < MARKET_CONTEXT_TTL_MS) {
    return marketContextCache.context;
  }

  try {
    // 코스피 현재지수 조회
    const indexRes: DomesticIndexPriceResponse = await kisClient.getDomesticIndexPrice(
      appKey, appSecret, accessToken, '0001',
    );

    if (indexRes.rt_cd !== '0' || !indexRes.output) return undefined;

    const context: MarketContext = {
      indexPrice: Number(indexRes.output.bstp_nmix_prpr),
      changeRate: Number(indexRes.output.bstp_nmix_prdy_ctrt),
      d20Disparity: null,
      advancingCount: Number(indexRes.output.ascn_issu_cnt || 0),
      decliningCount: Number(indexRes.output.down_issu_cnt || 0),
    };

    // 20일 이격도 조회 (일자별 지수에서 가장 최근 d20_dsrt)
    try {
      const startDate = new Date();
      startDate.setDate(startDate.getDate() - 5);
      const startStr = startDate.toISOString().slice(0, 10).replace(/-/g, '');
      const dailyRes: DomesticIndexDailyPriceResponse = await kisClient.getDomesticIndexDailyPrice(
        appKey, appSecret, accessToken, '0001', startStr,
      );
      if (dailyRes.rt_cd === '0' && dailyRes.output2 && dailyRes.output2.length > 0) {
        const latestD20 = dailyRes.output2[0].d20_dsrt;
        if (latestD20) {
          context.d20Disparity = Number(latestD20);
        }
      }
    } catch {
      // 이격도 조회 실패 시 무시 (현재지수만 사용)
    }

    marketContextCache = { context, fetchedAt: Date.now() };
    console.log(`[Swing] 시장 현황: KOSPI ${context.indexPrice} (${context.changeRate > 0 ? '+' : ''}${context.changeRate}%), 이격도 ${context.d20Disparity ?? 'N/A'}, 상승 ${context.advancingCount} / 하락 ${context.decliningCount}`);
    return context;
  } catch (err) {
    console.warn(`[Swing] 시장 지수 조회 실패:`, (err as Error).message);
    return marketContextCache?.context; // 이전 캐시 반환
  }
}

// ==================== 휴장일 조회 ====================

/**
 * 오늘 개장일 여부 (1일 1회 조회, 캐시)
 */
async function isMarketOpen(
  kisClient: KisApiClient,
  appKey: string,
  appSecret: string,
  accessToken: string,
): Promise<boolean> {
  const today = getTodayKST();

  if (holidayCache && holidayCache.date === today) {
    return holidayCache.isOpen;
  }

  try {
    const res: DomesticHolidayResponse = await kisClient.getDomesticHolidays(
      appKey, appSecret, accessToken, today,
    );

    if (res.rt_cd === '0' && res.output && res.output.length > 0) {
      const todayEntry = res.output.find(e => e.bass_dt === today);
      const isOpen = todayEntry?.opnd_yn === 'Y';
      holidayCache = { isOpen, date: today };
      if (!isOpen) {
        console.log(`[Swing] ${today} 휴장일 (opnd_yn=${todayEntry?.opnd_yn})`);
      }
      return isOpen;
    }
  } catch (err) {
    console.warn(`[Swing] 휴장일 조회 실패:`, (err as Error).message);
  }

  // 조회 실패 시 주말 체크만
  const kst = new Date(Date.now() + 9 * 60 * 60 * 1000);
  const day = kst.getUTCDay();
  return day !== 0 && day !== 6;
}

// ==================== 텔레그램 알림 ====================

async function sendSwingNotification(
  message: string,
): Promise<void> {
  try {
    const chatId = await getUserTelegramChatId();
    if (chatId) {
      await sendTelegramMessage(chatId, message);
    }
  } catch {
    // 알림 실패는 무시
  }
}

// ==================== 메인 루프 ====================

/**
 * 스윙매매 메인 루프 (60초마다 호출)
 * @returns 처리된 종목 수
 */
export async function runSwingTradingLoop(ctx?: AccountContext): Promise<number> {
  const accountId = ctx?.accountId ?? config.accountId;

  try {
    const processed = await processSwingAccount(ctx);
    return processed;
  } catch (err) {
    console.error(`[Swing] ${accountId} 에러:`, (err as Error).message);
    return 0;
  }
}

/**
 * 계좌별 스윙매매 처리
 */
async function processSwingAccount(ctx?: AccountContext): Promise<number> {
  const store = ctx?.store;

  // 1. CommonConfig 확인 — swingEnabled 체크
  const commonConfig = ctx
    ? ctx.store.getTradingConfig<CommonConfig>()
    : getCommonConfig();
  if (!commonConfig || !isMarketStrategyActive(commonConfig, 'domestic', 'swing')) {
    return 0;
  }

  // 2. 스윙 config 읽기
  const swingConfig = ctx
    ? ctx.store.getStrategyConfig<SwingConfig>('domestic', 'swing')
    : getMarketStrategyConfig<SwingConfig>('domestic', 'swing');
  if (!swingConfig || swingConfig.tickers.length === 0) {
    return 0;
  }

  const shadowMode = swingConfig.shadowMode !== false;

  // 3. KIS 인증 (config에서 자격증명 읽기)
  const credentials = ctx
    ? { appKey: ctx.credentials.appKey, appSecret: ctx.credentials.appSecret, accountNo: ctx.credentials.accountNo }
    : { appKey: config.kis.appKey, appSecret: config.kis.appSecret, accountNo: config.kis.accountNo };

  const kisClient = ctx?.kisClient ?? new KisApiClient();
  const accountId = ctx?.accountId ?? config.accountId;
  let accessToken = await getOrRefreshToken('', accountId, credentials, kisClient);

  // 3-1. 휴장일 체크
  const marketOpen = await isMarketOpen(kisClient, credentials.appKey, credentials.appSecret, accessToken);
  if (!marketOpen) {
    return 0;
  }

  // 3-2. 시장 컨텍스트 조회 (KOSPI 지수)
  const marketContext = await fetchMarketContext(kisClient, credentials.appKey, credentials.appSecret, accessToken) || undefined;

  // 4. 로컬 파일에서 현재 상태 전체 조회
  const stateMap = getAllSwingStates<SwingState>(store);

  // 5. 보유 종목 수 계산 (holding/trailing)
  const holdingCount = Array.from(stateMap.values())
    .filter(s => s.status === 'holding' || s.status === 'trailing')
    .length;

  // 5-1. 오늘 이미 신규 진입한 수 체크 (일일 진입 제한: 최대 2개)
  const todayStr = getTodayKST();
  const MAX_DAILY_ENTRIES = 2;
  let todayEntries = 0;
  for (const s of stateMap.values()) {
    if (s.status === 'holding' && s.entryDate && s.entryDate.slice(0, 10).replace(/-/g, '') === todayStr) {
      todayEntries++;
    }
  }

  // 6. 종목 순회 — 2-pass 구조 (스캔 → 랭킹 → 실행)
  const currentMinute = getKSTMinute();
  let processed = 0;

  // 종목별 상태/설정 준비
  interface TickerContext {
    tickerConfig: SwingTickerConfig;
    state: SwingState;
  }
  const tickerContexts: TickerContext[] = [];

  for (const tickerConfig of swingConfig.tickers) {
    const { ticker } = tickerConfig;

    let state = stateMap.get(ticker) || null;
    if (!state) {
      const cycleNumber = 1;
      state = createInitialSwingState(tickerConfig, swingConfig, cycleNumber);
      setSwingState(ticker, state, store);
      console.log(`[Swing] ${ticker} (${tickerConfig.stockName}) 감시 시작`);
    }
    if (state.status === 'completed') continue;
    if (currentMinute % state.checkInterval !== 0) continue;
    tickerContexts.push({ tickerConfig, state });
  }

  // === PASS 1: 보유 종목(holding/trailing) 먼저 처리 (랭킹 불필요) ===
  const holdingTickers = tickerContexts.filter(c => c.state.status === 'holding' || c.state.status === 'trailing');
  const watchingTickers = tickerContexts.filter(c => c.state.status === 'watching' || c.state.status === 'ready');

  for (let i = 0; i < holdingTickers.length; i++) {
    if (i > 0) await new Promise(resolve => setTimeout(resolve, 300));
    const { tickerConfig, state } = holdingTickers[i];
    try {
      await processSwingTicker(
        kisClient, credentials.appKey, credentials.appSecret, accessToken, credentials.accountNo,
        accountId, tickerConfig, state, swingConfig, holdingCount, marketContext, shadowMode, store,
      );
      processed++;
    } catch (err) {
      console.error(`[Swing] ${tickerConfig.ticker} 처리 에러:`, (err as Error).message);
    }
  }

  // === PASS 2: 감시 종목 스캔 → 랭킹 → 상위부터 실행 ===
  interface ScanResult {
    tickerConfig: SwingTickerConfig;
    state: SwingState;
    entryResult: SwingEntryResult;
    rankScore: number;
    dailyBars: DailyBar[];
    currentPrice: number;
    indicators: SwingIndicators;
  }
  const scanResults: ScanResult[] = [];

  for (let i = 0; i < watchingTickers.length; i++) {
    if (i > 0) await new Promise(resolve => setTimeout(resolve, 300));
    const { tickerConfig, state } = watchingTickers[i];
    const { ticker } = tickerConfig;

    try {
      // 일봉 + 현재가 조회
      const dailyBars = await fetchDailyBars(kisClient, credentials.appKey, credentials.appSecret, accessToken, ticker);
      if (dailyBars.length < 60) continue;

      const quoteRes = await kisClient.getDomesticCurrentPrice(credentials.appKey, credentials.appSecret, accessToken, ticker);
      const currentPrice = Number(quoteRes.output?.stck_prpr || 0);
      if (currentPrice <= 0) continue;

      const dailyIndicators = calculateSwingIndicators(dailyBars, currentPrice);
      const tradingValue = quoteRes.output?.acml_tr_pbmn ? Number(quoteRes.output.acml_tr_pbmn) : null;
      const indicators: SwingIndicators = { ...dailyIndicators, ema20_5m: null, rsi14_5m: null, tradingValue };

      // 진입 판단
      const nearClose = isNearMarketClose();
      const entryResult = calculateSwingEntry(
        state, indicators, dailyBars, tickerConfig, holdingCount, swingConfig.maxPositions,
        marketContext, nearClose,
      );

      // 랭킹 점수 계산
      const rankScore = calculateCandidateRankScore(entryResult);

      scanResults.push({ tickerConfig, state, entryResult, rankScore, dailyBars, currentPrice, indicators });
      processed++;
    } catch (err) {
      console.error(`[Swing] ${ticker} 스캔 에러:`, (err as Error).message);
    }
  }

  // 랭킹 정렬 (높은 순)
  scanResults.sort((a, b) => b.rankScore - a.rankScore);

  // 랭킹 로그
  const buyableCandidates = scanResults.filter(r => r.entryResult.shouldBuy);
  if (buyableCandidates.length > 1) {
    console.log(`[Swing] 매수 후보 ${buyableCandidates.length}개 랭킹: ${buyableCandidates.map(r =>
      `${r.tickerConfig.ticker}(${r.rankScore}점,rr=${r.entryResult.executionGate?.rrRatio.toFixed(1)})`).join(' > ')}`);
  }

  // 랭킹 순서대로 상태 업데이트 + 매수 실행
  for (const scan of scanResults) {
    const { tickerConfig, state, entryResult, currentPrice, indicators } = scan;
    const { ticker, stockName } = tickerConfig;

    // 상태 업데이트 (항상 수행)
    const update: Partial<SwingState> = {
      indicators,
      readinessScore: entryResult.readinessScore,
      pullbackState: entryResult.pullbackState,
    };
    if (entryResult.activeSwing) update.activeSwing = entryResult.activeSwing;

    // 구조화 로그
    if (entryResult.readinessScore >= 40 || entryResult.pullbackState === 'ENTRY_SIGNAL') {
      console.log(`[Swing] ${ticker} (${stockName}) score=${entryResult.readinessScore} state=${entryResult.pullbackState}` +
        ` trend=${entryResult.trendScore} pb=${entryResult.pullbackScore} sup=${entryResult.supportScore} trig=${entryResult.triggerScore}` +
        (entryResult.executionGate ? ` rr=${entryResult.executionGate.rrRatio.toFixed(1)} exec=${entryResult.executionGate.executable}` : '') +
        (entryResult.executionGate && !entryResult.executionGate.executable ? ` blocked=[${entryResult.executionGate.blockReasons.join(',')}]` : '') +
        (scan.rankScore > 0 ? ` rank=${scan.rankScore}` : ''));
    }

    // 상태 전이
    const transition = determineCheckInterval(
      { ...state, status: state.status }, entryResult.readinessScore, entryResult.pullbackState,
    );
    update.status = transition.newStatus;
    update.checkInterval = transition.checkInterval;

    // 매수 실행 (랭킹 순, 일일 한도까지, entryPlan 반영)
    const plan = entryResult.entryPlan;
    if (entryResult.shouldBuy && entryResult.suggestedQuantity && entryResult.suggestedQuantity > 0 && plan && plan.orderType !== 'SKIP') {
      if (todayEntries >= MAX_DAILY_ENTRIES) {
        console.log(`[Swing] ${ticker} (${stockName}) 매수 보류 (일일 진입 ${todayEntries}/${MAX_DAILY_ENTRIES})`);
      } else {
        // entryPlan에 따른 진입가 결정
        const buyPrice = plan.orderType === 'LIMIT' && plan.limitPrice
          ? plan.limitPrice
          : currentPrice + getKoreanTickSize(currentPrice);
        const quantity = entryResult.suggestedQuantity;

        console.log(`[Swing] ${shadowMode ? '[SHADOW] ' : ''}${ticker} (${stockName}) 매수 신호: ${plan.orderType} ${buyPrice}원 (랭킹 ${scan.rankScore}점)`);

        if (shadowMode) {
          // 쉐도우 모드: 실제 주문 없이 파일 로그
          console.log(`[Swing] [SHADOW] ${ticker} 가상 매수: ${quantity}주 × ${buyPrice}원`);
          appendShadowTradeLog({
            timestamp: new Date().toISOString(),
            action: 'BUY',
            ticker,
            stockName,
            price: buyPrice,
            quantity,
            amount: buyPrice * quantity,
            orderType: plan.orderType,
            rankScore: scan.rankScore,
            readinessScore: entryResult.readinessScore,
            pullbackState: entryResult.pullbackState,
            trendScore: entryResult.trendScore,
            pullbackScore: entryResult.pullbackScore,
            supportScore: entryResult.supportScore,
            triggerScore: entryResult.triggerScore,
            rrRatio: entryResult.executionGate?.rrRatio,
            currentPrice,
            indicators: {
              ema5: indicators.ema5, ema20: indicators.ema20, ema60: indicators.ema60,
              rsi14: indicators.rsi14, atr14: indicators.atr14,
              macdHist: indicators.macdHist,
            },
          }, store);
          todayEntries++;
        } else {
          try {
            const orderRes = await kisClient.submitDomesticOrder(
              credentials.appKey, credentials.appSecret, accessToken, credentials.accountNo,
              { ticker, side: 'BUY', orderType: 'LIMIT', price: buyPrice, quantity },
            );

            if (orderRes.rt_cd === '0') {
              const buyRecord: SwingBuyRecord = {
                price: buyPrice, quantity, amount: buyPrice * quantity,
                date: new Date().toISOString(), reason: 'initial',
                orderNo: orderRes.output?.ODNO || '',
              };
              const { avgPrice, totalQuantity, totalInvested } = calculateAvgPrice([buyRecord]);
              update.status = 'holding';
              update.checkInterval = 5;
              update.buyRecords = [buyRecord];
              update.avgPrice = avgPrice;
              update.totalQuantity = totalQuantity;
              update.totalInvested = totalInvested;
              update.entryDate = new Date().toISOString();
              update.holdingDays = 0;
              update.highestPrice = currentPrice;
              (update as Record<string, unknown>).positionPhase = 'INIT_RISK';
              if (entryResult.swingContext?.initialTradeStop != null) {
                (update as Record<string, unknown>).initialTradeStop = entryResult.swingContext.initialTradeStop;
              }
              todayEntries++;
              console.log(`[Swing] ${ticker} 매수 주문 성공: ${quantity}주 × ${buyPrice}원 (${plan.orderType})`);
              await sendSwingNotification(`[스윙 매수] ${stockName}(${ticker})\n${quantity}주 × ${buyPrice.toLocaleString()}원 (${plan.orderType})\nR:R=${entryResult.executionGate?.rrRatio.toFixed(1) ?? 'N/A'}\n랭킹=${scan.rankScore}점`);
            } else {
              console.error(`[Swing] ${ticker} 매수 주문 실패: ${orderRes.msg1}`);
            }
          } catch (err) {
            if (isTokenExpiredError(err)) {
              accessToken = await getOrRefreshToken('', accountId, credentials, kisClient, true);
              try {
                const retryRes = await kisClient.submitDomesticOrder(
                  credentials.appKey, credentials.appSecret, accessToken, credentials.accountNo,
                  { ticker, side: 'BUY', orderType: 'LIMIT', price: buyPrice, quantity },
                );
                if (retryRes.rt_cd === '0') {
                  const buyRecord: SwingBuyRecord = {
                    price: buyPrice, quantity, amount: buyPrice * quantity,
                    date: new Date().toISOString(), reason: 'initial',
                    orderNo: retryRes.output?.ODNO || '',
                  };
                  const { avgPrice, totalQuantity, totalInvested } = calculateAvgPrice([buyRecord]);
                  update.status = 'holding';
                  update.checkInterval = 5;
                  update.buyRecords = [buyRecord];
                  update.avgPrice = avgPrice;
                  update.totalQuantity = totalQuantity;
                  update.totalInvested = totalInvested;
                  update.entryDate = new Date().toISOString();
                  update.holdingDays = 0;
                  update.highestPrice = currentPrice;
                  (update as Record<string, unknown>).positionPhase = 'INIT_RISK';
                  todayEntries++;
                  console.log(`[Swing] ${ticker} 매수 주문 성공 (토큰 재발급 후): ${quantity}주 × ${buyPrice}원`);
                  await sendSwingNotification(`[스윙 매수] ${stockName}(${ticker})\n${quantity}주 × ${buyPrice.toLocaleString()}원 (토큰 재발급)`);
                } else {
                  console.error(`[Swing] ${ticker} 매수 재시도 실패: ${retryRes.msg1}`);
                }
              } catch (retryErr) {
                console.error(`[Swing] ${ticker} 매수 재시도 에러:`, (retryErr as Error).message);
              }
            } else {
              console.error(`[Swing] ${ticker} 매수 주문 에러:`, (err as Error).message);
            }
          }
        }
      }
    } else if (plan?.orderType === 'SKIP') {
      console.log(`[Swing] ${ticker} (${stockName}) 진입 SKIP: ${plan.skipReason} (score=${entryResult.readinessScore})`);
    } else if (state.status !== transition.newStatus) {
      console.log(`[Swing] ${ticker} 상태 전이: ${state.status} → ${transition.newStatus} (T${entryResult.trendScore}/P${entryResult.pullbackScore}/S${entryResult.supportScore}/G${entryResult.triggerScore}=${entryResult.readinessScore}, ${entryResult.pullbackState})`);
    }

    updateSwingState(ticker, update as Record<string, unknown>, store);
  }

  return processed;
}

// ==================== 종목별 처리 ====================

/**
 * 보유 종목 처리 (holding/trailing만)
 * watching/ready는 2-pass 스캔에서 직접 처리
 */
async function processSwingTicker(
  kisClient: KisApiClient,
  appKey: string,
  appSecret: string,
  initialAccessToken: string,
  accountNo: string,
  accountId: string,
  tickerConfig: SwingTickerConfig,
  state: SwingState,
  swingConfig: SwingConfig,
  holdingCount: number,
  marketContext?: MarketContext,
  shadowMode: boolean = false,
  store?: AccountStore,
): Promise<void> {
  let accessToken = initialAccessToken;
  const { ticker, stockName } = tickerConfig;

  // 1. 일봉 데이터 + 지표 계산
  const dailyBars = await fetchDailyBars(kisClient, appKey, appSecret, accessToken, ticker);
  if (dailyBars.length < 60) {
    console.warn(`[Swing] ${ticker} 일봉 부족 (${dailyBars.length}건, 최소 60건 필요)`);
    return;
  }

  // 현재가 조회
  const quoteRes = await kisClient.getDomesticCurrentPrice(appKey, appSecret, accessToken, ticker);
  const currentPrice = Number(quoteRes.output?.stck_prpr || 0);
  if (currentPrice <= 0) return;

  // 지표 계산
  const dailyIndicators = calculateSwingIndicators(dailyBars, currentPrice);
  const tradingValue = quoteRes.output?.acml_tr_pbmn ? Number(quoteRes.output.acml_tr_pbmn) : null;
  const indicators: SwingIndicators = {
    ...dailyIndicators,
    ema20_5m: null,
    rsi14_5m: null,
    tradingValue,
  };

  // 2. 상태별 처리
  const update: Partial<SwingState> = { indicators };

  switch (state.status) {
    case 'holding':
    case 'trailing': {
      // 보유일 수 갱신
      const entryDate = state.entryDate ? new Date(state.entryDate) : new Date();
      const holdingDays = Math.floor((Date.now() - entryDate.getTime()) / (24 * 60 * 60 * 1000));
      update.holdingDays = holdingDays;

      // 트레일링 스탑 업데이트
      const trailing = updateTrailingStop(state, currentPrice, swingConfig.trailingStopEnabled);
      update.highestPrice = trailing.highestPrice;
      update.trailingStopActivated = trailing.trailingStopActivated;
      update.trailingStopPrice = trailing.trailingStopPrice;

      if (trailing.trailingStopActivated && state.status === 'holding') {
        update.status = 'trailing';
        console.log(`[Swing] ${ticker} 트레일링 스탑 활성화 (고점 ${trailing.highestPrice}, 스탑 ${Math.round(trailing.trailingStopPrice)})`);
      }

      // 포지션 phase 업데이트
      const stateForExit = { ...state, holdingDays, highestPrice: trailing.highestPrice, trailingStopActivated: trailing.trailingStopActivated };
      const currentPhase = determinePositionPhase(stateForExit, indicators);
      if (currentPhase !== state.positionPhase) {
        update.positionPhase = currentPhase;
        console.log(`[Swing] ${ticker} phase 전이: ${state.positionPhase} → ${currentPhase}`);
      }

      // 청산 판단
      const exitResult = calculateSwingExit(
        { ...stateForExit, positionPhase: currentPhase },
        indicators,
        swingConfig.trailingStopEnabled,
        swingConfig.maxHoldingDays,
      );

      if (exitResult.shouldSell) {
        console.log(`[Swing] ${shadowMode ? '[SHADOW] ' : ''}${ticker} (${stockName}) 매도 신호: ${exitResult.detail}`);

        const sellQty = exitResult.sellQuantity || state.totalQuantity;

        if (shadowMode) {
          const sellAmount = currentPrice * sellQty;
          const profit = sellAmount - state.totalInvested;
          const profitRate = state.totalInvested > 0 ? (profit / state.totalInvested * 100) : 0;
          console.log(`[Swing] [SHADOW] ${ticker} 가상 매도: ${sellQty}주 (사유: ${exitResult.reason}, 수익률: ${profitRate.toFixed(2)}%)`);
          appendShadowTradeLog({
            timestamp: new Date().toISOString(),
            action: exitResult.isPartialExit ? 'PARTIAL_SELL' : 'SELL',
            ticker,
            stockName,
            price: currentPrice,
            quantity: sellQty,
            amount: sellAmount,
            sellReason: exitResult.reason,
            sellDetail: exitResult.detail,
            profitRate: Number(profitRate.toFixed(2)),
            profit: Math.round(profit),
            holdingDays: update.holdingDays,
            highestPrice: trailing.highestPrice,
            positionPhase: currentPhase,
            currentPrice,
            totalInvested: state.totalInvested,
            totalQuantity: state.totalQuantity,
            avgPrice: state.avgPrice,
            indicators: {
              ema5: indicators.ema5, ema20: indicators.ema20, ema60: indicators.ema60,
              rsi14: indicators.rsi14, atr14: indicators.atr14,
              macdHist: indicators.macdHist,
            },
          }, store);
          updateSwingState(ticker, update as Record<string, unknown>, store);
          return;
        }

        try {
          const sellPrice = exitResult.orderType === 'LIMIT' && exitResult.suggestedPrice
            ? roundToKoreanTickCeil(exitResult.suggestedPrice)
            : 0;

          const orderRes = await kisClient.submitDomesticOrder(
            appKey, appSecret, accessToken, accountNo,
            {
              ticker,
              side: 'SELL',
              orderType: exitResult.orderType,
              price: sellPrice,
              quantity: sellQty,
            },
          );

          if (orderRes.rt_cd === '0') {
            if (exitResult.isPartialExit) {
              // === 부분익절: 수량/투자금 조정, 상태 유지 ===
              const remainingQty = state.totalQuantity - sellQty;
              const remainingInvested = state.totalInvested * (remainingQty / state.totalQuantity);

              update.totalQuantity = remainingQty;
              update.totalInvested = remainingInvested;
              update.avgPrice = remainingQty > 0 ? remainingInvested / remainingQty : state.avgPrice;
              update.partialExitDone = true;

              console.log(`[Swing] ${ticker} 부분익절: ${sellQty}주 매도 (잔여 ${remainingQty}주)`);
              await sendSwingNotification(
                `[스윙 부분익절] ${stockName}(${ticker})\n${sellQty}주 × ~${currentPrice.toLocaleString()}원\n` +
                `잔여: ${remainingQty}주\n사유: ${exitResult.detail}`,
              );
            } else {
              // === 전량매도: cycleHistory 기록 + state 삭제 ===
              const sellAmount = currentPrice * sellQty;
              const profit = sellAmount - state.totalInvested;
              const profitRate = state.totalInvested > 0 ? (profit / state.totalInvested * 100).toFixed(2) : '0';

              addSwingCycleHistory({
                strategy: 'swing',
                market: 'domestic',
                ticker,
                stockName,
                entryStrategy: state.entryStrategy,
                cycleNumber: state.cycleNumber,
                buyRecords: state.buyRecords,
                totalBuyAmount: state.totalInvested,
                avgPrice: state.avgPrice,
                totalQuantity: state.totalQuantity,
                sellPrice: currentPrice,
                sellAmount,
                sellDate: new Date().toISOString(),
                sellReason: exitResult.reason,
                totalRealizedProfit: profit,
                profitRate: Number(profitRate),
                holdingDays,
                highestPrice: trailing.highestPrice,
                configSnapshot: state.config,
                startedAt: state.entryDate,
              }, store);

              deleteSwingState(ticker, store);

              console.log(`[Swing] ${ticker} 매도 완료: ${sellQty}주, 수익 ${profit.toLocaleString()}원 (${profitRate}%)`);
              await sendSwingNotification(
                `[스윙 매도] ${stockName}(${ticker})\n${sellQty}주 × ~${currentPrice.toLocaleString()}원\n` +
                `수익: ${profit.toLocaleString()}원 (${profitRate}%)\n사유: ${exitResult.reason}`,
              );

              return; // state 삭제했으므로 update 불필요
            }
          } else {
            console.error(`[Swing] ${ticker} 매도 주문 실패: ${orderRes.msg1}`);
          }
        } catch (err) {
          if (isTokenExpiredError(err)) {
            accessToken = await getOrRefreshToken('', accountId, { appKey, appSecret }, kisClient, true);
            try {
              const sellPrice2 = exitResult.orderType === 'LIMIT' && exitResult.suggestedPrice
                ? roundToKoreanTickCeil(exitResult.suggestedPrice) : 0;
              const retryRes = await kisClient.submitDomesticOrder(
                appKey, appSecret, accessToken, accountNo,
                { ticker, side: 'SELL', orderType: exitResult.orderType, price: sellPrice2, quantity: sellQty },
              );
              if (retryRes.rt_cd === '0') {
                console.log(`[Swing] ${ticker} 매도 재시도 성공 (토큰 재발급)`);
              } else {
                console.error(`[Swing] ${ticker} 매도 재시도 실패: ${retryRes.msg1}`);
              }
            } catch (retryErr) {
              console.error(`[Swing] ${ticker} 매도 재시도 에러:`, (retryErr as Error).message);
            }
          } else {
            console.error(`[Swing] ${ticker} 매도 주문 에러:`, (err as Error).message);
          }
        }
      } else {
        // 추가매수 판단 (매도 안 할 때만)
        const addBuyResult = calculateSwingAdditionalBuy(
          { ...state, indicators },
          indicators,
          dailyBars,
        );

        if (addBuyResult.shouldBuy && addBuyResult.suggestedQuantity && addBuyResult.suggestedQuantity > 0) {
          console.log(`[Swing] ${shadowMode ? '[SHADOW] ' : ''}${ticker} 추가매수 신호: ${addBuyResult.reason}`);

          if (shadowMode) {
            const addQty = addBuyResult.suggestedQuantity!;
            const addPrice = currentPrice + getKoreanTickSize(currentPrice);
            const newRecord: SwingBuyRecord = {
              price: addPrice, quantity: addQty, amount: addPrice * addQty,
              date: new Date().toISOString(), reason: 'additional',
            };
            const simRecords = [...state.buyRecords, newRecord];
            const simAvg = calculateAvgPrice(simRecords);
            console.log(`[Swing] [SHADOW] ${ticker} 가상 추가매수: ${addQty}주 × ${addPrice}원 (평단 ${simAvg.avgPrice.toFixed(0)}원)`);
            appendShadowTradeLog({
              timestamp: new Date().toISOString(),
              action: 'ADDITIONAL_BUY',
              ticker,
              stockName,
              price: addPrice,
              quantity: addQty,
              amount: addPrice * addQty,
              addBuyReason: addBuyResult.reason,
              avgPriceAfter: Math.round(simAvg.avgPrice),
              totalQuantityAfter: simAvg.totalQuantity,
              currentPrice,
              totalInvested: state.totalInvested,
              totalQuantity: state.totalQuantity,
              avgPrice: state.avgPrice,
              holdingDays: update.holdingDays,
              indicators: {
                ema5: indicators.ema5, ema20: indicators.ema20, ema60: indicators.ema60,
                rsi14: indicators.rsi14, atr14: indicators.atr14,
                macdHist: indicators.macdHist,
              },
            }, store);
          } else {
          const buyPrice = currentPrice + getKoreanTickSize(currentPrice);
          try {
            const orderRes = await kisClient.submitDomesticOrder(
              appKey, appSecret, accessToken, accountNo,
              { ticker, side: 'BUY', orderType: 'LIMIT', price: buyPrice, quantity: addBuyResult.suggestedQuantity },
            );

            if (orderRes.rt_cd === '0') {
              const newRecord: SwingBuyRecord = {
                price: buyPrice,
                quantity: addBuyResult.suggestedQuantity,
                amount: buyPrice * addBuyResult.suggestedQuantity,
                date: new Date().toISOString(),
                reason: 'additional',
                orderNo: orderRes.output?.ODNO || '',
              };

              const newRecords = [...state.buyRecords, newRecord];
              const { avgPrice, totalQuantity, totalInvested } = calculateAvgPrice(newRecords);

              update.buyRecords = newRecords;
              update.avgPrice = avgPrice;
              update.totalQuantity = totalQuantity;
              update.totalInvested = totalInvested;

              console.log(`[Swing] ${ticker} 추가매수 성공: ${addBuyResult.suggestedQuantity}주 × ${buyPrice}원 (평단 ${avgPrice.toFixed(0)}원)`);
              await sendSwingNotification(`[스윙 추가매수] ${stockName}(${ticker})\n${addBuyResult.suggestedQuantity}주 × ${buyPrice.toLocaleString()}원\n평단: ${avgPrice.toLocaleString()}원`);
            }
          } catch (err) {
            if (isTokenExpiredError(err)) {
              accessToken = await getOrRefreshToken('', accountId, { appKey, appSecret }, kisClient, true);
              try {
                const retryRes = await kisClient.submitDomesticOrder(
                  appKey, appSecret, accessToken, accountNo,
                  { ticker, side: 'BUY', orderType: 'LIMIT', price: buyPrice, quantity: addBuyResult.suggestedQuantity! },
                );
                if (retryRes.rt_cd === '0') {
                  console.log(`[Swing] ${ticker} 추가매수 재시도 성공 (토큰 재발급)`);
                } else {
                  console.error(`[Swing] ${ticker} 추가매수 재시도 실패: ${retryRes.msg1}`);
                }
              } catch (retryErr) {
                console.error(`[Swing] ${ticker} 추가매수 재시도 에러:`, (retryErr as Error).message);
              }
            } else {
              console.error(`[Swing] ${ticker} 추가매수 에러:`, (err as Error).message);
            }
          }
          } // end else (not shadow)
        }
      }
      break;
    }
  }

  // state 업데이트 (로컬 파일)
  updateSwingState(ticker, update as Record<string, unknown>, store);
}

// ==================== 일봉 갱신 (장 시작 시 1회) ====================

/**
 * 모든 감시/보유 종목의 일봉 데이터 갱신
 * swingLocalRunner에서 09:05에 호출
 */
export async function refreshAllDailyBars(): Promise<void> {
  // 캐시 무효화 (날짜 변경 시 자동으로 다시 조회됨)
  dailyBarCache.clear();
  console.log(`[Swing] ${getKSTTimeString()} 일봉 캐시 초기화 완료`);
}

// ==================== 자동 유니버스 스크리닝 ====================

// 유니버스 캐시 (1일 1회 갱신)
let universeCache: { tickers: SwingTickerConfig[]; date: string } | null = null;

/**
 * 거래량순위 + 시총순위 API → 스윙 후보 유니버스 자동 생성
 *
 * 필터:
 * - 가격: 5,000원 ~ 200,000원
 * - 시총: 3,000억 ~ 5조 (mid-cap sweet spot)
 * - 거래대금: 50억 이상
 * - 우선주/스팩 제외
 *
 * KOSPI + KOSDAQ 양시장 스캔, 최대 ~120종목
 */
async function refreshSwingUniverse(
  kisClient: KisApiClient,
  appKey: string,
  appSecret: string,
  accessToken: string,
  swingConfig: SwingConfig,
  manualTickers: SwingTickerConfig[],
  holdingTickers: Set<string>,
): Promise<SwingTickerConfig[]> {
  const today = getTodayKST();
  if (universeCache && universeCache.date === today) {
    console.log(`[Swing:Universe] 캐시 사용 (${universeCache.tickers.length}종목)`);
    return universeCache.tickers;
  }

  console.log('[Swing:Universe] 유니버스 갱신 시작...');

  // 종목 수집 (ticker → { name, price, marketCap, tradingValue })
  const candidates = new Map<string, {
    name: string; price: number; marketCap: number; tradingValue: number;
  }>();

  // --- 거래량순위: KOSPI + KOSDAQ ---
  const volumeCalls: Array<{ marketCode: string; label: string }> = [
    { marketCode: 'J', label: 'KOSPI' },
    { marketCode: 'K', label: 'KOSDAQ' },
  ];

  for (const { marketCode, label } of volumeCalls) {
    try {
      await new Promise(r => setTimeout(r, 300));
      const res = await kisClient.getDomesticVolumeRanking(
        appKey, appSecret, accessToken,
        { marketCode, priceMin: '5000', priceMax: '200000' },
      );
      const items = res.output || [];
      for (const item of items) {
        const ticker = item.mksc_shrn_iscd;
        const name = item.hts_kor_isnm;
        const price = Number(item.stck_prpr);
        const listedShares = Number(item.lstn_stcn);
        const tradingValue = Number(item.acml_tr_pbmn);
        const marketCap = price * listedShares;

        if (ticker && price > 0) {
          candidates.set(ticker, { name, price, marketCap, tradingValue });
        }
      }
      console.log(`[Swing:Universe] ${label} 거래량순위: ${items.length}건`);
    } catch (err) {
      console.error(`[Swing:Universe] ${label} 거래량순위 조회 실패:`, (err as Error).message);
    }
  }

  // --- 시가총액순위 (mid-cap 보완) ---
  try {
    await new Promise(r => setTimeout(r, 300));
    const mcRes = await kisClient.getDomesticMarketCapRanking(appKey, appSecret, accessToken);
    const items = mcRes.output || [];
    for (const item of items) {
      const ticker = item.mksc_shrn_iscd;
      if (candidates.has(ticker)) continue; // 이미 있으면 스킵
      const name = item.hts_kor_isnm;
      const price = Number(item.stck_prpr);
      const marketCap = Number(item.stck_avls) * 100_000_000; // stck_avls는 억원 단위
      const tradingValue = Number(item.acml_vol) * price; // 대략적 거래대금

      if (ticker && price > 0) {
        candidates.set(ticker, { name, price, marketCap, tradingValue });
      }
    }
    console.log(`[Swing:Universe] 시총순위: ${items.length}건`);
  } catch (err) {
    console.error('[Swing:Universe] 시총순위 조회 실패:', (err as Error).message);
  }

  // --- 필터링 ---
  const MIN_PRICE = 5_000;
  const MAX_PRICE = 200_000;
  const MIN_MARKET_CAP = 3_000 * 100_000_000;  // 3,000억
  const MAX_MARKET_CAP = 50_000 * 100_000_000;  // 5조
  const MIN_TRADING_VALUE = 50 * 100_000_000;    // 50억

  const filtered: SwingTickerConfig[] = [];
  const manualTickerSet = new Set(manualTickers.map(t => t.ticker));

  for (const [ticker, info] of candidates) {
    // 수동 등록 종목은 별도 처리 (아래에서 합침)
    if (manualTickerSet.has(ticker)) continue;

    // 우선주 제외 (코드 끝자리 5, 7, 8, 9 or 이름에 "우" 포함)
    const lastDigit = ticker.charAt(5);
    if (['5', '7', '8', '9'].includes(lastDigit)) continue;
    if (info.name.endsWith('우') || info.name.endsWith('우B') || info.name.endsWith('우C')) continue;

    // 스팩 제외
    if (info.name.includes('스팩')) continue;

    // 가격 필터
    if (info.price < MIN_PRICE || info.price > MAX_PRICE) continue;

    // 시총 필터
    if (info.marketCap > 0 && (info.marketCap < MIN_MARKET_CAP || info.marketCap > MAX_MARKET_CAP)) continue;

    // 거래대금 필터
    if (info.tradingValue > 0 && info.tradingValue < MIN_TRADING_VALUE) continue;

    // 기본값으로 SwingTickerConfig 생성
    filtered.push({
      ticker,
      stockName: info.name,
      principal: swingConfig.globalPrincipal / swingConfig.maxPositions,
      profitPercent: swingConfig.defaultProfitPercent,
      stopLossPercent: swingConfig.defaultStopLossPercent,
      trailingStopPercent: swingConfig.trailingStopPercent,
      maxAdditionalBuys: 1,
      additionalBuyDropPercent: 0.03,
      entryStrategy: 'ema_pullback',
    });
  }

  // 수동 등록 종목 우선 합침 + 보유 종목 유지
  const merged: SwingTickerConfig[] = [...manualTickers];
  const mergedSet = new Set(manualTickers.map(t => t.ticker));

  // 보유 종목이 자동 풀에 없어도 반드시 포함
  for (const t of filtered) {
    if (!mergedSet.has(t.ticker)) {
      merged.push(t);
      mergedSet.add(t.ticker);
    }
  }

  // 보유 중인데 목록에 없는 종목 → 기본값으로 추가
  for (const ticker of holdingTickers) {
    if (!mergedSet.has(ticker)) {
      merged.push({
        ticker,
        stockName: candidates.get(ticker)?.name || ticker,
        principal: swingConfig.globalPrincipal / swingConfig.maxPositions,
        profitPercent: swingConfig.defaultProfitPercent,
        stopLossPercent: swingConfig.defaultStopLossPercent,
        trailingStopPercent: swingConfig.trailingStopPercent,
        maxAdditionalBuys: 1,
        additionalBuyDropPercent: 0.03,
        entryStrategy: 'ema_pullback',
      });
      mergedSet.add(ticker);
    }
  }

  universeCache = { tickers: merged, date: today };
  console.log(`[Swing:Universe] 유니버스 갱신 완료: ${merged.length}종목 (수동 ${manualTickers.length} + 자동 ${filtered.length})`);

  return merged;
}

// ==================== D-confirmed Execution Policy ====================
// 운영 정책 v1:
//   1. 전일 장마감 후(15:35+) setup 계산 → pendingOrders 저장
//   2. 다음 거래일 09:05 LIMIT 주문 제출 (shadow: 로그만)
//   3. 장중 체결 모니터링 (shadow: 현재가로 가상 체결 판정)
//   4. 15:20 미체결 취소 → pending 삭제
//   5. 보유 종목 청산은 기존 runSwingTradingLoop() 그대로 사용
//
// shadow mode: 실제 주문 없이 로그 수집. execution realism 검증 목적.

/**
 * Phase A: EOD Setup Scan (15:35+ 호출)
 *
 * 전일 장마감 후 일봉 기반 setup 계산.
 * shouldBuy + LIMIT plan이 나오면 pendingOrders에 저장.
 */
export async function runEodSetupScan(ctx?: AccountContext): Promise<number> {
  try {
    const count = await processEodScan(ctx);
    return count;
  } catch (err) {
    const accountId = ctx?.accountId ?? config.accountId;
    console.error(`[Swing:EOD] ${accountId} 에러:`, (err as Error).message);
    return 0;
  }
}

async function processEodScan(ctx?: AccountContext): Promise<number> {
  const store = ctx?.store;

  const commonConfig = ctx
    ? ctx.store.getTradingConfig<CommonConfig>()
    : getCommonConfig();
  if (!commonConfig?.tradingEnabled || !commonConfig.domestic?.swingEnabled) return 0;

  const swingConfig = ctx
    ? ctx.store.getStrategyConfig<SwingConfig>('domestic', 'swing')
    : getMarketStrategyConfig<SwingConfig>('domestic', 'swing');
  if (!swingConfig) return 0;

  const credentials = ctx
    ? { appKey: ctx.credentials.appKey, appSecret: ctx.credentials.appSecret, accountNo: ctx.credentials.accountNo }
    : { appKey: config.kis.appKey, appSecret: config.kis.appSecret, accountNo: config.kis.accountNo };

  const kisClient = ctx?.kisClient ?? new KisApiClient();
  const accountId = ctx?.accountId ?? config.accountId;
  const accessToken = await getOrRefreshToken('', accountId, credentials, kisClient);

  const stateMap = getAllSwingStates<SwingState>(store);
  const holdingTickersSet = new Set<string>();
  let holdingCount = 0;
  for (const [ticker, s] of stateMap) {
    if (s.status === 'holding' || s.status === 'trailing') {
      holdingTickersSet.add(ticker);
      holdingCount++;
    }
  }

  // 자동 유니버스 갱신 (거래량순위 + 시총순위 → 필터링)
  const universeTickers = await refreshSwingUniverse(
    kisClient, credentials.appKey, credentials.appSecret, accessToken,
    swingConfig, swingConfig.tickers || [], holdingTickersSet,
  );

  const marketContext = await fetchMarketContext(
    kisClient, credentials.appKey, credentials.appSecret, accessToken,
  ) || undefined;

  const pendingOrders: PendingLimitOrder[] = [];
  const today = getTodayKST();

  interface ScanResult {
    tickerConfig: SwingTickerConfig;
    entryResult: SwingEntryResult;
    rankScore: number;
  }
  const scanResults: ScanResult[] = [];
  const universeLog: UniverseTickerLog[] = [];

  const manualTickerSet = new Set((swingConfig.tickers || []).map(t => t.ticker));

  console.log(`[Swing:EOD] 유니버스 ${universeTickers.length}종목 스캔 시작 (보유 ${holdingCount}건)`);

  for (let i = 0; i < universeTickers.length; i++) {
    if (i > 0) await new Promise(r => setTimeout(r, 300));
    const tickerConfig = universeTickers[i];
    const { ticker } = tickerConfig;
    const source = manualTickerSet.has(ticker) ? 'manual' as const : 'auto' as const;

    // 이미 보유 중이면 스킵
    const state = stateMap.get(ticker);
    if (state && (state.status === 'holding' || state.status === 'trailing')) {
      universeLog.push({ ticker, stockName: tickerConfig.stockName, source, skipReason: 'holding' });
      continue;
    }

    // 다른 전략이 점유 중이면 스킵
    const crossStrategyOccupied = getOccupiedTickersExcluding('domestic', 'swing');
    if (crossStrategyOccupied.has(ticker)) {
      universeLog.push({ ticker, stockName: tickerConfig.stockName, source, skipReason: 'occupied_by_other_strategy' });
      continue;
    }

    try {
      const dailyBars = await fetchDailyBars(kisClient, credentials.appKey, credentials.appSecret, accessToken, ticker);
      if (dailyBars.length < 60) {
        universeLog.push({ ticker, stockName: tickerConfig.stockName, source, skipReason: 'insufficient_data' });
        continue;
      }

      const quoteRes = await kisClient.getDomesticCurrentPrice(credentials.appKey, credentials.appSecret, accessToken, ticker);
      const currentPrice = Number(quoteRes.output?.stck_prpr || 0);
      if (currentPrice <= 0) {
        universeLog.push({ ticker, stockName: tickerConfig.stockName, source, skipReason: 'no_price' });
        continue;
      }

      const dailyIndicators = calculateSwingIndicators(dailyBars, currentPrice);
      const tradingValue = quoteRes.output?.acml_tr_pbmn ? Number(quoteRes.output.acml_tr_pbmn) : null;
      const indicators: SwingIndicators = { ...dailyIndicators, ema20_5m: null, rsi14_5m: null, tradingValue };

      const watchState = state || createInitialSwingState(tickerConfig, swingConfig, 1);
      watchState.indicators = indicators;

      const entryResult = calculateSwingEntry(
        watchState, indicators, dailyBars, tickerConfig,
        holdingCount, swingConfig.maxPositions,
        marketContext, true, // isNearClose = true (장마감 후)
      );

      const rankScore = calculateCandidateRankScore(entryResult);

      // 상태 업데이트
      const transition = determineCheckInterval(watchState, entryResult.readinessScore, entryResult.pullbackState);
      const update: Partial<SwingState> = {
        indicators,
        readinessScore: entryResult.readinessScore,
        pullbackState: entryResult.pullbackState,
        status: transition.newStatus,
        checkInterval: transition.checkInterval,
      };
      if (entryResult.activeSwing) update.activeSwing = entryResult.activeSwing;
      updateSwingState(ticker, update as Record<string, unknown>, store);

      universeLog.push({
        ticker, stockName: tickerConfig.stockName, source,
        readinessScore: entryResult.readinessScore,
        pullbackState: entryResult.pullbackState,
      });

      if (entryResult.shouldBuy) {
        scanResults.push({ tickerConfig, entryResult, rankScore });
      }

      if (entryResult.readinessScore >= 40) {
        console.log(`[Swing:EOD] ${ticker} (${tickerConfig.stockName}) score=${entryResult.readinessScore} state=${entryResult.pullbackState}` +
          ` plan=${entryResult.entryPlan?.orderType ?? 'none'} zone=${entryResult.entryPlan?.zoneLabel ?? ''}`);
      }
    } catch (err) {
      universeLog.push({ ticker, stockName: tickerConfig.stockName, source, skipReason: `error: ${(err as Error).message}` });
      console.error(`[Swing:EOD] ${ticker} 스캔 에러:`, (err as Error).message);
    }
  }

  // 랭킹 정렬 → pending orders 생성
  scanResults.sort((a, b) => b.rankScore - a.rankScore);

  const candidateLog: CandidateLog[] = [];

  for (const scan of scanResults) {
    const plan = scan.entryResult.entryPlan;
    if (!plan || plan.orderType === 'SKIP') continue;
    if (plan.orderType !== 'LIMIT' || !plan.limitPrice) continue;

    const slotsFull = holdingCount + pendingOrders.length >= swingConfig.maxPositions;

    const candidate: CandidateLog = {
      ticker: scan.tickerConfig.ticker,
      stockName: scan.tickerConfig.stockName,
      rankScore: scan.rankScore,
      readinessScore: scan.entryResult.readinessScore,
      zoneLabel: plan.zoneLabel ?? '',
      limitPrice: plan.limitPrice,
      rrRatio: scan.entryResult.executionGate?.rrRatio ?? 0,
      premiumATR: scan.entryResult.swingContext?.premiumATR ?? null,
      selected: !slotsFull,
      rejectReason: slotsFull ? 'slots_full' : undefined,
    };
    candidateLog.push(candidate);

    if (slotsFull) continue;

    const order: PendingLimitOrder = {
      ticker: scan.tickerConfig.ticker,
      stockName: scan.tickerConfig.stockName,
      limitPrice: plan.limitPrice,
      signalDate: today,
      zoneLabel: plan.zoneLabel ?? '',
      riskMultiplier: plan.riskMultiplier ?? 1.0,
      readinessScore: scan.entryResult.readinessScore,
      rankScore: scan.rankScore,
      rrRatio: scan.entryResult.executionGate?.rrRatio ?? 0,
      premiumATR: scan.entryResult.swingContext?.premiumATR ?? null,
      riskATR: scan.entryResult.swingContext?.tradeRiskATR ?? null,
      acceptanceScore: scan.entryResult.swingContext?.acceptanceScore ?? 0,
      initialTradeStop: scan.entryResult.swingContext?.initialTradeStop ?? null,
      submitted: false,
    };

    pendingOrders.push(order);
    console.log(`[Swing:EOD] ${order.ticker} (${order.stockName}) LIMIT ${order.limitPrice}원 등록 ` +
      `(zone=${order.zoneLabel}, rank=${order.rankScore}, rr=${order.rrRatio.toFixed(1)})`);
  }

  setPendingOrders(pendingOrders, store);
  console.log(`[Swing:EOD] pending orders: ${pendingOrders.length}건`);

  // 스캔 로그 저장
  const pendingOrderLog: PendingOrderLog[] = pendingOrders.map(o => ({
    ticker: o.ticker, stockName: o.stockName,
    limitPrice: o.limitPrice, zoneLabel: o.zoneLabel, rankScore: o.rankScore,
  }));

  appendScanLog({
    date: today,
    scannedAt: new Date().toISOString(),
    universeSize: universeTickers.length,
    candidateCount: candidateLog.length,
    pendingCount: pendingOrders.length,
    holdingCount,
    universe: universeLog,
    candidates: candidateLog,
    pendingOrders: pendingOrderLog,
  }, store);
  console.log(`[Swing:EOD] 스캔 로그 저장 완료 (${universeLog.length}종목 스캔, ${candidateLog.length}건 후보, ${pendingOrders.length}건 pending)`);

  return pendingOrders.length;
}

/**
 * Phase B: AM Order Submit (09:05 호출)
 *
 * pending orders에 대해 LIMIT 주문 제출.
 * shadow mode: 주문 제출 없이 로그만 기록.
 */
export async function submitPendingOrders(shadow: boolean = true, ctx?: AccountContext): Promise<number> {
  const store = ctx?.store;
  const pending = getPendingOrders(store);
  if (pending.length === 0) return 0;

  console.log(`[Swing:AM] ${shadow ? '[SHADOW] ' : ''}pending ${pending.length}건 주문 처리`);

  if (shadow) {
    // Shadow mode: 제출하지 않고 로그만
    for (const order of pending) {
      console.log(`[Swing:AM] [SHADOW] ${order.ticker} (${order.stockName}) LIMIT ${order.limitPrice}원 ` +
        `(zone=${order.zoneLabel}, signal=${order.signalDate})`);
    }
    return pending.length;
  }

  // 실전 모드: KIS API로 실제 주문 제출
  const credentials = ctx
    ? { appKey: ctx.credentials.appKey, appSecret: ctx.credentials.appSecret, accountNo: ctx.credentials.accountNo }
    : { appKey: config.kis.appKey, appSecret: config.kis.appSecret, accountNo: config.kis.accountNo };

  const kisClient = ctx?.kisClient ?? new KisApiClient();
  const accountId = ctx?.accountId ?? config.accountId;
  const accessToken = await getOrRefreshToken('', accountId, credentials, kisClient);

  const swingConfig = ctx
    ? ctx.store.getStrategyConfig<SwingConfig>('domestic', 'swing')
    : getMarketStrategyConfig<SwingConfig>('domestic', 'swing');
  if (!swingConfig) return 0;

  for (const order of pending) {
    const tickerConfig = swingConfig.tickers.find(t => t.ticker === order.ticker);
    if (!tickerConfig) continue;

    // 수량 결정 (고정금액 기반)
    const quantity = Math.floor(tickerConfig.principal * order.riskMultiplier / order.limitPrice);
    if (quantity <= 0) continue;

    try {
      const orderRes = await kisClient.submitDomesticOrder(
        credentials.appKey, credentials.appSecret, accessToken, credentials.accountNo,
        { ticker: order.ticker, side: 'BUY', orderType: 'LIMIT', price: order.limitPrice, quantity },
      );

      if (orderRes.rt_cd === '0') {
        order.submitted = true;
        order.orderNo = orderRes.output?.ODNO || '';
        console.log(`[Swing:AM] ${order.ticker} 주문 제출: ${quantity}주 × ${order.limitPrice}원 (주문번호: ${order.orderNo})`);
      } else {
        console.error(`[Swing:AM] ${order.ticker} 주문 실패: ${orderRes.msg1}`);
      }
    } catch (err) {
      console.error(`[Swing:AM] ${order.ticker} 주문 에러:`, (err as Error).message);
    }

    await new Promise(r => setTimeout(r, 300));
  }

  setPendingOrders(pending, store);
  return pending.filter(o => o.submitted).length;
}

/**
 * Phase C: Intraday Fill Check (장중 주기적 호출)
 *
 * pending orders의 체결 여부를 현재가로 확인.
 * shadow mode: 현재가의 low/open으로 가상 체결 판정.
 */
export async function checkPendingFills(shadow: boolean = true, ctx?: AccountContext): Promise<number> {
  const store = ctx?.store;
  const pending = getPendingOrders(store);
  if (pending.length === 0) return 0;

  const credentials = ctx
    ? { appKey: ctx.credentials.appKey, appSecret: ctx.credentials.appSecret, accountNo: ctx.credentials.accountNo }
    : { appKey: config.kis.appKey, appSecret: config.kis.appSecret, accountNo: config.kis.accountNo };

  const kisClient = ctx?.kisClient ?? new KisApiClient();
  const accountId = ctx?.accountId ?? config.accountId;
  const accessToken = await getOrRefreshToken('', accountId, credentials, kisClient);

  let fillCount = 0;
  const today = getTodayKST();

  // Copy pending to iterate safely while splicing
  const remaining = [...pending];

  for (const order of [...remaining]) {
    try {
      const quoteRes = await kisClient.getDomesticCurrentPrice(
        credentials.appKey, credentials.appSecret, accessToken, order.ticker,
      );
      const currentPrice = Number(quoteRes.output?.stck_prpr || 0);
      const todayLow = Number(quoteRes.output?.stck_lwpr || 0);
      const todayOpen = Number(quoteRes.output?.stck_oprc || 0);

      if (todayLow > 0 && todayLow <= order.limitPrice) {
        // 체결 판정
        const gapDown = todayOpen > 0 && todayOpen < order.limitPrice;
        const fillPrice = gapDown ? todayOpen : order.limitPrice;
        const fillType = gapDown ? 'gap_down' : 'limit_hit';

        console.log(`[Swing:FILL] ${shadow ? '[SHADOW] ' : ''}${order.ticker} 체결! ` +
          `${fillPrice}원 (${fillType}, limit=${order.limitPrice}, low=${todayLow})`);

        appendShadowLog(today, {
          ticker: order.ticker,
          signalDate: order.signalDate,
          fillDate: today,
          limitPrice: order.limitPrice,
          fillPrice,
          fillType,
          closeAtFillDay: currentPrice,
        }, store);

        // pending에서 제거
        const idx = remaining.indexOf(order);
        if (idx >= 0) remaining.splice(idx, 1);
        fillCount++;

        if (!shadow) {
          // 실전: 체결 확인 후 swingState 생성은 별도 처리 필요
          // (KIS 체결 조회 API로 실제 체결 확인)
          console.log(`[Swing:FILL] ${order.ticker} 실전 체결 처리 — 수동 확인 필요`);
        }
      }
    } catch (err) {
      console.error(`[Swing:FILL] ${order.ticker} 체결 확인 에러:`, (err as Error).message);
    }

    await new Promise(r => setTimeout(r, 200));
  }

  setPendingOrders(remaining, store);
  return fillCount;
}

/**
 * Phase D: EOD Cancel (15:20 호출)
 *
 * 미체결 pending orders 취소 + 로그.
 */
export async function cancelUnfilledOrders(shadow: boolean = true, ctx?: AccountContext): Promise<number> {
  const store = ctx?.store;
  const pending = getPendingOrders(store);
  if (pending.length === 0) return 0;

  const today = getTodayKST();
  let cancelCount = 0;

  for (const order of pending) {
    console.log(`[Swing:CANCEL] ${shadow ? '[SHADOW] ' : ''}${order.ticker} (${order.stockName}) ` +
      `미체결 취소 (limit=${order.limitPrice}, zone=${order.zoneLabel})`);

    appendShadowLog(today, {
      ticker: order.ticker,
      signalDate: order.signalDate,
      fillDate: today,
      limitPrice: order.limitPrice,
      fillPrice: 0,
      fillType: 'not_filled',
      closeAtFillDay: 0, // 장마감 종가는 별도 조회 필요
    }, store);

    if (!shadow && order.submitted && order.orderNo) {
      // 실전: KIS 주문 취소 API 호출
      console.log(`[Swing:CANCEL] ${order.ticker} 실전 주문 취소 — 주문번호 ${order.orderNo}`);
      // TODO: kisClient.cancelDomesticOrder(...)
    }

    cancelCount++;
  }

  clearPendingOrders(store);
  console.log(`[Swing:CANCEL] ${cancelCount}건 미체결 취소 완료`);

  return cancelCount;
}
