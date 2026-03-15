/**
 * 스윙매매 Calculator — 순수 함수 (I/O 없음, 백테스트 가능)
 *
 * 진입 판단: 4단계 평가 (추세→조정→지지→트리거) + 무효화 조건
 * 청산 전략: 목표가 익절 / 트레일링 스탑 / 고정 손절 / 시간 손절
 */

import { calculateEMA, calculateRSI } from './rsiCalculator';

// ==================== 타입 정의 ====================

export type SwingEntryStrategy = 'ema_pullback' | 'ema_breakout' | 'rsi_oversold';

export type SwingStatus = 'watching' | 'ready' | 'holding' | 'trailing' | 'completed';

export type SwingSellReason =
  | 'profit_target'
  | 'trailing_stop'
  | 'stop_loss'
  | 'time_stop'
  | 'ema_break'
  | 'manual';

/** 포지션 라이프사이클 단계 */
export type PositionPhase =
  | 'INIT_RISK'    // 진입 직후 — 구조적 손절 적용, 최대 리스크
  | 'DE_RISKED'    // target1 부분익절 완료 — breakeven stop, 리스크 해소
  | 'RUNNER'       // 잔량 트레일링 — ATR 기반, 수익 극대화 모드
  | 'WEAKENING';   // 추세 약화 감지 — 타이트 트레일링, 청산 준비

/** 눌림목 상태 머신 */
export type SwingPullbackState =
  | 'TRENDING'            // 상승 추세는 있으나 아직 조정 없음
  | 'PULLBACK_FORMING'    // 조정 형성 중
  | 'SUPPORT_TEST'        // 지지 구간 테스트 중
  | 'READY_TO_TRIGGER'    // 지지 확인 후 반등 직전
  | 'ENTRY_SIGNAL'        // 매수 신호 발생
  | 'SOFT_INVALIDATED'    // 일시 무효 (조건 회복 시 재평가)
  | 'RECOVERING'          // SOFT 무효 후 회복 중
  | 'HARD_INVALIDATED';   // 확정 무효 (일정 기간 재평가 금지)

export interface SwingTickerConfig {
  ticker: string;
  stockName: string;
  principal: number;
  profitPercent: number;
  stopLossPercent: number;
  trailingStopPercent?: number;
  maxAdditionalBuys: number;
  additionalBuyDropPercent: number;
  entryStrategy: SwingEntryStrategy;
  memo?: string;
}

export interface SwingConfig {
  tickers: SwingTickerConfig[];
  globalPrincipal: number;
  maxPositions: number;
  defaultProfitPercent: number;
  defaultStopLossPercent: number;
  trailingStopEnabled: boolean;
  trailingStopPercent: number;
  maxHoldingDays: number;
}

export interface SwingBuyRecord {
  price: number;
  quantity: number;
  amount: number;
  date: string;
  reason: 'initial' | 'additional';
  orderNo?: string;
}

export interface SwingIndicators {
  ema5: number | null;
  ema20: number | null;
  ema60: number | null;
  rsi14: number | null;
  macd: number | null;
  macdSignal: number | null;
  macdHist: number | null;
  currentPrice: number;
  ema20_5m: number | null;
  rsi14_5m: number | null;
  dailyVolume: number;
  avgVolume20: number | null;
  /** 누적 거래대금 (원) — 유동성 필터용 */
  tradingValue: number | null;
  /** ATR(14) — 변동성 기반 동적 기준용 */
  atr14: number | null;
}

/** 시장 방향 정보 (코스피/코스닥 지수) */
export interface MarketContext {
  /** 현재 지수 */
  indexPrice: number;
  /** 전일 대비율 (%) */
  changeRate: number;
  /** 20일 이격도 (100 기준, >100이면 MA20 위) */
  d20Disparity: number | null;
  /** 상승종목수 */
  advancingCount: number;
  /** 하락종목수 */
  decliningCount: number;
}

/**
 * Active Swing — 모든 파생 계산의 기준점
 * 현재 유효한 상승 파동의 앵커 포인트와 파생 레벨
 */
export interface ActiveSwing {
  /** 상승 시작점 (스윙 저점) */
  anchorLow: number;
  anchorLowIdx: number;
  /** 상승 고점 (스윙 고점) */
  anchorHigh: number;
  anchorHighIdx: number;
  /** 돌파 기준선 (이전 저항 → 현재 지지) */
  breakoutLevel: number;
  /** 지지 구간 (MA20/피보/돌파 클러스터의 상하단) */
  supportZone: { upper: number; lower: number };
  /** 이 아래 떨어지면 무효 (anchorLow 또는 직전 저점) */
  invalidationLevel: number;
  /** 1차 목표가 (직전 고점 retest) */
  target1: number;
  /** 2차 목표가 (상승폭 1:1 측정 이동) */
  target2: number;
  /** 현 상승파동 내 조정 횟수 */
  pullbackCount: number;
  /** 조정 완료 여부 (higher low 확인) */
  pullbackComplete: boolean;
  /** 스윙 구조 신뢰도 (0~1) — prominence/volume/recency 종합 */
  confidence: number;
}

/**
 * SwingContext — 모든 평가 축이 참조하는 single source of truth
 * Active Swing + 구조적 파생 데이터를 한 곳에 집약
 */
export interface SwingContext {
  activeSwing: ActiveSwing | null;
  /** Active Swing 기준 fib retracement depth (0~1, null이면 AS 없음) */
  retracementDepth: number | null;
  /** 현재가가 supportZone 내에 있는지 */
  inSupportZone: boolean;
  /** 현재가 → supportZone 하단 거리 (%) */
  distToSupportLower: number | null;
  /** 현재가가 breakoutLevel 위에 있는지 */
  aboveBreakout: boolean;
  /** R:R 정보 (thesis invalidation 기준 — context용) */
  rr: { rr1: number; rr2: number; riskDistance: number; reward1Distance: number } | null;

  // ===== 3-tier stop architecture =====

  /** 실제 초기 손절선 — local structure 기반 (pullback pivot low / support / breakout reclaim - ATR buffer) */
  initialTradeStop: number | null;
  /** thesis 무효화 레벨 — anchorLow / major swing low 기반 (setup 무효 판단용, execution에서는 context로만 사용) */
  thesisInvalidation: number | null;
  /** initialTradeStop 기준 R:R (실제 execution 판단용) */
  rrTrade: { rr1: number; rr2: number; riskDistance: number; reward1Distance: number } | null;
  /** initialTradeStop 기준 리스크율 (%) */
  tradeRiskPct: number | null;
  /** initialTradeStop까지 ATR 배수 */
  tradeRiskATR: number | null;
  /** fair entry 대비 프리미엄 (ATR 배수) — 추격 매수 정도 측정 */
  premiumATR: number | null;
  /** acceptance score (0~100) — 지지 zone 수용 정도 (CLV/volume/noNewLow/reclaim 종합) */
  acceptanceScore: number;
}

/** Execution Gate 결과 — 점수와 분리된 실행 가능 여부 */
export interface ExecutionGate {
  /** 조정 완료 확인 */
  completionConfirmed: boolean;
  /** Risk:Reward 비율 */
  rrRatio: number;
  /** R:R 통과 (≥ 2.0) */
  rrPassed: boolean;
  /** 장마감 시간 통과 (외부에서 주입) */
  timeGatePassed: boolean;
  /** 유동성 통과 */
  liquidityPassed: boolean;
  /** 시장 방향 통과 */
  marketPassed: boolean;
  /** 구조적 리스크 허용 범위 내 */
  structuralRiskPassed: boolean;
  /** 모든 gate 통과 */
  executable: boolean;
  /** 차단 사유 (hard veto) */
  blockReasons: string[];
  /** soft penalty (랭킹 감점, 차단은 아님) */
  softPenalties: string[];
  /** soft penalty 합산 감점 */
  softPenaltyScore: number;
}

export interface SwingState {
  ticker: string;
  stockName: string;
  status: SwingStatus;
  entryStrategy: SwingEntryStrategy;
  checkInterval: 5 | 15;
  readinessScore: number;
  pullbackState?: SwingPullbackState;
  /** Active Swing 기준점 */
  activeSwing?: ActiveSwing;
  /** 실제 초기 손절선 (local structure 기반) — 진입 시 저장 */
  initialTradeStop?: number;
  buyRecords: SwingBuyRecord[];
  avgPrice: number;
  totalQuantity: number;
  totalInvested: number;
  entryDate: string | null;
  holdingDays: number;
  highestPrice: number;
  trailingStopActivated: boolean;
  trailingStopPrice: number;
  /** target1 부분익절 완료 여부 */
  partialExitDone: boolean;
  /** 포지션 라이프사이클 단계 */
  positionPhase: PositionPhase;
  indicators: SwingIndicators;
  config: {
    principal: number;
    profitPercent: number;
    stopLossPercent: number;
    trailingStopPercent: number;
    maxAdditionalBuys: number;
    additionalBuyDropPercent: number;
  };
  cycleNumber: number;
}

// ==================== 일봉 지표 계산 ====================

export interface DailyBar {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

/**
 * ATR (Average True Range) 계산 — 변동성 기반 동적 기준에 사용
 */
function calculateATR(bars: DailyBar[], period: number): number | null {
  if (bars.length < period + 1) return null;
  const trValues: number[] = [];
  for (let i = 1; i < bars.length; i++) {
    const high = bars[i].high;
    const low = bars[i].low;
    const prevClose = bars[i - 1].close;
    const tr = Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose));
    trValues.push(tr);
  }
  // EMA 방식 ATR
  if (trValues.length < period) return null;
  let atr = trValues.slice(0, period).reduce((a, b) => a + b, 0) / period;
  const k = 2 / (period + 1);
  for (let i = period; i < trValues.length; i++) {
    atr = trValues[i] * k + atr * (1 - k);
  }
  return atr;
}

/**
 * 일봉 데이터로 스윙 지표 계산
 */
export function calculateSwingIndicators(
  bars: DailyBar[],
  currentPrice: number,
): Omit<SwingIndicators, 'ema20_5m' | 'rsi14_5m'> {
  const closes = bars.map(b => b.close);
  const volumes = bars.map(b => b.volume);

  const ema5 = calculateEMA(closes, 5);
  const ema20 = calculateEMA(closes, 20);
  const ema60 = calculateEMA(closes, 60);
  const rsi14 = calculateRSI(closes, 14);

  const ema12 = calculateEMA(closes, 12);
  const ema26 = calculateEMA(closes, 26);
  let macd: number | null = null;
  let macdSignal: number | null = null;
  let macdHist: number | null = null;

  if (ema12 !== null && ema26 !== null) {
    macd = ema12 - ema26;
    const macdValues = calculateMACDSeries(closes, 12, 26);
    if (macdValues.length >= 9) {
      macdSignal = calculateEMA(macdValues, 9);
      if (macdSignal !== null) {
        macdHist = macd - macdSignal;
      }
    }
  }

  const recentVolumes = volumes.slice(-20);
  const avgVolume20 = recentVolumes.length >= 20
    ? recentVolumes.reduce((a, b) => a + b, 0) / recentVolumes.length
    : null;
  const dailyVolume = volumes.length > 0 ? volumes[volumes.length - 1] : 0;

  const atr14 = calculateATR(bars, 14);

  return {
    ema5, ema20, ema60, rsi14,
    macd, macdSignal, macdHist,
    currentPrice, dailyVolume, avgVolume20,
    tradingValue: null, atr14,
  };
}

function calculateMACDSeries(closes: number[], fast: number, slow: number): number[] {
  if (closes.length < slow) return [];
  const result: number[] = [];
  const kFast = 2 / (fast + 1);
  const kSlow = 2 / (slow + 1);
  let emaFast = closes.slice(0, fast).reduce((a, b) => a + b, 0) / fast;
  let emaSlow = closes.slice(0, slow).reduce((a, b) => a + b, 0) / slow;
  for (let i = fast; i < slow; i++) {
    emaFast = closes[i] * kFast + emaFast * (1 - kFast);
  }
  for (let i = slow; i < closes.length; i++) {
    emaFast = closes[i] * kFast + emaFast * (1 - kFast);
    emaSlow = closes[i] * kSlow + emaSlow * (1 - kSlow);
    result.push(emaFast - emaSlow);
  }
  return result;
}

// ==================== 4단계 진입 판단 ====================

/** 진입 실행 계획 — shouldBuy 이후 어떻게 진입할지 결정 */
export type EntryOrderType = 'MARKET' | 'LIMIT' | 'SKIP';

export interface EntryPlan {
  orderType: EntryOrderType;
  /** LIMIT일 때 지정가 (Stage 1) */
  limitPrice?: number;
  /** Stage 2 fallback 가격 (Day 1 미체결 시 conditional MOC/LOC) */
  fallbackPrice?: number;
  /** fallback 허용 조건: acceptance 최소값 */
  fallbackMinAcceptance?: number;
  /** SKIP일 때 사유 */
  skipReason?: string;
  /** zone-aware risk multiplier (기본 1.0, 이른 진입은 0.5~0.75) */
  riskMultiplier?: number;
  /** 진입 zone 식별자 */
  zoneLabel?: string;
}

export interface SwingEntryResult {
  shouldBuy: boolean;
  pullbackState: SwingPullbackState;
  readinessScore: number;           // 총점 (0~100)
  trendScore: number;               // A. 추세 점수 (0~30)
  pullbackScore: number;            // B. 조정 점수 (0~30)
  supportScore: number;             // C. 지지 점수 (0~20)
  triggerScore: number;             // D. 트리거 점수 (0~20)
  confluenceBonus: number;          // 지지 겹침 보너스
  positiveSignals: string[];
  negativeSignals: string[];
  /** 트리거 필수조건 충족 여부 (구조적 돌파 1개+) */
  triggerRequired: boolean;
  /** 트리거 보조조건 충족 수 (2개+ 필요) */
  triggerSupportingCount: number;
  invalidated: boolean;
  invalidReason?: string;
  reason: string;
  suggestedPrice?: number;
  suggestedQuantity?: number;
  /** 축별 최소점수 미달 시 true — 총점이 높아도 ENTRY_SIGNAL 금지 */
  axisFloorFailed: boolean;
  /** Active Swing 기준점 */
  activeSwing?: ActiveSwing;
  /** Execution Gate (점수와 분리된 실행 판단) */
  executionGate?: ExecutionGate;
  /** 진입 실행 계획 */
  entryPlan?: EntryPlan;
  /** 구조적 좌표계 (3-tier stop 포함) */
  swingContext?: SwingContext;
}

/**
 * 스윙 진입 조건 판단 — 4단계 평가
 *
 * 1. 추세 적합성 (30점) — 상승 추세 유지 여부
 * 2. 조정 적합성 (30점) — 건강한 눌림 vs 붕괴성 하락
 * 3. 지지 구간 유지 (20점) — 의미 있는 지지에서 버팀
 * 4. 반등 트리거 (20점) — 실제 반등 시작 신호
 *
 * @param dailyBars 일봉 배열 (오래된 것부터, 최소 60개)
 */
export function calculateSwingEntry(
  state: SwingState,
  indicators: SwingIndicators,
  dailyBars: DailyBar[],
  tickerConfig: SwingTickerConfig,
  holdingCount: number,
  maxPositions: number,
  marketContext?: MarketContext,
  isNearClose: boolean = false,
): SwingEntryResult {
  const empty: SwingEntryResult = {
    shouldBuy: false,
    pullbackState: 'HARD_INVALIDATED',
    readinessScore: 0,
    trendScore: 0, pullbackScore: 0, supportScore: 0, triggerScore: 0,
    confluenceBonus: 0,
    positiveSignals: [], negativeSignals: [],
    triggerRequired: false, triggerSupportingCount: 0,
    invalidated: true, invalidReason: '',
    reason: '',
    axisFloorFailed: false,
  };

  // 사전 체크
  if (holdingCount >= maxPositions) {
    return { ...empty, invalidReason: `max_positions (${maxPositions})` };
  }
  if (dailyBars.length < 60) {
    return { ...empty, invalidReason: `insufficient_bars (${dailyBars.length})` };
  }

  const { ema5, ema20, ema60, rsi14, currentPrice } = indicators;
  if (ema5 === null || ema20 === null || ema60 === null || rsi14 === null) {
    return { ...empty, invalidReason: 'insufficient_indicator_data' };
  }

  const positiveSignals: string[] = [];
  const negativeSignals: string[] = [];

  // ===== 무효화 조건 먼저 체크 (3단계: HARD / SOFT / WARNING) =====
  const invalidResult = checkInvalidation(dailyBars, indicators, currentPrice, ema20, ema60, state.pullbackState);
  if (invalidResult.level === 'HARD') {
    return {
      ...empty,
      pullbackState: 'HARD_INVALIDATED',
      negativeSignals: invalidResult.reasons,
      invalidReason: invalidResult.reasons.join(', '),
    };
  }
  if (invalidResult.level === 'SOFT') {
    // SOFT 무효화 → 회복 조건 충족 여부 확인
    const recovering = checkRecovery(dailyBars, indicators, currentPrice, ema20);
    const pullbackState: SwingPullbackState = recovering ? 'RECOVERING' : 'SOFT_INVALIDATED';
    return {
      ...empty,
      pullbackState,
      negativeSignals: invalidResult.reasons,
      invalidReason: invalidResult.reasons.join(', '),
      invalidated: !recovering,
      positiveSignals: recovering ? ['recovery_detected'] : [],
    };
  }
  negativeSignals.push(...invalidResult.warnings);

  // ===== 시장 방향 필터 =====
  const marketFilter = evaluateMarketContext(marketContext);
  negativeSignals.push(...marketFilter.warnings);
  if (marketFilter.blockEntry) {
    return {
      ...empty,
      pullbackState: 'SOFT_INVALIDATED',
      negativeSignals: marketFilter.warnings,
      invalidReason: 'market_crash_block',
      invalidated: true,
    };
  }

  // ===== 유동성 필터 =====
  const liquidityFilter = evaluateLiquidity(indicators.tradingValue);
  negativeSignals.push(...liquidityFilter.warnings);
  if (liquidityFilter.blockEntry) {
    return {
      ...empty,
      pullbackState: 'SOFT_INVALIDATED',
      negativeSignals: liquidityFilter.warnings,
      invalidReason: 'insufficient_liquidity',
      invalidated: true,
    };
  }

  // ===== 이벤트성 급등 종목 감점 =====
  const surgeResult = checkEventSurge(dailyBars);
  negativeSignals.push(...surgeResult.warnings);

  // ===== Active Swing 탐지 (점수 평가 이전에 계산) =====
  const activeSwing = detectActiveSwing(dailyBars, indicators);
  const swingCtx = buildSwingContext(activeSwing, currentPrice, dailyBars, indicators.atr14);

  // ===== 1단계: 추세 적합성 (30점) =====
  const trend = evaluateTrend(dailyBars, indicators, currentPrice, ema5, ema20, ema60);
  positiveSignals.push(...trend.signals);
  negativeSignals.push(...trend.warnings);

  // ===== 첫 눌림목 가점 / 반복 눌림 감점 =====
  const pullbackOrdinal = activeSwing ? activeSwing.pullbackCount : countPullbacksSinceBreakout(dailyBars);

  // ===== 2단계: 조정 적합성 (30점) =====
  const pullback = evaluatePullback(dailyBars, indicators, swingCtx);
  positiveSignals.push(...pullback.signals);
  negativeSignals.push(...pullback.warnings);
  // 첫 눌림목 가점
  if (pullbackOrdinal === 1) {
    pullback.score = Math.min(pullback.score + 3, 30);
    positiveSignals.push('first_pullback_bonus');
  } else if (pullbackOrdinal >= 3) {
    pullback.score = Math.max(pullback.score - 3, 0);
    negativeSignals.push(`${pullbackOrdinal}th_pullback_penalty`);
  }

  // ===== 3단계: 지지 구간 유지 (20점) =====
  const support = evaluateSupport(dailyBars, indicators, currentPrice, ema20, ema60, swingCtx);
  positiveSignals.push(...support.signals);
  negativeSignals.push(...support.warnings);

  // ===== 지지 겹침(confluence) 보너스 =====
  const confluenceBonus = calculateConfluenceBonus(support.signals);
  positiveSignals.push(...(confluenceBonus > 0 ? [`confluence_+${confluenceBonus}`] : []));

  // ===== 4단계: 반등 트리거 (필수조건 + 보조조건) =====
  const trigger = evaluateTrigger(dailyBars, indicators, currentPrice, ema20, swingCtx);
  positiveSignals.push(...trigger.signals);
  negativeSignals.push(...trigger.warnings);

  // 이벤트성 급등 감점 적용
  const surgePenalty = surgeResult.penalty;

  // ===== 총점 계산 (band-pass scoring refactor) =====
  // trigger: sufficiency gate + extension penalty — 높은 trigger는 chasing 성격
  const triggerEffective = trigger.score <= 14
    ? trigger.score
    : 14 - (trigger.score - 14) * 0.3; // 14 이상 소폭 감점

  // trend: extreme high cap — 27+ 과열 신호
  const trendEffective = trend.score <= 27
    ? trend.score
    : 27 - (trend.score - 27) * 0.2; // 27 초과 시 미미한 감점

  // support: extreme high (>17)일 때 diminishing return
  const supportEffective = support.score <= 17
    ? support.score
    : 17 + (support.score - 17) * 0.7; // 초과분 70% 반영

  const rawScore = trendEffective + pullback.score + supportEffective + triggerEffective + confluenceBonus;
  const totalPenalty = surgePenalty + marketFilter.penalty + liquidityFilter.penalty;
  const totalScore = Math.max(rawScore - totalPenalty, 0);

  // 시장 약세 시 진입 임계값 상향
  const entryThreshold = marketFilter.raiseThreshold ? 70 : 65;

  // ===== 상태 결정 (히스테리시스 적용) =====
  // 진입 임계값 ≠ 이탈 임계값: 상위 상태 유지 시 더 관대한 기준 적용
  const prevState = state.pullbackState || 'TRENDING';
  const stateRank: Record<SwingPullbackState, number> = {
    'HARD_INVALIDATED': 0, 'SOFT_INVALIDATED': 1, 'RECOVERING': 2,
    'TRENDING': 3, 'PULLBACK_FORMING': 4, 'SUPPORT_TEST': 5,
    'READY_TO_TRIGGER': 6, 'ENTRY_SIGNAL': 7,
  };
  const prevRank = stateRank[prevState];

  // 기본 상태 산출 (진입 기준)
  let candidateState: SwingPullbackState;
  if (trend.score < 10) {
    candidateState = 'SOFT_INVALIDATED';
  } else if (pullback.score < 5) {
    candidateState = 'TRENDING';
  } else if (support.score < 5) {
    candidateState = 'PULLBACK_FORMING';
  } else if (!trigger.requiredMet || trigger.supportingCount < 2) {
    candidateState = support.score >= 12 ? 'READY_TO_TRIGGER' : 'SUPPORT_TEST';
  } else {
    candidateState = totalScore >= entryThreshold ? 'ENTRY_SIGNAL' : 'READY_TO_TRIGGER';
  }
  const candidateRank = stateRank[candidateState];

  // 히스테리시스: 하향 전이 시 이탈 기준을 더 관대하게 적용
  let pullbackState: SwingPullbackState;
  if (candidateRank >= prevRank) {
    // 상향 또는 동일 — 즉시 적용
    pullbackState = candidateState;
  } else {
    // 하향 전이 — 이탈 기준 적용 (더 관대한 임계값)
    // 예: READY_TO_TRIGGER 유지 시 support 3+ 허용 (진입은 5+)
    //     SUPPORT_TEST 유지 시 pullback 3+ 허용 (진입은 5+)
    if (prevState === 'ENTRY_SIGNAL' && totalScore >= entryThreshold - 5 && trigger.requiredMet) {
      pullbackState = 'ENTRY_SIGNAL'; // 5점 버퍼
    } else if (prevState === 'READY_TO_TRIGGER' && support.score >= 3 && trend.score >= 8) {
      pullbackState = 'READY_TO_TRIGGER';
    } else if (prevState === 'SUPPORT_TEST' && pullback.score >= 3 && trend.score >= 8) {
      pullbackState = 'SUPPORT_TEST';
    } else if (prevState === 'PULLBACK_FORMING' && trend.score >= 8) {
      pullbackState = 'PULLBACK_FORMING';
    } else {
      pullbackState = candidateState; // 이탈 기준도 미달 → 실제 하향 전이
    }
  }

  // ===== 축별 최소 점수 체크 (Threshold Floor) =====
  // 총점이 높아도 핵심 축이 빈약하면 매수 금지
  const AXIS_FLOORS = { trend: 12, pullback: 8, support: 6 };
  const axisFloorFailed =
    trend.score < AXIS_FLOORS.trend
    || pullback.score < AXIS_FLOORS.pullback
    || support.score < AXIS_FLOORS.support;

  if (axisFloorFailed) {
    const failedAxes: string[] = [];
    if (trend.score < AXIS_FLOORS.trend) failedAxes.push(`trend(${trend.score}<${AXIS_FLOORS.trend})`);
    if (pullback.score < AXIS_FLOORS.pullback) failedAxes.push(`pullback(${pullback.score}<${AXIS_FLOORS.pullback})`);
    if (support.score < AXIS_FLOORS.support) failedAxes.push(`support(${support.score}<${AXIS_FLOORS.support})`);
    negativeSignals.push(`axis_floor_fail:${failedAxes.join(',')}`);
    // ENTRY_SIGNAL이었어도 READY_TO_TRIGGER로 강등
    if (pullbackState === 'ENTRY_SIGNAL') {
      pullbackState = 'READY_TO_TRIGGER';
    }
  }

  // ===== Execution Gate (점수와 분리된 실행 판단) =====
  const executionGate = evaluateExecutionGate(
    activeSwing, currentPrice,
    liquidityFilter.blockEntry,
    marketFilter.blockEntry,
    isNearClose,
    swingCtx,
  );

  // ===== 매수 판정 — 2단계: 셋업 품질 + 실행 가능 =====
  // Completion-Trigger maturity 연동: completion 강도에 따라 trigger 요구 수준 조절
  const completionStrong = activeSwing?.pullbackComplete === true
    && swingCtx.inSupportZone
    && (swingCtx.retracementDepth !== null && swingCtx.retracementDepth >= 0.25 && swingCtx.retracementDepth <= 0.50);

  // completion이 강하면 trigger 요구 완화 (필수 1개 + 보조 1개), 약하면 엄격 (필수 1개 + 보조 2개 + score 8+)
  const triggerQualified = completionStrong
    ? (trigger.requiredMet && trigger.supportingCount >= 1)
    : (trigger.requiredMet && trigger.supportingCount >= 2 && trigger.score >= 8);

  // 1단계: 셋업 품질 (기존 점수 기반 + maturity 연동)
  const setupQualified =
    pullbackState === 'ENTRY_SIGNAL'
    && totalScore >= entryThreshold
    && triggerQualified
    && !axisFloorFailed;

  // 2단계: 실행 가능 (Execution Gate 통과)
  const shouldBuy = setupQualified && executionGate.executable;

  if (setupQualified && !executionGate.executable) {
    negativeSignals.push(`exec_blocked:${executionGate.blockReasons.join(',')}`);
  }

  // 수량 계산 — risk-based sizing
  // positionSize = riskBudget / (entry - initialTradeStop), max notional cap
  let suggestedQuantity: number | undefined;
  if (shouldBuy) {
    const maxNotional = tickerConfig.principal / (tickerConfig.maxAdditionalBuys + 1);
    if (swingCtx.initialTradeStop != null && swingCtx.rrTrade) {
      const riskPerShare = swingCtx.rrTrade.riskDistance;
      // riskBudget = 원금의 2% (1종목당 최대 허용 손실)
      const riskBudget = tickerConfig.principal * 0.02;
      const riskBasedQty = Math.floor(riskBudget / riskPerShare);
      const maxQty = Math.floor(maxNotional / currentPrice);
      suggestedQuantity = Math.min(riskBasedQty, maxQty);
      suggestedQuantity = Math.max(suggestedQuantity, 1); // 최소 1주
    } else {
      // fallback: 고정 금액 기반
      suggestedQuantity = Math.floor(maxNotional / currentPrice);
    }
  }

  // ===== EntryPlan 결정 — premiumATR 5-zone band-pass + acceptanceScore =====
  // Zone 1a: premATR 0~0.3 → 매우 이른 구간. strong acceptance에서만 LIMIT + 0.5x risk
  // Zone 1b: premATR 0.3~0.5 → 이른 구간. acceptance >= 60이면 LIMIT + 0.75x risk
  // Zone 2:  premATR 0.5~1.0 → sweet spot. LIMIT 기본, full risk
  // Zone 3:  premATR 1.0~1.25 → late zone. strong case만 LIMIT + reduced risk
  // Zone 4:  premATR > 1.25 → chase. SKIP
  let entryPlan: EntryPlan | undefined;
  if (shouldBuy && swingCtx.activeSwing) {
    const riskATR = swingCtx.tradeRiskATR;
    const premATR = swingCtx.premiumATR;
    const acceptance = swingCtx.acceptanceScore;
    const atr = indicators.atr14 ?? currentPrice * 0.02;

    // ===== D-confirmed: Stage1-only zone-adaptive LIMIT =====
    // zone별 차등 LIMIT 가격, 미체결 시 만료 (no chase, no fallback)
    //   early zone → support 기반
    //   sweet spot → currentClose - 0.3×ATR (소폭 할인)
    //   late zone  → currentClose - 0.5×ATR (큰 할인)
    // 실전 운영: 전일 장마감 후 setup → 다음날 LIMIT → 당일 미체결 시 취소 → 재평가
    const supportLimitPrice = Math.round(swingCtx.activeSwing.supportZone.upper * 1.003);
    const sweetSpotLimitPrice = Math.round(currentPrice - atr * 0.3);
    const lateLimitPrice = Math.round(currentPrice - atr * 0.5);

    if (riskATR !== null && premATR !== null) {
      // riskATR 절대 상한 유지
      if (riskATR > 3.5) {
        entryPlan = { orderType: 'SKIP', skipReason: `riskATR_${riskATR.toFixed(1)}` };
      } else if (premATR > 1.25) {
        // Zone 4: chase → SKIP
        entryPlan = { orderType: 'SKIP', skipReason: `chase_premATR_${premATR.toFixed(2)}` };
      } else if (premATR > 1.0) {
        // Zone 3: late → strong case만 LIMIT(close-0.5ATR) + reduced risk
        const strongCase = support.score >= 13 && swingCtx.activeSwing.confidence >= 0.7
          && acceptance >= 50;
        if (strongCase) {
          entryPlan = {
            orderType: 'LIMIT',
            limitPrice: Math.min(lateLimitPrice, currentPrice),
            riskMultiplier: 0.75,
            zoneLabel: 'zone3_late',
          };
        } else {
          entryPlan = { orderType: 'SKIP', skipReason: `late_premATR_${premATR.toFixed(2)}_acc${acceptance}` };
        }
      } else if (premATR >= 0.5) {
        // Zone 2: sweet spot → LIMIT(close-0.3ATR) + full risk
        entryPlan = {
          orderType: 'LIMIT',
          limitPrice: Math.min(sweetSpotLimitPrice, currentPrice),
          riskMultiplier: 1.0,
          zoneLabel: 'zone2_sweet',
        };
      } else if (premATR >= 0.3) {
        // Zone 1b: 이른 구간 → support 기반 LIMIT
        if (acceptance >= 60) {
          entryPlan = {
            orderType: 'LIMIT',
            limitPrice: Math.min(supportLimitPrice, currentPrice),
            riskMultiplier: 0.75,
            zoneLabel: 'zone1b_early',
          };
        } else {
          entryPlan = { orderType: 'SKIP', skipReason: `early_premATR_${premATR.toFixed(2)}_acc${acceptance}` };
        }
      } else {
        // Zone 1a: premATR < 0.3 → support 기반 LIMIT + fallback 없음
        if (acceptance >= 75) {
          entryPlan = {
            orderType: 'LIMIT',
            limitPrice: Math.min(supportLimitPrice, currentPrice),
            riskMultiplier: 0.5,
            zoneLabel: 'zone1a_veryEarly',
          };
        } else {
          entryPlan = { orderType: 'SKIP', skipReason: `veryEarly_premATR_${premATR.toFixed(2)}_acc${acceptance}` };
        }
      }
    } else {
      // riskATR/premiumATR 계산 불가 시 fallback
      const distToSupport = swingCtx.distToSupportLower;
      if (distToSupport !== null && distToSupport > 0.03) {
        entryPlan = { orderType: 'SKIP', skipReason: `dist_to_support_${(distToSupport * 100).toFixed(1)}pct` };
      } else {
        entryPlan = {
          orderType: 'LIMIT',
          limitPrice: Math.min(supportLimitPrice, currentPrice),
          riskMultiplier: 0.75,
          zoneLabel: 'fallback',
        };
      }
    }
  } else if (shouldBuy) {
    entryPlan = { orderType: 'LIMIT', limitPrice: currentPrice, riskMultiplier: 0.75, zoneLabel: 'noSwing' };
  }

  return {
    shouldBuy,
    pullbackState,
    readinessScore: Math.min(totalScore, 100),
    trendScore: trend.score,
    pullbackScore: pullback.score,
    supportScore: support.score,
    triggerScore: trigger.score,
    confluenceBonus,
    positiveSignals,
    negativeSignals,
    triggerRequired: trigger.requiredMet,
    triggerSupportingCount: trigger.supportingCount,
    invalidated: false,
    reason: positiveSignals.join(', '),
    suggestedPrice: shouldBuy ? currentPrice : undefined,
    suggestedQuantity,
    axisFloorFailed,
    activeSwing: activeSwing || undefined,
    executionGate,
    entryPlan,
    swingContext: swingCtx,
  };
}

// ==================== SwingContext 빌드 ====================

/**
 * Active Swing + 현재가로부터 모든 평가 축이 참조할 구조적 좌표계를 빌드
 */
function buildSwingContext(
  activeSwing: ActiveSwing | null,
  currentPrice: number,
  bars?: DailyBar[],
  atr14?: number | null,
): SwingContext {
  if (!activeSwing) {
    return {
      activeSwing: null,
      retracementDepth: null,
      inSupportZone: false,
      distToSupportLower: null,
      aboveBreakout: false,
      rr: null,
      initialTradeStop: null,
      thesisInvalidation: null,
      rrTrade: null,
      tradeRiskPct: null,
      tradeRiskATR: null,
      premiumATR: null,
      acceptanceScore: 0,
    };
  }

  const swingRange = activeSwing.anchorHigh - activeSwing.anchorLow;
  const retracementDepth = swingRange > 0
    ? (activeSwing.anchorHigh - currentPrice) / swingRange
    : null;

  const inSupportZone = currentPrice >= activeSwing.supportZone.lower * 0.99
    && currentPrice <= activeSwing.supportZone.upper * 1.01;

  const distToSupportLower = activeSwing.supportZone.lower > 0
    ? (currentPrice - activeSwing.supportZone.lower) / activeSwing.supportZone.lower
    : null;

  const aboveBreakout = currentPrice >= activeSwing.breakoutLevel * 0.997;

  // thesis invalidation R:R (context 용)
  const rr = calculateRiskReward(currentPrice, activeSwing);

  // ===== 3-tier stop 계산 =====
  const thesisInvalidation = activeSwing.invalidationLevel;

  // initialTradeStop: local structure 기반
  const atrBuffer = (atr14 && atr14 > 0) ? atr14 * 0.5 : currentPrice * 0.01;
  const stopCandidates: number[] = [];

  // 후보 1: supportZone.lower - ATR buffer
  if (activeSwing.supportZone.lower > 0) {
    stopCandidates.push(activeSwing.supportZone.lower - atrBuffer);
  }

  // 후보 2: breakout reclaim failure — breakoutLevel - ATR buffer
  if (activeSwing.breakoutLevel > 0 && activeSwing.breakoutLevel < currentPrice) {
    stopCandidates.push(activeSwing.breakoutLevel - atrBuffer);
  }

  // 후보 3: 최근 pullback pivot low - ATR buffer (최근 20일 내)
  if (bars && bars.length >= 10) {
    const recentBars = bars.slice(-20);
    let recentPivotLow = Infinity;
    for (let i = 2; i < recentBars.length - 2; i++) {
      const low = recentBars[i].low;
      if (low < recentBars[i - 1].low && low < recentBars[i - 2].low
        && low < recentBars[i + 1].low && low < recentBars[i + 2].low) {
        // 현재가보다 아래에 있는 가장 가까운 pivot low
        if (low < currentPrice && low > recentPivotLow * 0.95) {
          recentPivotLow = Math.max(recentPivotLow, low); // 가장 가까운 것 선택
        } else if (low < currentPrice && recentPivotLow === Infinity) {
          recentPivotLow = low;
        }
      }
    }
    if (recentPivotLow < Infinity) {
      stopCandidates.push(recentPivotLow - atrBuffer);
    }
  }

  // 유효한 후보 중 현재가보다 아래 & 가장 가까운 것 선택
  const validStops = stopCandidates.filter(s => s > 0 && s < currentPrice);
  const initialTradeStop = validStops.length > 0
    ? Math.max(...validStops)  // 가장 가까운(높은) stop = 가장 타이트한
    : null;

  // initialTradeStop 기준 R:R
  let rrTrade: SwingContext['rrTrade'] = null;
  let tradeRiskPct: number | null = null;
  let tradeRiskATR: number | null = null;

  if (initialTradeStop !== null) {
    const riskDist = Math.max(currentPrice - initialTradeStop, currentPrice * 0.005); // 최소 0.5%
    const reward1Dist = Math.max(activeSwing.target1 - currentPrice, 0);
    const reward2Dist = Math.max(activeSwing.target2 - currentPrice, 0);
    rrTrade = {
      rr1: reward1Dist / riskDist,
      rr2: reward2Dist / riskDist,
      riskDistance: riskDist,
      reward1Distance: reward1Dist,
    };
    tradeRiskPct = riskDist / currentPrice;
    tradeRiskATR = (atr14 && atr14 > 0) ? riskDist / atr14 : null;
  }

  // premiumATR: fair entry 대비 현재가 프리미엄 (ATR 배수)
  // fairEntryRef = supportZone.upper 또는 breakoutLevel 중 현재가에 더 가까운 쪽
  let premiumATR: number | null = null;
  if (atr14 && atr14 > 0) {
    const fairCandidates: number[] = [];
    if (activeSwing.supportZone.upper > 0) fairCandidates.push(activeSwing.supportZone.upper);
    if (activeSwing.breakoutLevel > 0 && activeSwing.breakoutLevel < currentPrice) {
      fairCandidates.push(activeSwing.breakoutLevel);
    }
    if (fairCandidates.length > 0) {
      // 현재가 아래에서 가장 가까운 fair entry ref
      const belowCandidates = fairCandidates.filter(c => c <= currentPrice);
      const fairEntryRef = belowCandidates.length > 0
        ? Math.max(...belowCandidates)
        : Math.min(...fairCandidates); // 모두 위이면 가장 가까운 것
      premiumATR = (currentPrice - fairEntryRef) / atr14;
    }
  }

  // ===== acceptanceScore: 지지 zone 수용 정도 =====
  // 낮은 premiumATR 구간에서 "아직 수용이 끝나지 않은 진입"을 걸러내기 위한 점수
  let acceptanceScore = 0;
  if (bars && bars.length >= 5 && activeSwing) {
    const recentBars = bars.slice(-5);
    const zoneMid = (activeSwing.supportZone.upper + activeSwing.supportZone.lower) / 2;

    // (1) No new low in 3 bars: 최근 3봉이 직전 5봉 저점 위에 있으면 +25
    const last3Lows = recentBars.slice(-3).map(b => b.low);
    const prior2Low = Math.min(recentBars[0].low, recentBars[1].low);
    if (Math.min(...last3Lows) >= prior2Low * 0.998) {
      acceptanceScore += 25;
    }

    // (2) CLV 개선: 최근 봉의 CLV > 0 (종가가 봉 상단 쪽) → +25
    const lastBar = recentBars[recentBars.length - 1];
    const barRange = lastBar.high - lastBar.low;
    if (barRange > 0) {
      const clv = (2 * lastBar.close - lastBar.high - lastBar.low) / barRange;
      if (clv > 0) acceptanceScore += 25;
      else if (clv > -0.2) acceptanceScore += 10;
    }

    // (3) Close above zone mid: 종가가 zone 중간 위에 있으면 +25
    if (lastBar.close >= zoneMid) {
      acceptanceScore += 25;
    }

    // (4) Downside volume drying: 최근 음봉 거래량이 양봉 대비 감소 → +25
    const downBars = recentBars.filter(b => b.close < b.open);
    const upBars = recentBars.filter(b => b.close >= b.open);
    if (upBars.length > 0 && downBars.length > 0) {
      const avgDownVol = downBars.reduce((s, b) => s + b.volume, 0) / downBars.length;
      const avgUpVol = upBars.reduce((s, b) => s + b.volume, 0) / upBars.length;
      if (avgDownVol < avgUpVol * 0.8) {
        acceptanceScore += 25;
      } else if (avgDownVol < avgUpVol * 1.0) {
        acceptanceScore += 10;
      }
    } else if (downBars.length === 0) {
      // 최근 5봉 전부 양봉 → 강한 수용
      acceptanceScore += 25;
    }
  }

  return {
    activeSwing,
    retracementDepth,
    inSupportZone,
    distToSupportLower,
    aboveBreakout,
    rr,
    initialTradeStop,
    thesisInvalidation,
    rrTrade,
    tradeRiskPct,
    tradeRiskATR,
    premiumATR,
    acceptanceScore,
  };
}

// ==================== Active Swing 탐지 ====================

/**
 * 실제 스윙 포인트를 탐지하여 Active Swing 객체를 생성
 *
 * 복수 피벗 고점 후보 수집 → prominence/volume/recency 기반으로
 * 가장 의미 있는 active swing을 선택
 */
export function detectActiveSwing(
  bars: DailyBar[],
  indicators: SwingIndicators,
): ActiveSwing | null {
  if (bars.length < 30) return null;

  const pivotRadius = 3;

  // === 1단계: 피벗 고점 후보 수집 (최근 60일 내) ===
  interface PivotCandidate {
    idx: number;
    price: number;
    prominence: number; // 주변 대비 돌출도
    volumeRatio: number; // 평균 거래량 대비
    recency: number; // 최근일수록 높음 (0~1)
    score: number;
  }
  const pivotHighCandidates: PivotCandidate[] = [];
  const searchFrom = Math.max(pivotRadius, bars.length - 60);
  const avgVol20 = indicators.avgVolume20 || 1;

  for (let i = searchFrom; i < bars.length - pivotRadius; i++) {
    let isPivotHigh = true;
    for (let j = 1; j <= pivotRadius; j++) {
      if (bars[i].high <= bars[i - j].high || bars[i].high <= bars[i + j].high) {
        isPivotHigh = false;
        break;
      }
    }
    if (!isPivotHigh) continue;

    // prominence: 양쪽 10일 내 최저 high 대비 돌출도
    const leftMin = Math.min(...bars.slice(Math.max(0, i - 10), i).map(b => b.high));
    const rightMin = Math.min(...bars.slice(i + 1, Math.min(bars.length, i + 11)).map(b => b.high));
    const prominence = (bars[i].high - Math.max(leftMin, rightMin)) / bars[i].high;

    // volume: 해당 일 거래량 / 20일 평균
    const volumeRatio = bars[i].volume / avgVol20;

    // recency: 1.0(오늘) ~ 0.0(60일 전)
    const daysAgo = bars.length - 1 - i;
    const recency = Math.max(0, 1 - daysAgo / 60);

    // 종합 점수: prominence 40% + volume 25% + recency 35%
    const score = (Math.min(prominence / 0.05, 1) * 40)
      + (Math.min(volumeRatio / 2.0, 1) * 25)
      + (recency * 35);

    pivotHighCandidates.push({ idx: i, price: bars[i].high, prominence, volumeRatio, recency, score });
  }

  if (pivotHighCandidates.length === 0) return null;

  // 최고 점수 후보 선택
  pivotHighCandidates.sort((a, b) => b.score - a.score);
  const bestPivot = pivotHighCandidates[0];
  const anchorHighIdx = bestPivot.idx;
  const anchorHigh = bestPivot.price;

  // === 2단계: 앵커 저점 탐색 (고점 이전 40일 구간) ===
  let anchorLowIdx = -1;
  let anchorLow = Infinity;
  const searchStart = Math.max(0, anchorHighIdx - 40);

  for (let i = anchorHighIdx - 1; i >= searchStart; i--) {
    if (i < pivotRadius) break;
    let isPivotLow = true;
    for (let j = 1; j <= Math.min(pivotRadius, i); j++) {
      if (i + j >= bars.length) { isPivotLow = false; break; }
      if (bars[i].low >= bars[i - j].low || bars[i].low >= bars[i + j].low) {
        isPivotLow = false;
        break;
      }
    }
    if (isPivotLow && bars[i].low < anchorLow) {
      anchorLow = bars[i].low;
      anchorLowIdx = i;
    }
  }

  // 피벗 저점 못 찾으면 단순 최저점 사용
  if (anchorLowIdx < 0) {
    for (let i = searchStart; i < anchorHighIdx; i++) {
      if (bars[i].low < anchorLow) {
        anchorLow = bars[i].low;
        anchorLowIdx = i;
      }
    }
  }
  if (anchorLowIdx < 0 || anchorHigh <= anchorLow) return null;

  const swingRange = anchorHigh - anchorLow;

  // 돌파 기준선: 고점 이전의 저항선 (이전 20~40일 고점)
  const priorBars = bars.slice(Math.max(0, anchorLowIdx - 20), anchorLowIdx);
  const breakoutLevel = priorBars.length > 0
    ? Math.max(...priorBars.map(b => b.high))
    : anchorLow + swingRange * 0.382;

  // 지지 구간: MA20 / 피보 38.2~50% / 돌파 기준선의 클러스터
  const ema20 = indicators.ema20 || anchorLow + swingRange * 0.5;
  const fib382 = anchorHigh - swingRange * 0.382;
  const fib500 = anchorHigh - swingRange * 0.500;
  const supportCandidates = [ema20, fib382, fib500, breakoutLevel].filter(v => v > 0);
  const supportUpper = Math.max(...supportCandidates);
  const supportLower = Math.min(...supportCandidates);

  // 무효화 레벨: anchorLow 또는 피보 61.8% 중 높은 쪽
  const fib618 = anchorHigh - swingRange * 0.618;
  const invalidationLevel = Math.max(anchorLow, fib618);

  // 목표가
  const target1 = anchorHigh; // 1차: 직전 고점 retest
  const target2 = anchorHigh + swingRange * 0.618; // 2차: 측정 이동

  // 조정 횟수: 고점 이후 하락→반등 패턴 카운트
  let pullbackCount = 0;
  let inDip = false;
  for (let i = anchorHighIdx + 1; i < bars.length; i++) {
    if (!inDip && bars[i].close < anchorHigh * 0.97) {
      inDip = true;
      pullbackCount++;
    } else if (inDip && bars[i].close > bars[Math.max(anchorHighIdx, i - 3)].high) {
      inDip = false;
    }
  }

  // 조정 완료 확인 (higher low + no new low + range contraction)
  const pullbackComplete = checkPullbackCompletion(bars, anchorHighIdx);

  // confidence: 피벗 점수를 0~1로 정규화 (100점 만점 기준)
  const confidence = Math.min(bestPivot.score / 80, 1.0);

  return {
    anchorLow, anchorLowIdx,
    anchorHigh, anchorHighIdx,
    breakoutLevel,
    supportZone: { upper: supportUpper, lower: supportLower },
    invalidationLevel,
    target1, target2,
    pullbackCount: Math.max(pullbackCount, 1),
    pullbackComplete,
    confidence,
  };
}

// ==================== 조정 완료 확인 ====================

/**
 * 조정이 끝났는지 확인 — "반등했다" ≠ "조정이 끝났다"
 *
 * 구조: "구조적 저점 형성 1필수" + "안정화 증거 1선택"
 *
 * 필수 (1개 이상):
 *   A. Higher Low: 후반부 저점 > 전반부 저점
 *   B. Pivot Low: 최근에 전후 N일보다 낮은 피벗 저점 형성
 *
 * 안정화 증거 (1개 이상):
 *   1. No New Low: 최근 2일간 저점 갱신 없음
 *   2. Range Contraction: 최근 음봉 크기 축소
 *   3. CLV Improvement: 최근 3일 CLV가 이전보다 개선
 *   4. Downside Volume Drying: 하락일 거래량 감소
 */
function checkPullbackCompletion(bars: DailyBar[], peakIdx: number): boolean {
  const afterPeak = bars.slice(peakIdx + 1);
  if (afterPeak.length < 4) return false;

  // ===== 필수조건: 구조적 저점 형성 (1개 이상) =====
  let structuralLowFormed = false;

  // A. Higher Low: 후반부 저점 > 전반부 저점
  const halfLen = Math.floor(afterPeak.length / 2);
  if (halfLen >= 2) {
    const firstHalfLow = Math.min(...afterPeak.slice(0, halfLen).map(b => b.low));
    const secondHalfLow = Math.min(...afterPeak.slice(halfLen).map(b => b.low));
    if (secondHalfLow > firstHalfLow) {
      structuralLowFormed = true;
    }
  }

  // B. Pivot Low: 최근 구간에서 전후 2일보다 낮은 저점 형성
  if (!structuralLowFormed && afterPeak.length >= 5) {
    for (let i = 2; i < afterPeak.length - 2; i++) {
      const isPivot = afterPeak[i].low < afterPeak[i - 1].low
        && afterPeak[i].low < afterPeak[i - 2].low
        && afterPeak[i].low < afterPeak[i + 1].low
        && afterPeak[i].low < afterPeak[i + 2].low;
      if (isPivot) {
        structuralLowFormed = true;
        break;
      }
    }
  }

  // 필수조건 미충족 → 즉시 false
  if (!structuralLowFormed) return false;

  // ===== 안정화 증거 (1개 이상 필요) =====
  let stabilizationCount = 0;

  // 1. No New Low: 최근 2일간 저점 미갱신
  if (afterPeak.length >= 3) {
    const priorLow = Math.min(...afterPeak.slice(0, -2).map(b => b.low));
    const recent2Low = Math.min(...afterPeak.slice(-2).map(b => b.low));
    if (recent2Low >= priorLow) {
      stabilizationCount++;
    }
  }

  // 2. Range Contraction: 최근 음봉 크기가 초기 음봉보다 작아짐
  const bearishBars = afterPeak.filter(b => b.close < b.open);
  if (bearishBars.length >= 3) {
    const earlyBearish = bearishBars.slice(0, Math.ceil(bearishBars.length / 2));
    const lateBearish = bearishBars.slice(Math.ceil(bearishBars.length / 2));
    const earlyAvgBody = earlyBearish.reduce((s, b) => s + (b.open - b.close), 0) / earlyBearish.length;
    const lateAvgBody = lateBearish.length > 0
      ? lateBearish.reduce((s, b) => s + (b.open - b.close), 0) / lateBearish.length
      : earlyAvgBody;
    if (lateAvgBody < earlyAvgBody * 0.7) {
      stabilizationCount++;
    }
  }

  // 3. CLV Improvement: 최근 3일 평균 CLV > 이전 3일 평균 CLV
  if (afterPeak.length >= 6) {
    const calcAvgCLV = (slice: DailyBar[]) => {
      let sum = 0; let cnt = 0;
      for (const b of slice) {
        const range = b.high - b.low;
        if (range > 0) { sum += (b.close - b.low) / range; cnt++; }
      }
      return cnt > 0 ? sum / cnt : 0.5;
    };
    const prevCLV = calcAvgCLV(afterPeak.slice(-6, -3));
    const recentCLV = calcAvgCLV(afterPeak.slice(-3));
    if (recentCLV > prevCLV + 0.1) {
      stabilizationCount++;
    }
  }

  // 4. Downside Volume Drying: 하락일 거래량이 시간순으로 감소
  const bearishWithVol = afterPeak.filter(b => b.close < b.open);
  if (bearishWithVol.length >= 3) {
    const firstHalfBear = bearishWithVol.slice(0, Math.ceil(bearishWithVol.length / 2));
    const secondHalfBear = bearishWithVol.slice(Math.ceil(bearishWithVol.length / 2));
    const earlyAvgVol = firstHalfBear.reduce((s, b) => s + b.volume, 0) / firstHalfBear.length;
    const lateAvgVol = secondHalfBear.length > 0
      ? secondHalfBear.reduce((s, b) => s + b.volume, 0) / secondHalfBear.length
      : earlyAvgVol;
    if (lateAvgVol < earlyAvgVol * 0.7) {
      stabilizationCount++;
    }
  }

  return stabilizationCount >= 1;
}

// ==================== R:R 계산 ====================

/**
 * Risk:Reward 비율 계산
 * Risk = 진입가 → 실질 손절 (support cluster 하단 / invalidation level)
 * Reward = 진입가 → target1 (보수적), target2 (적극적)
 */
function calculateRiskReward(
  currentPrice: number,
  activeSwing: ActiveSwing,
): { rr1: number; rr2: number; riskDistance: number; reward1Distance: number } {
  // 실질 리스크: 지지 구간 하단 또는 무효화 레벨까지 거리
  const stopLevel = Math.max(activeSwing.supportZone.lower * 0.99, activeSwing.invalidationLevel);
  const riskDistance = Math.max(currentPrice - stopLevel, currentPrice * 0.01); // 최소 1%

  // 리워드: target1, target2까지 거리
  const reward1Distance = Math.max(activeSwing.target1 - currentPrice, 0);
  const reward2Distance = Math.max(activeSwing.target2 - currentPrice, 0);

  const rr1 = reward1Distance / riskDistance;
  const rr2 = reward2Distance / riskDistance;

  return { rr1, rr2, riskDistance, reward1Distance };
}

// ==================== Execution Gate ====================

/**
 * 점수 체계(셋업 품질)와 분리된 실행 가능 판단
 *
 * HARD veto (1개라도 미통과 → 즉시 차단):
 *   - completion 미확인
 *   - 유동성 부족
 *   - 시장 급락
 *   - 구조적 리스크 과다 (structural risk > max allowed)
 *   - 절대 R:R 하한 미달 (< 1.5)
 *
 * SOFT penalty (랭킹 감점, 차단은 아님):
 *   - 시간대 (장마감 전 아닌 경우)
 *   - R:R 중간 수준 (1.5~2.0)
 *   - 3차+ 눌림
 */
function evaluateExecutionGate(
  activeSwing: ActiveSwing | null,
  currentPrice: number,
  liquidityBlocked: boolean,
  marketBlocked: boolean,
  isNearClose: boolean,
  swingCtx?: SwingContext,
): ExecutionGate {
  const blockReasons: string[] = [];
  const softPenalties: string[] = [];
  let softPenaltyScore = 0;

  // === HARD GATES ===

  // H1. 조정 완료 확인 (HARD)
  const completionConfirmed = activeSwing?.pullbackComplete ?? false;
  if (!completionConfirmed) blockReasons.push('pullback_not_complete');

  // H2. 유동성 (HARD)
  const liquidityPassed = !liquidityBlocked;
  if (!liquidityPassed) blockReasons.push('liquidity_blocked');

  // H3. 시장 방향 (HARD)
  const marketPassed = !marketBlocked;
  if (!marketPassed) blockReasons.push('market_blocked');

  // H4. 리스크 + R:R — initialTradeStop 기준 (3-tier stop architecture)
  let structuralRiskPassed = true;
  let rrRatio = 0;
  let rrPassed = false;

  if (activeSwing && swingCtx?.initialTradeStop != null && swingCtx.rrTrade) {
    // === initialTradeStop 기준 execution 판단 ===
    rrRatio = swingCtx.rrTrade.rr1;
    const tradeRiskPct = swingCtx.tradeRiskPct ?? 0;
    const tradeRiskATR = swingCtx.tradeRiskATR;

    // ATR 계층화: 1~3 ATR 정상, 3~4 경고(soft), 4+ veto(hard)
    // % 상한: 8% (initialTradeStop은 local structure이므로 기존 5%보다 완화)
    const MAX_TRADE_RISK_PCT = 0.08;
    const MAX_TRADE_RISK_ATR = 4.0;

    if (tradeRiskPct > MAX_TRADE_RISK_PCT) {
      structuralRiskPassed = false;
      blockReasons.push(`trade_risk_${(tradeRiskPct * 100).toFixed(1)}pct`);
    } else if (tradeRiskATR !== null && tradeRiskATR > MAX_TRADE_RISK_ATR) {
      structuralRiskPassed = false;
      blockReasons.push(`trade_risk_${tradeRiskATR.toFixed(1)}ATR`);
    }

    // H5. R:R — initialTradeStop 기준
    if (rrRatio < 1.5) {
      rrPassed = false;
      blockReasons.push(`rr_too_low_${rrRatio.toFixed(1)}`);
    } else {
      rrPassed = rrRatio >= 2.0;
    }

    // ATR 3~4 범위 soft penalty
    if (tradeRiskATR !== null && tradeRiskATR > 3.0 && tradeRiskATR <= MAX_TRADE_RISK_ATR) {
      softPenalties.push(`risk_${tradeRiskATR.toFixed(1)}ATR_wide`);
      softPenaltyScore += 8;
    }

    // thesis invalidation 근접 시 soft warning
    if (swingCtx.thesisInvalidation != null) {
      const thesisDist = (currentPrice - swingCtx.thesisInvalidation) / currentPrice;
      if (thesisDist < 0.03) {
        softPenalties.push(`thesis_near_${(thesisDist * 100).toFixed(1)}pct`);
        softPenaltyScore += 5;
      }
    }
  } else if (activeSwing) {
    // fallback: swingCtx 없을 때 기존 방식
    const rr = calculateRiskReward(currentPrice, activeSwing);
    rrRatio = rr.rr1;
    const structuralRisk = rr.riskDistance / currentPrice;
    if (structuralRisk > 0.05) {
      structuralRiskPassed = false;
      blockReasons.push(`structural_risk_${(structuralRisk * 100).toFixed(1)}pct`);
    }
    if (rr.rr1 < 1.5) {
      blockReasons.push(`rr_too_low_${rr.rr1.toFixed(1)}`);
    } else {
      rrPassed = rr.rr1 >= 2.0;
    }
  } else {
    blockReasons.push('no_active_swing');
  }

  // === SOFT GATES (랭킹 감점) ===

  // S1. 시간대 (SOFT) — 장마감 전 아닌 경우 감점
  const timeGatePassed = isNearClose;
  if (!timeGatePassed) {
    softPenalties.push('before_market_close');
    softPenaltyScore += 15;
  }

  // S2. R:R 중간 수준 (SOFT) — 1.5~2.0은 감점만
  if (rrRatio >= 1.5 && rrRatio < 2.0) {
    softPenalties.push(`rr_moderate_${rrRatio.toFixed(1)}`);
    softPenaltyScore += 10;
  }

  // S3. 3차+ 눌림 (SOFT) — 감점만
  if (activeSwing && activeSwing.pullbackCount >= 3) {
    softPenalties.push(`${activeSwing.pullbackCount}th_pullback`);
    softPenaltyScore += 8;
  }

  // S4. 낮은 swing confidence (SOFT) — prominence/volume 약함
  if (activeSwing && activeSwing.confidence < 0.5) {
    softPenalties.push(`low_swing_confidence_${activeSwing.confidence.toFixed(2)}`);
    softPenaltyScore += 10;
  }

  const executable = blockReasons.length === 0;

  return {
    completionConfirmed,
    rrRatio,
    rrPassed,
    timeGatePassed,
    liquidityPassed,
    marketPassed,
    structuralRiskPassed,
    executable,
    blockReasons,
    softPenalties,
    softPenaltyScore,
  };
}

// ==================== 무효화 조건 (3단계: HARD / SOFT / WARNING) ====================

interface InvalidationResult {
  level: 'HARD' | 'SOFT' | 'NONE';
  reasons: string[];
  warnings: string[];
}

function checkInvalidation(
  bars: DailyBar[],
  indicators: SwingIndicators,
  price: number,
  ema20: number,
  ema60: number,
  prevPullbackState?: SwingPullbackState,
): InvalidationResult {
  const hardReasons: string[] = [];
  const softReasons: string[] = [];
  const warnings: string[] = [];
  const recent = bars.slice(-10);
  const avgVol = indicators.avgVolume20 || 1;

  // ===== HARD 무효화 조건 (즉시 제외, 재평가 금지) =====

  // H1. 대량거래 장대음봉 + 전저점 이탈 (복합)
  let hasLargeBearishCandle = false;
  for (let i = recent.length - 5; i < recent.length; i++) {
    if (i < 0) continue;
    const bar = recent[i];
    if (!bar) continue;
    const bodySize = Math.abs(bar.close - bar.open) / bar.open;
    const isBearish = bar.close < bar.open;
    if (isBearish && bodySize > 0.03 && bar.volume > avgVol * 1.5) {
      hasLargeBearishCandle = true;
      break;
    }
  }
  let priorLowBroken = false;
  if (bars.length >= 25) {
    const prior20Low = Math.min(...bars.slice(-25, -5).map(b => b.low));
    const recent5Low = Math.min(...bars.slice(-5).map(b => b.low));
    priorLowBroken = recent5Low < prior20Low * 0.99;
  }
  if (hasLargeBearishCandle && priorLowBroken) {
    hardReasons.push('large_bearish_candle_with_low_break');
  }

  // H2. 갭다운 후 2일 이상 회복 실패
  for (let i = bars.length - 4; i < bars.length - 1; i++) {
    if (i <= 0) continue;
    const prev = bars[i - 1];
    const gapBar = bars[i];
    const gapDown = (gapBar.open - prev.close) / prev.close;
    if (gapDown < -0.03 && gapBar.close < gapBar.open) {
      // 갭다운 이후 모든 날 회복 실패했는지 체크
      const daysAfter = bars.slice(i + 1);
      const allUnrecovered = daysAfter.length >= 2 && daysAfter.every(b => b.close < prev.close * 0.98);
      if (allUnrecovered) {
        hardReasons.push('gap_down_unrecovered_2days');
        break;
      }
    }
  }

  // H3. EMA20 + EMA60 모두 하향 + 거래량 증가 하락
  if (bars.length >= 65) {
    const ema20_5ago = calculateEMA(bars.slice(0, -5).map(b => b.close), 20);
    const ema60_5ago = calculateEMA(bars.slice(0, -5).map(b => b.close), 60);
    const recentAvgVol = bars.slice(-5).reduce((s, b) => s + b.volume, 0) / 5;
    if (ema20_5ago !== null && ema60_5ago !== null) {
      const ema20Declining = ema20 < ema20_5ago * 0.99;
      const ema60Declining = indicators.ema60! < ema60_5ago * 0.995;
      const volumeExpanding = recentAvgVol > avgVol * 1.2;
      if (ema20Declining && ema60Declining && volumeExpanding) {
        hardReasons.push('dual_ema_declining_vol_expanding');
      }
    }
  }

  if (hardReasons.length > 0) {
    return { level: 'HARD', reasons: hardReasons, warnings };
  }

  // ===== SOFT 무효화 조건 (매수 금지, 회복 시 재평가 가능) =====

  // S1. EMA60 아래 3% 이탈
  if (price < ema60 * 0.97) {
    softReasons.push('price_below_ema60_3pct');
  }

  // S2. 고점 대비 15% 이상 하락
  const recentHigh = Math.max(...bars.slice(-20).map(b => b.high));
  const dropFromHigh = (price - recentHigh) / recentHigh;
  if (dropFromHigh < -0.15) {
    softReasons.push(`excessive_drop_${(dropFromHigh * 100).toFixed(1)}pct`);
  }

  // S3. 돌파구간 일시 이탈
  if (bars.length >= 40) {
    const priorHigh = Math.max(...bars.slice(-40, -20).map(b => b.high));
    if (price < priorHigh * 0.95) {
      softReasons.push('breakout_zone_lost');
    }
  }

  // S4. 장대 음봉 단독 (전저점 미이탈이면 SOFT)
  if (hasLargeBearishCandle && !priorLowBroken) {
    softReasons.push('high_volume_large_bearish_candle');
  }

  // S5. 갭다운 후 당일 미회복 (아직 2일 경과 전)
  for (let i = bars.length - 2; i < bars.length; i++) {
    if (i <= 0) continue;
    const prev = bars[i - 1];
    const curr = bars[i];
    const gapDown = (curr.open - prev.close) / prev.close;
    if (gapDown < -0.03 && curr.close < curr.open) {
      softReasons.push('gap_down_recent');
      break;
    }
  }

  if (softReasons.length > 0) {
    return { level: 'SOFT', reasons: softReasons, warnings };
  }

  // ===== WARNING (감점만, 무효화 아님) =====

  if (price < ema60) {
    warnings.push('price_below_ema60');
  }

  if (bars.length >= 25) {
    const ema20_5ago = calculateEMA(bars.slice(0, -5).map(b => b.close), 20);
    if (ema20_5ago !== null && ema20 < ema20_5ago * 0.995) {
      warnings.push('ema20_declining');
    }
  }

  if (dropFromHigh < -0.10) {
    warnings.push(`deep_drop_${(dropFromHigh * 100).toFixed(1)}pct`);
  }

  if (priorLowBroken) {
    warnings.push('prior_low_broken');
  }

  return { level: 'NONE', reasons: [], warnings };
}

// ==================== SOFT 무효화 회복 조건 ====================

function checkRecovery(
  bars: DailyBar[],
  indicators: SwingIndicators,
  price: number,
  ema20: number,
): boolean {
  // 회복 조건: 아래 중 2개 이상 충족
  let recoveryCount = 0;

  // R1. 종가 EMA20 재회복
  if (price > ema20) recoveryCount++;

  // R2. 최근 3일 고점 돌파 (직전 5일 고점 대비)
  if (bars.length >= 8) {
    const prior5High = Math.max(...bars.slice(-8, -3).map(b => b.high));
    const recent3High = Math.max(...bars.slice(-3).map(b => b.high));
    if (recent3High > prior5High) recoveryCount++;
  }

  // R3. 거래량 동반 회복 양봉 (최근 2일 내)
  const avgVol = indicators.avgVolume20 || 1;
  for (const bar of bars.slice(-2)) {
    if (bar.close > bar.open && bar.volume > avgVol * 1.1) {
      recoveryCount++;
      break;
    }
  }

  return recoveryCount >= 2;
}

// ==================== 이벤트성 급등 종목 필터 ====================

/**
 * 이벤트성 급등 필터 — 건강한 돌파 vs blow-off spike 구분
 *
 * 건강한 돌파: 거래량 점진 증가 + 상승 연속성 + 위꼬리 짧음
 * blow-off spike: 단일일 폭등 + 거래량 폭증 후 급감 + 위꼬리 길어짐
 */
function checkEventSurge(bars: DailyBar[]): { penalty: number; warnings: string[] } {
  const warnings: string[] = [];
  let penalty = 0;

  if (bars.length < 10) return { penalty: 0, warnings };

  const closeNow = bars[bars.length - 1].close;
  const close3ago = bars[bars.length - 4]?.close || 0;
  const avgVol = bars.slice(-25, -5).reduce((s, b) => s + b.volume, 0) / Math.max(bars.slice(-25, -5).length, 1);

  // E1. 최근 3일 누적 상승률 과도 (20%+)
  if (close3ago > 0) {
    const cumGain = (closeNow - close3ago) / close3ago;
    if (cumGain > 0.20) {
      // 건강한 돌파 감별: 3일 모두 양봉 + 거래량 점진 증가 + 위꼬리 짧음
      const last3 = bars.slice(-3);
      const allBullish = last3.every(b => b.close > b.open);
      const volIncreasing = last3.length >= 2 && last3.every((b, i) => i === 0 || b.volume >= last3[i - 1].volume * 0.9);
      const shortUpperTails = last3.every(b => {
        const upper = b.high - Math.max(b.open, b.close);
        const body = Math.abs(b.close - b.open);
        return upper < body * 0.5;
      });

      if (allBullish && volIncreasing && shortUpperTails) {
        // 건강한 돌파형 — 감점 경감
        penalty += 3;
        warnings.push(`healthy_breakout_3d_${(cumGain * 100).toFixed(0)}pct`);
      } else {
        penalty += 8;
        warnings.push(`event_surge_3d_${(cumGain * 100).toFixed(0)}pct`);
      }
    }
  }

  // E2. 단일일 15% 이상 급등 — blow-off 특성 확인
  for (let idx = bars.length - 5; idx < bars.length; idx++) {
    if (idx < 0) continue;
    const bar = bars[idx];
    const dayGain = (bar.close - bar.open) / bar.open;
    if (dayGain > 0.15) {
      // blow-off 특성: 위꼬리가 몸통의 50%+ 또는 거래량 폭증
      const upperTail = bar.high - bar.close;
      const body = bar.close - bar.open;
      const isBlowOff = (body > 0 && upperTail > body * 0.5) || (avgVol > 0 && bar.volume > avgVol * 3);

      if (isBlowOff) {
        penalty += 6;
        warnings.push(`blowoff_spike_${(dayGain * 100).toFixed(0)}pct`);
      } else {
        penalty += 3;
        warnings.push(`single_day_spike_${(dayGain * 100).toFixed(0)}pct`);
      }
      break;
    }
  }

  // E3. 거래량 3배+ 폭증 후 급감 패턴
  if (avgVol > 0) {
    for (let i = bars.length - 5; i < bars.length - 1; i++) {
      if (i < 0) continue;
      if (bars[i].volume > avgVol * 3 && bars[i + 1].volume < avgVol * 1.5) {
        penalty += 3;
        warnings.push('volume_spike_then_drop');
        break;
      }
    }
  }

  return { penalty: Math.min(penalty, 15), warnings };
}

// ==================== 첫 눌림목 판별 ====================

/**
 * 최근 돌파 이후 조정 횟수를 셈 (1 = 첫 눌림, 2 = 두 번째, ...)
 * 간단 로직: 최근 40일 내에서 스윙 고점→저점→고점 패턴 카운트
 */
function countPullbacksSinceBreakout(bars: DailyBar[]): number {
  if (bars.length < 20) return 1;

  const recent = bars.slice(-40);
  let pullbackCount = 0;
  let inPullback = false;

  // 최고점 찾기
  let peakPrice = 0;
  for (const bar of recent) {
    if (bar.high > peakPrice) peakPrice = bar.high;
  }

  // 고점 대비 하락 → 반등 → 하락 패턴 카운팅
  const threshold = 0.03; // 3% 이상 움직임만 카운트
  let lastPeak = recent[0].high;

  for (let i = 1; i < recent.length; i++) {
    if (!inPullback && recent[i].close < lastPeak * (1 - threshold)) {
      inPullback = true;
      pullbackCount++;
    } else if (inPullback && recent[i].close > recent[i - 1].high) {
      inPullback = false;
      lastPeak = recent[i].high;
    }
    if (!inPullback && recent[i].high > lastPeak) {
      lastPeak = recent[i].high;
    }
  }

  return Math.max(pullbackCount, 1);
}

// ==================== 시장 방향 필터 ====================

interface MarketFilterResult {
  blockEntry: boolean;      // 신규매수 완전 차단
  raiseThreshold: boolean;  // 진입 임계값 +5 (65→70)
  penalty: number;          // 총점 감점
  warnings: string[];
}

function evaluateMarketContext(market?: MarketContext): MarketFilterResult {
  if (!market) return { blockEntry: false, raiseThreshold: false, penalty: 0, warnings: [] };

  const warnings: string[] = [];
  let penalty = 0;
  let blockEntry = false;
  let raiseThreshold = false;

  // M1. 시장 급락 (-2%+) → 신규매수 금지
  if (market.changeRate <= -2.0) {
    blockEntry = true;
    warnings.push(`market_crash_${market.changeRate.toFixed(1)}pct`);
    return { blockEntry, raiseThreshold: true, penalty: 10, warnings };
  }

  // M2. 시장 약세 (-1%~-2%) → 임계값 상향 + 감점
  if (market.changeRate <= -1.0) {
    raiseThreshold = true;
    penalty += 5;
    warnings.push(`market_weak_${market.changeRate.toFixed(1)}pct`);
  }

  // M3. 지수 20일선 아래 (이격도 < 98) → 감점
  if (market.d20Disparity !== null && market.d20Disparity < 98) {
    raiseThreshold = true;
    penalty += 3;
    warnings.push(`market_below_ma20_d${market.d20Disparity.toFixed(1)}`);
  }

  // M4. 하락종목 > 상승종목 × 2 → 감점
  if (market.decliningCount > market.advancingCount * 2) {
    penalty += 2;
    warnings.push('market_breadth_weak');
  }

  return { blockEntry, raiseThreshold, penalty: Math.min(penalty, 10), warnings };
}

// ==================== 유동성 필터 ====================

/** 최소 거래대금 기준: 5억원 */
const MIN_TRADING_VALUE = 500_000_000;
/** 낮은 거래대금 경고 기준: 10억원 */
const LOW_TRADING_VALUE = 1_000_000_000;

interface LiquidityFilterResult {
  blockEntry: boolean;
  penalty: number;
  warnings: string[];
}

function evaluateLiquidity(tradingValue: number | null): LiquidityFilterResult {
  if (tradingValue === null) return { blockEntry: false, penalty: 0, warnings: [] };

  const warnings: string[] = [];

  // L1. 거래대금 5억 미만 → 매수 차단
  if (tradingValue < MIN_TRADING_VALUE) {
    warnings.push(`liquidity_too_low_${Math.round(tradingValue / 1_000_000)}M`);
    return { blockEntry: true, penalty: 10, warnings };
  }

  // L2. 거래대금 10억 미만 → 감점
  if (tradingValue < LOW_TRADING_VALUE) {
    warnings.push(`liquidity_low_${Math.round(tradingValue / 1_000_000)}M`);
    return { blockEntry: false, penalty: 3, warnings };
  }

  return { blockEntry: false, penalty: 0, warnings };
}

// ==================== 1단계: 추세 적합성 (30점) ====================

interface StageResult {
  score: number;
  signals: string[];
  warnings: string[];
}

function evaluateTrend(
  bars: DailyBar[],
  indicators: SwingIndicators,
  price: number,
  ema5: number,
  ema20: number,
  ema60: number,
): StageResult {
  let score = 0;
  const signals: string[] = [];
  const warnings: string[] = [];

  // 1. MA20 기울기 (10점) — 추세에서는 방향(slope)에 집중, 위치는 지지에서 평가
  if (bars.length >= 25) {
    const ema20_5ago = calculateEMA(bars.slice(0, -5).map(b => b.close), 20);
    if (ema20_5ago !== null) {
      const slope = (ema20 - ema20_5ago) / ema20_5ago;
      if (slope > 0.01) {
        score += 10;
        signals.push(`ma20_strong_rising_${(slope * 100).toFixed(2)}pct`);
      } else if (slope > 0.005) {
        score += 7;
        signals.push('ma20_rising');
      } else if (slope > -0.002) {
        score += 3;
        signals.push('ma20_flat');
      } else {
        warnings.push('ma20_declining');
      }
    }
  }

  // 2. MA60 비하락 (5점)
  if (bars.length >= 65) {
    const ema60_5ago = calculateEMA(bars.slice(0, -5).map(b => b.close), 60);
    if (ema60_5ago !== null) {
      const slope60 = (ema60 - ema60_5ago) / ema60_5ago;
      if (slope60 > 0) {
        score += 5;
        signals.push('ma60_rising');
      } else if (slope60 > -0.005) {
        score += 2;
        signals.push('ma60_flat');
      } else {
        warnings.push('ma60_declining');
      }
    }
  }

  // 3. 가격이 MA60 위인지 기본 확인 (5점) — MA20 위치는 지지에서 평가
  if (price > ema60) {
    score += 5;
    signals.push('price_above_ma60');
  } else if (price > ema60 * 0.97) {
    score += 2;
    signals.push('price_near_ma60');
  } else {
    warnings.push('price_below_ma60');
  }

  // 4. 최근 20~40일 내 의미 있는 상승 파동 존재 (5점)
  const lookback = bars.slice(-40);
  if (lookback.length >= 20) {
    const low20 = Math.min(...lookback.slice(0, 20).map(b => b.low));
    const high20 = Math.max(...lookback.map(b => b.high));
    const swingUp = (high20 - low20) / low20;
    if (swingUp > 0.10) {
      score += 5;
      signals.push(`recent_upswing_${(swingUp * 100).toFixed(0)}pct`);
    } else if (swingUp > 0.05) {
      score += 2;
      signals.push(`moderate_upswing_${(swingUp * 100).toFixed(0)}pct`);
    }
  }

  // 5. 상승 구간에서 거래량 증가 (5점)
  if (bars.length >= 20 && indicators.avgVolume20 !== null) {
    // 최근 20일 중 양봉의 평균 거래량 vs 음봉의 평균 거래량
    const recent20 = bars.slice(-20);
    const bullVols = recent20.filter(b => b.close >= b.open).map(b => b.volume);
    const bearVols = recent20.filter(b => b.close < b.open).map(b => b.volume);
    const avgBullVol = bullVols.length > 0 ? bullVols.reduce((a, b) => a + b, 0) / bullVols.length : 0;
    const avgBearVol = bearVols.length > 0 ? bearVols.reduce((a, b) => a + b, 0) / bearVols.length : 0;
    if (avgBullVol > avgBearVol * 1.2) {
      score += 5;
      signals.push('bullish_volume_dominance');
    } else if (avgBullVol > avgBearVol) {
      score += 2;
      signals.push('slight_bullish_volume');
    }
  }

  return { score: Math.min(score, 30), signals, warnings };
}

// ==================== 2단계: 조정 적합성 (30점) ====================

function evaluatePullback(
  bars: DailyBar[],
  indicators: SwingIndicators,
  swingCtx?: SwingContext,
): StageResult & { score: number } {
  let score = 0;
  const signals: string[] = [];
  const warnings: string[] = [];

  if (bars.length < 10) return { score: 0, signals, warnings };

  // 최근 고점 찾기 (20일 내)
  const recent20 = bars.slice(-20);
  let peakIdx = 0;
  let peakHigh = 0;
  for (let i = 0; i < recent20.length; i++) {
    if (recent20[i].high > peakHigh) {
      peakHigh = recent20[i].high;
      peakIdx = i;
    }
  }

  const daysSincePeak = recent20.length - 1 - peakIdx;
  const peakClose = recent20[peakIdx].close;
  const lastClose = recent20[recent20.length - 1].close;

  // 아직 조정이 시작되지 않음
  if (daysSincePeak === 0) {
    signals.push('no_pullback_yet');
    return { score: 0, signals, warnings };
  }

  // ===== 직전 상승 파동 길이 측정 (impulse days) =====
  let impulseDays = 0;
  if (bars.length >= 40) {
    // 고점 이전에서 저점 찾기 (상승 시작점)
    const prePeakStart = Math.max(0, bars.length - 40);
    const prePeakEnd = bars.length - (recent20.length - peakIdx); // peakIdx in full bars
    let troughIdx = prePeakEnd;
    let troughLow = Infinity;
    for (let i = prePeakStart; i < prePeakEnd; i++) {
      if (bars[i].low < troughLow) {
        troughLow = bars[i].low;
        troughIdx = i;
      }
    }
    impulseDays = prePeakEnd - troughIdx;
  }

  // 1. 조정 기간 적정 (10점) — 절대 기간 + 상승파동 대비 비율
  let durationScore = 0;

  // 절대 기간 평가
  if (daysSincePeak >= 2 && daysSincePeak <= 8) {
    durationScore += 6;
    signals.push(`pullback_${daysSincePeak}_days`);
  } else if (daysSincePeak >= 1 && daysSincePeak <= 12) {
    durationScore += 3;
    signals.push(`pullback_${daysSincePeak}_days_marginal`);
  } else {
    warnings.push(`pullback_too_long_${daysSincePeak}_days`);
  }

  // 상승파동 대비 비율 평가 (impulseDays > 0인 경우)
  if (impulseDays > 0) {
    const ratio = daysSincePeak / impulseDays;
    if (ratio >= 0.2 && ratio <= 0.6) {
      durationScore += 4;
      signals.push(`pullback_ratio_${ratio.toFixed(2)}`);
    } else if (ratio > 0.6 && ratio <= 1.0) {
      durationScore += 1;
      warnings.push(`pullback_ratio_high_${ratio.toFixed(2)}`);
    } else if (ratio > 1.0) {
      warnings.push(`pullback_ratio_excessive_${ratio.toFixed(2)}`);
    } else {
      durationScore += 2; // 매우 짧은 비율 (< 0.2)
    }
  } else {
    durationScore += 2; // 상승파동 측정 불가 시 기본점
  }
  score += Math.min(durationScore, 10);

  // 2. 조정폭 적정 (10점) — 정적기준 + ATR 동적기준 + retracement 병행
  let depthScore = 0;

  // 2a. high 기준 (경고성)
  const pullbackFromHigh = (lastClose - peakHigh) / peakHigh;

  // 2b. close 기준 (실전 체감)
  const pullbackFromClose = (lastClose - peakClose) / peakClose;

  // 2c. retracement 비율 (구조 평가) — 직전 상승폭 대비
  let retracementRatio = 0;
  if (bars.length >= 30 && impulseDays > 0) {
    const prePeakStart = Math.max(0, bars.length - 40);
    const swingLow = Math.min(...bars.slice(prePeakStart, bars.length - daysSincePeak).map(b => b.low));
    if (peakHigh > swingLow) {
      retracementRatio = (peakHigh - lastClose) / (peakHigh - swingLow);
    }
  }

  // 2d. ATR 기반 동적 깊이 평가 (종목별 변동성 반영)
  const atr = indicators.atr14;
  const pullbackAbs = Math.abs(peakClose - lastClose);

  if (atr !== null && atr > 0) {
    // ATR 배수로 조정 깊이 평가: 1.5~3.0 ATR이 이상적
    const atrMultiple = pullbackAbs / atr;
    if (atrMultiple >= 1.5 && atrMultiple <= 3.0) {
      depthScore += 4;
      signals.push(`atr_depth_${atrMultiple.toFixed(1)}x`);
    } else if (atrMultiple >= 1.0 && atrMultiple <= 4.0) {
      depthScore += 2;
      signals.push(`atr_depth_${atrMultiple.toFixed(1)}x_marginal`);
    } else if (atrMultiple < 1.0) {
      depthScore += 1;
      signals.push(`atr_depth_shallow_${atrMultiple.toFixed(1)}x`);
    } else {
      warnings.push(`atr_depth_excessive_${atrMultiple.toFixed(1)}x`);
    }
  } else {
    // ATR 없으면 정적 close 기준으로 폴백 (기존 로직)
    if (pullbackFromClose >= -0.08 && pullbackFromClose <= -0.03) {
      depthScore += 4;
      signals.push(`pullback_close_${(pullbackFromClose * 100).toFixed(1)}pct`);
    } else if (pullbackFromClose >= -0.10 && pullbackFromClose < -0.01) {
      depthScore += 2;
      signals.push(`pullback_close_${(pullbackFromClose * 100).toFixed(1)}pct_marginal`);
    } else if (pullbackFromClose > -0.01) {
      depthScore += 1;
      signals.push('shallow_pullback');
    } else {
      warnings.push(`deep_pullback_close_${(pullbackFromClose * 100).toFixed(1)}pct`);
    }
  }

  // retracement 비율 점수 — SwingContext가 있으면 구조적 retracement 우선 사용
  const effectiveRetracement = swingCtx?.retracementDepth ?? retracementRatio;
  const retracementSource = swingCtx?.retracementDepth !== null && swingCtx?.retracementDepth !== undefined
    ? 'as_retrace' : 'retrace';
  if (effectiveRetracement >= 0.25 && effectiveRetracement <= 0.50) {
    depthScore += 4;
    signals.push(`${retracementSource}_${(effectiveRetracement * 100).toFixed(0)}pct`);
  } else if (effectiveRetracement > 0.50 && effectiveRetracement <= 0.618) {
    depthScore += 2;
    signals.push(`${retracementSource}_deep_${(effectiveRetracement * 100).toFixed(0)}pct`);
  } else if (effectiveRetracement > 0.618) {
    warnings.push(`${retracementSource}_excessive_${(effectiveRetracement * 100).toFixed(0)}pct`);
  }

  // 정적 close 기준 보조 점수 (ATR 있어도 추가 확인)
  if (atr !== null && atr > 0) {
    if (pullbackFromClose < -0.12) {
      warnings.push(`deep_pullback_close_${(pullbackFromClose * 100).toFixed(1)}pct`);
    }
  }

  // high 기준 경고 (조정폭이 close보다 5%+ 더 깊으면)
  if (pullbackFromHigh < pullbackFromClose - 0.05) {
    warnings.push('high_based_depth_much_deeper');
  }

  score += Math.min(depthScore, 10);

  // 3. 거래량 패턴 (5점) — 수축 + 추세 + 반등 재확대 복합 평가
  if (daysSincePeak >= 2) {
    let volScore = 0;
    const prePeakBars = recent20.slice(Math.max(0, peakIdx - 5), peakIdx);
    const postPeakBars = recent20.slice(peakIdx + 1);

    if (prePeakBars.length > 0 && postPeakBars.length > 0) {
      const prePeakAvgVol = prePeakBars.reduce((s, b) => s + b.volume, 0) / prePeakBars.length;
      const postPeakAvgVol = postPeakBars.reduce((s, b) => s + b.volume, 0) / postPeakBars.length;

      // 3a. 조정 구간 전체 수축 (기본)
      if (postPeakAvgVol < prePeakAvgVol * 0.7) {
        volScore += 2;
        signals.push('volume_contracting');
      } else if (postPeakAvgVol >= prePeakAvgVol) {
        warnings.push('volume_expanding_during_pullback');
      }

      // 3b. 조정 말미 거래량 연속 감소 추세 (최근 3~5일)
      if (postPeakBars.length >= 3) {
        const recentVols = postPeakBars.slice(-Math.min(5, postPeakBars.length)).map(b => b.volume);
        let decreasingCount = 0;
        for (let i = 1; i < recentVols.length; i++) {
          if (recentVols[i] <= recentVols[i - 1]) decreasingCount++;
        }
        if (decreasingCount >= recentVols.length - 2) { // 대부분 감소
          volScore += 1;
          signals.push('volume_trend_decreasing');
        }
      }

      // 3c. 반등 시 거래량 재확대 (오늘 양봉 + 어제보다 거래량 증가)
      const todayBar = recent20[recent20.length - 1];
      const yesterdayBar = recent20[recent20.length - 2];
      if (todayBar.close > todayBar.open && todayBar.volume > yesterdayBar.volume * 1.2) {
        // 수축 후 재확대 패턴 = 이상적
        if (postPeakAvgVol < prePeakAvgVol * 0.8) {
          volScore += 2;
          signals.push('volume_contraction_then_expansion');
        } else {
          volScore += 1;
          signals.push('volume_bounce_increase');
        }
      }
    }
    score += Math.min(volScore, 5);
  }

  // 4. 급락 아닌 완만한 조정 (5점) — 장대 음봉 연속 없음
  const pullbackBars = recent20.slice(peakIdx + 1);
  let largeBearishCount = 0;
  for (const bar of pullbackBars) {
    const bodySize = Math.abs(bar.close - bar.open) / bar.open;
    if (bar.close < bar.open && bodySize > 0.025) {
      largeBearishCount++;
    }
  }
  if (largeBearishCount === 0) {
    score += 5;
    signals.push('gentle_pullback');
  } else if (largeBearishCount <= 1) {
    score += 2;
    signals.push('mostly_gentle_pullback');
  } else {
    warnings.push(`${largeBearishCount}_large_bearish_candles`);
  }

  return { score: Math.min(score, 30), signals, warnings };
}

// ==================== 3단계: 지지 구간 유지 (20점) ====================

function evaluateSupport(
  bars: DailyBar[],
  indicators: SwingIndicators,
  price: number,
  ema20: number,
  ema60: number,
  swingCtx?: SwingContext,
): StageResult {
  let score = 0;
  const signals: string[] = [];
  const warnings: string[] = [];

  // 1. MA20 위치 기반 지지 평가 (7점) — 터치/reclaim/distance
  const distFromEma20 = (price - ema20) / ema20;

  // MA20 터치 후 reclaim 패턴 확인 (최근 3일 중 MA20 아래 터치 후 종가 위)
  let ma20Reclaim = false;
  if (bars.length >= 3) {
    const recent3 = bars.slice(-3);
    const touchedBelow = recent3.some(b => b.low < ema20);
    const closedAbove = recent3[recent3.length - 1].close >= ema20 * 0.995;
    ma20Reclaim = touchedBelow && closedAbove;
  }

  if (ma20Reclaim && distFromEma20 >= -0.01 && distFromEma20 <= 0.02) {
    // MA20 터치 후 reclaim = 최적 눌림목 지지
    score += 7;
    signals.push('ma20_touch_reclaim');
  } else if (distFromEma20 >= -0.01 && distFromEma20 <= 0.015) {
    // MA20 ±1% 이내: 터치 지지 중
    score += 6;
    signals.push('testing_ma20_support');
  } else if (distFromEma20 > 0.015 && distFromEma20 <= 0.03) {
    score += 4;
    signals.push('holding_above_ma20');
  } else if (distFromEma20 >= -0.03 && distFromEma20 < -0.01) {
    score += 3; // 약간 이탈 중
    signals.push('slightly_below_ma20');
  } else if (distFromEma20 > 0.03) {
    score += 2; // MA20 위이지만 이격 큼
    signals.push('above_ma20_distant');
  } else {
    warnings.push('below_ma20');
  }

  // 2. 최근 돌파 구간 지지 (4점) — 직전 20~40일 고점을 현재 지지로 활용
  if (bars.length >= 40) {
    const priorRange = bars.slice(-40, -20);
    const priorHigh = Math.max(...priorRange.map(b => b.high));
    if (price >= priorHigh * 0.98) {
      score += 4;
      signals.push('holding_breakout_zone');
    } else {
      warnings.push('lost_breakout_zone');
    }
  }

  // 3. 전저점 미이탈 (4점) — 최근 20일 내 직전 스윙 저점
  if (bars.length >= 20) {
    // 최근 20일 중 가장 낮은 저점 (최근 3일 제외)
    const prior17Low = Math.min(...bars.slice(-20, -3).map(b => b.low));
    const recent3Low = Math.min(...bars.slice(-3).map(b => b.low));
    if (recent3Low >= prior17Low) {
      score += 4;
      signals.push('prior_low_intact');
    } else {
      warnings.push('prior_low_breached');
    }
  }

  // 4. 하락 둔화 + 종가 일중위치(CLV) (3점)
  // CLV = (close - low) / (high - low), 1에 가까울수록 장 중 상단 마감
  const last3 = bars.slice(-3);
  let tailSignalCount = 0;
  let clvSum = 0;
  let clvCount = 0;
  for (const bar of last3) {
    const bodyBottom = Math.min(bar.open, bar.close);
    const lowerTail = bodyBottom - bar.low;
    const bodySize = Math.abs(bar.close - bar.open);
    if (lowerTail > bodySize * 0.5 && lowerTail > 0) {
      tailSignalCount++;
    }
    const range = bar.high - bar.low;
    if (range > 0) {
      clvSum += (bar.close - bar.low) / range;
      clvCount++;
    }
  }
  const avgCLV = clvCount > 0 ? clvSum / clvCount : 0.5;

  // 아래꼬리 + CLV 복합 평가
  if (tailSignalCount >= 2 && avgCLV >= 0.6) {
    score += 3;
    signals.push(`lower_tails_clv_${avgCLV.toFixed(2)}`);
  } else if (tailSignalCount >= 1 && avgCLV >= 0.5) {
    score += 2;
    signals.push(`some_tail_clv_${avgCLV.toFixed(2)}`);
  } else if (avgCLV >= 0.65) {
    score += 1;
    signals.push(`high_clv_${avgCLV.toFixed(2)}`);
  } else if (avgCLV < 0.3) {
    warnings.push(`low_clv_${avgCLV.toFixed(2)}`);
  }

  // 5. 피보나치 되돌림 구간 (3점) — 최근 상승 파동의 38.2%~50% 되돌림
  if (bars.length >= 30) {
    const swingLow = Math.min(...bars.slice(-30, -10).map(b => b.low));
    const swingHigh = Math.max(...bars.slice(-20).map(b => b.high));
    if (swingHigh > swingLow) {
      const fib382 = swingHigh - (swingHigh - swingLow) * 0.382;
      const fib500 = swingHigh - (swingHigh - swingLow) * 0.500;
      if (price >= fib500 * 0.99 && price <= fib382 * 1.01) {
        score += 3;
        signals.push('fibonacci_retrace_zone');
      }
    }
  }

  // 6. Active Swing 구조적 지지 확인 (추가 — SwingContext 기반)
  if (swingCtx?.inSupportZone) {
    // 가격이 구조적 supportZone 내에 있음 — confluence 강화
    score += 2;
    signals.push('as_support_zone');
  }
  if (swingCtx?.aboveBreakout) {
    // 돌파 기준선 위 유지 — 이전 저항이 지지로 전환
    score += 1;
    signals.push('as_above_breakout');
  }

  return { score: Math.min(score, 23), signals, warnings }; // 최대 23점 (구조 보너스 포함)
}

// ==================== 4단계: 반등 트리거 (필수 + 보조 구조, 20점) ====================

interface TriggerResult extends StageResult {
  /** 필수조건 충족: 구조적 돌파 1개 이상 */
  requiredMet: boolean;
  /** 보조조건 충족 수 */
  supportingCount: number;
}

function evaluateTrigger(
  bars: DailyBar[],
  indicators: SwingIndicators,
  price: number,
  ema20: number,
  swingCtx?: SwingContext,
): TriggerResult {
  let score = 0;
  const signals: string[] = [];
  const warnings: string[] = [];
  let requiredCount = 0;
  let supportingCount = 0;

  if (bars.length < 3) return { score: 0, signals, warnings, requiredMet: false, supportingCount: 0 };

  const today = bars[bars.length - 1];
  const yesterday = bars[bars.length - 2];

  // ===== 필수조건 (구조적 돌파, 최소 1개 필요) =====
  // RSI/MACD는 여기 포함 불가 — 가격 구조 기반만
  // 돌파 버퍼: 1틱 돌파는 노이즈이므로 0.3% 이상 + 몸통 기준 마감 요구
  const breakoutBuffer = 0.003; // 0.3%
  const todayBodyTop = Math.max(today.open, today.close); // 몸통 상단

  // R1. 최근 3일 고점 돌파 (5점) — 몸통 기준으로 버퍼 이상 돌파
  const recent3High = Math.max(yesterday.high, bars[bars.length - 3]?.high ?? 0);
  const r1Threshold = recent3High * (1 + breakoutBuffer);
  if (todayBodyTop > r1Threshold) {
    score += 5;
    requiredCount++;
    signals.push(`req:recent_high_broken_${((todayBodyTop / recent3High - 1) * 100).toFixed(1)}pct`);
  }

  // R2. 단기 하락 추세선 돌파 — 최근 3일 고점 연결 하락 패턴 돌파
  if (bars.length >= 5) {
    const highs3 = [bars[bars.length - 4].high, bars[bars.length - 3].high, bars[bars.length - 2].high];
    const isDescending = highs3[0] > highs3[1] && highs3[1] > highs3[2];
    if (isDescending) {
      const trendlineValue = highs3[2] * (1 + breakoutBuffer);
      if (todayBodyTop > trendlineValue) {
        score += 5;
        requiredCount++;
        signals.push('req:downtrend_line_break');
      }
    }
  }

  // R3. 직전 스윙 고점 돌파 (2~5일 전 반등 고점) — 몸통 기준
  if (bars.length >= 8) {
    const recentBars = bars.slice(-8, -1); // 오늘 제외
    let miniSwingHigh = 0;
    for (let i = 1; i < recentBars.length - 1; i++) {
      if (recentBars[i].high > recentBars[i - 1].high && recentBars[i].high > recentBars[i + 1].high) {
        miniSwingHigh = Math.max(miniSwingHigh, recentBars[i].high);
      }
    }
    if (miniSwingHigh > 0 && todayBodyTop > miniSwingHigh * (1 + breakoutBuffer)) {
      score += 5;
      requiredCount++;
      signals.push('req:mini_swing_high_broken');
    }
  }

  // R4. Active Swing breakoutLevel 돌파 — 구조적 이전 저항선 돌파
  if (swingCtx?.activeSwing && swingCtx.activeSwing.breakoutLevel > 0) {
    const blLevel = swingCtx.activeSwing.breakoutLevel;
    if (todayBodyTop > blLevel * (1 + breakoutBuffer)) {
      score += 4;
      requiredCount++;
      signals.push(`req:as_breakout_level_broken_${blLevel.toFixed(0)}`);
    }
  }

  // ===== 보조조건 (확인용, 2개 이상 필요) =====

  // S1. 당일 양봉 전환
  if (today.close > today.open) {
    const bodySize = (today.close - today.open) / today.open;
    if (bodySize > 0.01) {
      score += 3;
      supportingCount++;
      signals.push('sup:bullish_candle');
    } else {
      score += 1;
      signals.push('sup:small_bullish_candle');
    }
  } else {
    warnings.push('no_bullish_candle');
  }

  // S2. 반등 캔들에서 거래량 증가
  if (today.close > today.open && indicators.avgVolume20 !== null) {
    if (today.volume > indicators.avgVolume20 * 1.3) {
      score += 3;
      supportingCount++;
      signals.push('sup:volume_surge_on_bounce');
    } else if (today.volume > indicators.avgVolume20) {
      score += 1;
      supportingCount++;
      signals.push('sup:above_avg_volume');
    }
  }

  // S3. RSI 반등 확인 (보조만 — 필수조건 기여 불가)
  if (indicators.rsi14 !== null) {
    if (indicators.rsi14 >= 40 && indicators.rsi14 <= 55) {
      score += 2;
      supportingCount++;
      signals.push(`sup:rsi_recovering_${indicators.rsi14.toFixed(0)}`);
    } else if (indicators.rsi14 > 55) {
      score += 1;
      signals.push('sup:rsi_already_strong');
    } else {
      warnings.push(`rsi_weak_${indicators.rsi14.toFixed(0)}`);
    }
  }

  // S4. MACD 히스토그램 양전환 (보조만)
  if (indicators.macdHist !== null && indicators.macdHist > 0) {
    score += 2;
    supportingCount++;
    signals.push('sup:macd_hist_positive');
  }

  // S5. EMA5 > EMA20 재교차 (골든크로스 조짐)
  if (indicators.ema5 !== null && indicators.ema20 !== null && indicators.ema5 > ema20) {
    score += 1;
    supportingCount++;
    signals.push('sup:ema5_above_ema20');
  }

  return {
    score: Math.min(score, 20),
    signals,
    warnings,
    requiredMet: requiredCount >= 1,
    supportingCount,
  };
}

// ==================== 지지 겹침(Confluence) 보너스 ====================

function calculateConfluenceBonus(supportSignals: string[]): number {
  let bonus = 0;
  const has = (s: string) => supportSignals.some(sig => sig.includes(s));

  const hasMA20 = has('ma20') || has('testing_ma20');
  const hasBreakout = has('breakout_zone');
  const hasFib = has('fibonacci');
  const hasPriorLow = has('prior_low_intact');

  let confluenceCount = 0;
  if (hasMA20) confluenceCount++;
  if (hasBreakout) confluenceCount++;
  if (hasFib) confluenceCount++;
  if (hasPriorLow) confluenceCount++;

  // 2개 겹침: +2, 3개+: +4
  if (confluenceCount >= 3) {
    bonus = 4;
  } else if (confluenceCount >= 2) {
    bonus = 2;
  }

  return bonus;
}

// ==================== 후보 랭킹 점수 ====================

/**
 * 복수 종목 동시 신호 시 우선순위 결정용 랭킹 점수 계산
 * 높을수록 우선 매수 대상
 *
 * 가중치: 셋업 품질(40%) + R:R(25%) + Completion 품질(15%) + 유동성(10%) + 이벤트 리스크(10%)
 */
export function calculateCandidateRankScore(entry: SwingEntryResult): number {
  // 실행 불가능 후보는 랭킹 0
  if (!entry.shouldBuy || !entry.executionGate?.executable) return 0;

  let rankScore = 0;

  // 1. 셋업 품질 (40점 만점) — 총점 100점을 40점으로 정규화
  rankScore += (entry.readinessScore / 100) * 40;

  // 2. R:R 비율 (20점 만점) — R:R 2.0=기본, 3.0+=만점
  const rr = entry.executionGate?.rrRatio ?? 0;
  const rrNorm = Math.min(rr / 4.0, 1.0);
  rankScore += rrNorm * 20;

  // 3. Completion 품질 (10점) — completion + axis floor 통과
  if (entry.executionGate?.completionConfirmed) rankScore += 7;
  if (!entry.axisFloorFailed) rankScore += 3;

  // 4. Swing confidence (10점) — prominence/volume/recency
  const swingConf = entry.activeSwing?.confidence ?? 0;
  rankScore += swingConf * 10;

  // 5. 유동성 보너스 (10점) — 감점 신호 없으면 만점
  const hasLiquidityWarning = entry.negativeSignals.some(s => s.includes('liquidity'));
  rankScore += hasLiquidityWarning ? 3 : 10;

  // 6. 이벤트 리스크 감점 (5점) — 이벤트 신호 없으면 만점
  const hasEventWarning = entry.negativeSignals.some(s =>
    s.includes('event_surge') || s.includes('blowoff') || s.includes('volume_spike_then_drop'));
  rankScore += hasEventWarning ? 1 : 5;

  // 7. Soft penalty 차감
  const softPenalty = entry.executionGate?.softPenaltyScore ?? 0;
  rankScore -= softPenalty * 0.3; // 최대 ~15점 감점

  return Math.round(rankScore * 10) / 10;
}

// ==================== 추가매수 판단 ====================

export interface SwingAdditionalBuyResult {
  shouldBuy: boolean;
  reason: string;
  suggestedQuantity?: number;
}

/**
 * 추가매수 판단 — 피라미딩 기본, 물타기 비활성
 *
 * 피라미딩 (기본): 수익 중(+2%+)인 포지션이 소형 눌림 후 재돌파할 때 추가
 * 물타기 (비활성): 하락 시 평단 낮추기 — 추세 붕괴 위험이 있어 기본 off
 */
export function calculateSwingAdditionalBuy(
  state: SwingState,
  indicators: SwingIndicators,
  dailyBars?: DailyBar[],
): SwingAdditionalBuyResult {
  const { buyRecords, avgPrice, config } = state;
  const additionalBuyCount = buyRecords.filter(r => r.reason === 'additional').length;
  const { currentPrice, rsi14, ema20, ema60 } = indicators;

  if (additionalBuyCount >= config.maxAdditionalBuys) {
    return { shouldBuy: false, reason: 'max_additional_buys_reached' };
  }

  // 당일 중복 방지
  if (buyRecords.length > 0) {
    const lastBuy = buyRecords[buyRecords.length - 1];
    const lastBuyDate = new Date(lastBuy.date).toISOString().slice(0, 10);
    const today = new Date().toISOString().slice(0, 10);
    if (lastBuyDate === today) {
      return { shouldBuy: false, reason: 'same_day_cooldown' };
    }
  }

  // ===== 공통 안전장치 =====

  // HARD/SOFT 무효화 체크
  if (dailyBars && dailyBars.length >= 60 && ema20 !== null && ema60 !== null) {
    const invalidResult = checkInvalidation(dailyBars, indicators, currentPrice, ema20, ema60, state.pullbackState);
    if (invalidResult.level === 'HARD') {
      return { shouldBuy: false, reason: `hard_invalidated: ${invalidResult.reasons[0]}` };
    }
    if (invalidResult.level === 'SOFT') {
      return { shouldBuy: false, reason: `soft_invalidated: ${invalidResult.reasons[0]}` };
    }
  }

  // EMA60 아래면 추가매수 금지
  if (ema60 !== null && currentPrice < ema60) {
    return { shouldBuy: false, reason: 'below_ema60' };
  }

  // 전저점 유지 확인
  if (dailyBars && dailyBars.length >= 20) {
    const prior17Low = Math.min(...dailyBars.slice(-20, -3).map(b => b.low));
    const recent3Low = Math.min(...dailyBars.slice(-3).map(b => b.low));
    if (recent3Low < prior17Low * 0.99) {
      return { shouldBuy: false, reason: 'prior_low_broken' };
    }
  }

  // ===== 피라미딩 모드 (기본): 수익 중 + 소형 눌림 후 재돌파 =====
  const profitRate = (currentPrice - avgPrice) / avgPrice;

  // 수익률 +2% 이상이어야 피라미딩 자격
  if (profitRate >= 0.02) {
    // 추세 유지 확인: EMA20 위
    if (ema20 !== null && currentPrice > ema20) {
      // RSI 건강 범위 (40~60 = 과열 아니고 약하지 않음)
      if (rsi14 === null || (rsi14 >= 40 && rsi14 <= 60)) {
        // 최근 소형 눌림 확인: 고점 대비 2~5% 하락 후 반등 중
        if (dailyBars && dailyBars.length >= 5) {
          const recent5High = Math.max(...dailyBars.slice(-5).map(b => b.high));
          const pullbackFromRecent = (currentPrice - recent5High) / recent5High;
          const todayBar = dailyBars[dailyBars.length - 1];
          const isBouncing = todayBar.close > todayBar.open; // 양봉

          if (pullbackFromRecent >= -0.05 && pullbackFromRecent <= -0.01 && isBouncing) {
            const remainingBuys = config.maxAdditionalBuys - additionalBuyCount;
            const remainingPrincipal = config.principal - state.totalInvested;
            const buyAmount = Math.floor(remainingPrincipal / remainingBuys);
            const quantity = Math.floor(buyAmount / currentPrice);

            if (quantity > 0) {
              return {
                shouldBuy: true,
                reason: `pyramid (profit=${(profitRate * 100).toFixed(1)}%, mini_pullback=${(pullbackFromRecent * 100).toFixed(1)}%)`,
                suggestedQuantity: quantity,
              };
            }
          }
        }
        return { shouldBuy: false, reason: 'pyramid: no mini pullback pattern' };
      }
      return { shouldBuy: false, reason: `pyramid: rsi_out_of_range (${rsi14?.toFixed(0)})` };
    }
    return { shouldBuy: false, reason: 'pyramid: below_ema20' };
  }

  // 수익률 +2% 미만 → 피라미딩 불가, 물타기도 비활성 (기본값)
  return { shouldBuy: false, reason: `pyramid: profit_insufficient (${(profitRate * 100).toFixed(1)}%)` };
}

// ==================== 청산 판단 ====================

export interface SwingExitResult {
  shouldSell: boolean;
  reason: SwingSellReason | '';
  orderType: 'LIMIT' | 'MARKET';
  suggestedPrice?: number;
  /** 부분매도 시 매도 수량 (미설정이면 전량) */
  sellQuantity?: number;
  /** 부분매도 여부 */
  isPartialExit: boolean;
  detail: string;
}

/**
 * 포지션 라이프사이클 단계 결정
 *
 * INIT_RISK: 진입 직후, 아직 리스크 해소 안 됨
 * DE_RISKED: target1 부분익절 완료, breakeven stop 적용
 * RUNNER: 수익 +5%+ & 트레일링 활성, 수익 극대화 모드
 * WEAKENING: 추세 약화 감지 (EMA5 < EMA20 접근, CLV 하락 등)
 */
export function determinePositionPhase(
  state: SwingState,
  indicators: SwingIndicators,
): PositionPhase {
  const { avgPrice, partialExitDone, trailingStopActivated } = state;
  const { currentPrice, ema5, ema20 } = indicators;
  const profitRate = avgPrice > 0 ? (currentPrice - avgPrice) / avgPrice : 0;

  // WEAKENING: 추세 약화 감지 (DE_RISKED/RUNNER 상태에서만)
  if (partialExitDone && ema5 !== null && ema20 !== null) {
    const emaGap = (ema5 - ema20) / ema20;
    // EMA5가 EMA20에 0.5% 이내로 수렴하면 WEAKENING
    if (emaGap < 0.005) {
      return 'WEAKENING';
    }
  }

  // RUNNER: 수익 +5%+ & 트레일링 활성 & 부분익절 완료
  if (partialExitDone && trailingStopActivated && profitRate >= 0.05) {
    return 'RUNNER';
  }

  // DE_RISKED: 부분익절 완료
  if (partialExitDone) {
    return 'DE_RISKED';
  }

  // INIT_RISK: 기본
  return 'INIT_RISK';
}

/**
 * 청산 판단 — 구조적 손절 + 포지션 상태 기반 트레일링 + 조건부 시간 손절
 *
 * 우선순위:
 * 0. Catastrophic fail-safe (전량) — 극단 급락 보호, 고정 -10%
 * 1. 구조적 손절 (전량) — invalidationLevel - buffer 이탈 시
 * 1b. 고정 손절 폴백 (전량) — activeSwing 없을 때 config.stopLossPercent
 * 2. ATR 기반 트레일링 스탑 (전량) — 부분익절 후 tightening
 * 3. 시간 손절 (전량) — 추세 상태 반영 조건부 연장
 * 4. target1 부분익절 (50%) — activeSwing.target1 도달 시 절반 매도
 * 5. target2 / 고정 목표가 익절 (잔량)
 * 6. EMA 추세 이탈 (전량)
 */
export function calculateSwingExit(
  state: SwingState,
  indicators: SwingIndicators,
  globalTrailingStopEnabled: boolean,
  maxHoldingDays: number,
  options?: { disableEmaBreakInInitRisk?: boolean },
): SwingExitResult {
  const noExit: SwingExitResult = {
    shouldSell: false, reason: '', orderType: 'LIMIT', detail: '', isPartialExit: false,
  };

  const { avgPrice, config, holdingDays, highestPrice, trailingStopActivated, activeSwing } = state;
  const { currentPrice, ema5, ema20, atr14 } = indicators;

  if (avgPrice <= 0 || state.buyRecords.length === 0) return noExit;

  const profitRate = (currentPrice - avgPrice) / avgPrice;

  // ===== Phase 결정 =====
  const phase = determinePositionPhase(state, indicators);

  // 0순위: Catastrophic fail-safe (전량) — 모든 phase 공통
  const CATASTROPHIC_STOP = -0.10;
  if (profitRate <= CATASTROPHIC_STOP) {
    return {
      shouldSell: true, reason: 'stop_loss', orderType: 'MARKET',
      detail: `[${phase}] 긴급 손절 (${(profitRate * 100).toFixed(2)}% ≤ ${(CATASTROPHIC_STOP * 100).toFixed(0)}% catastrophic)`,
      isPartialExit: false,
    };
  }

  // 1순위: 초기 손절 (전량) — INIT_RISK / DE_RISKED에서 적용
  // 3-tier stop: initialTradeStop (실제 손절) > thesisInvalidation (context) > catastrophic (fail-safe)
  if (phase === 'INIT_RISK' || phase === 'DE_RISKED') {
    // initialTradeStop: local structure 기반 실제 손절선
    if (state.initialTradeStop && state.initialTradeStop > 0) {
      if (currentPrice <= state.initialTradeStop) {
        return {
          shouldSell: true, reason: 'stop_loss', orderType: 'MARKET',
          detail: `[${phase}] 초기 손절 (현재가 ${currentPrice} ≤ initialTradeStop ${Math.round(state.initialTradeStop)}, 수익률 ${(profitRate * 100).toFixed(2)}%)`,
          isPartialExit: false,
        };
      }
    } else if (activeSwing) {
      // fallback: initialTradeStop 없으면 기존 invalidationLevel 사용
      const structuralStop = activeSwing.invalidationLevel * 0.997;
      if (currentPrice <= structuralStop) {
        return {
          shouldSell: true, reason: 'stop_loss', orderType: 'MARKET',
          detail: `[${phase}] 구조적 손절 (현재가 ${currentPrice} ≤ invalidation ${Math.round(activeSwing.invalidationLevel)}, 수익률 ${(profitRate * 100).toFixed(2)}%)`,
          isPartialExit: false,
        };
      }
    } else if (profitRate <= config.stopLossPercent) {
      return {
        shouldSell: true, reason: 'stop_loss', orderType: 'MARKET',
        detail: `[${phase}] 고정 손절 (${(profitRate * 100).toFixed(2)}% ≤ ${(config.stopLossPercent * 100).toFixed(1)}%)`,
        isPartialExit: false,
      };
    }
  }

  // 2순위: ATR 기반 트레일링 — phase별 ATR 배수 + 최소 스탑
  if (globalTrailingStopEnabled && trailingStopActivated) {
    // Phase별 ATR 배수: INIT_RISK 2.5, DE_RISKED 2.0, RUNNER 2.0, WEAKENING 1.5
    const atrMultiplierByPhase: Record<PositionPhase, number> = {
      'INIT_RISK': 2.5, 'DE_RISKED': 2.0, 'RUNNER': 2.0, 'WEAKENING': 1.5,
    };
    const atrMultiplier = atrMultiplierByPhase[phase];
    let trailingStopPrice: number;

    if (atr14 !== null && atr14 > 0) {
      trailingStopPrice = highestPrice - atr14 * atrMultiplier;
      // DE_RISKED 이후: 최소 breakeven 보장
      if (phase !== 'INIT_RISK') {
        trailingStopPrice = Math.max(trailingStopPrice, avgPrice * 1.005);
      }
    } else {
      trailingStopPrice = highestPrice * (1 + config.trailingStopPercent);
    }

    if (currentPrice <= trailingStopPrice) {
      return {
        shouldSell: true, reason: 'trailing_stop', orderType: 'MARKET',
        detail: `[${phase}] 트레일링 스탑 (현재가 ${currentPrice} ≤ 스탑 ${Math.round(trailingStopPrice)}, 고점 ${highestPrice}, ATR×${atrMultiplier})`,
        isPartialExit: false,
      };
    }
  }

  // 3순위: 시간 손절 — phase별 적용 차이
  if (maxHoldingDays > 0 && holdingDays >= maxHoldingDays) {
    const maxExtended = Math.ceil(maxHoldingDays * 1.5);
    const trendHealthy = ema5 !== null && ema20 !== null && ema5 > ema20;
    const inProfit = profitRate >= 0.03;

    // RUNNER/DE_RISKED는 시간 손절 면제 (trailing이 관리)
    if (phase === 'RUNNER' || phase === 'DE_RISKED') {
      // trailing에 위임 — 시간 손절 skip
    } else if (trendHealthy && inProfit && holdingDays < maxExtended) {
      // 조건부 연장 허용
    } else {
      return {
        shouldSell: true, reason: 'time_stop', orderType: 'MARKET',
        detail: `[${phase}] 시간 손절 (${holdingDays}일 ≥ ${maxHoldingDays}일)`,
        isPartialExit: false,
      };
    }
  }

  // 4순위: target1 부분익절 (50%) — INIT_RISK에서만
  if (phase === 'INIT_RISK' && activeSwing && currentPrice >= activeSwing.target1) {
    const partialQty = Math.floor(state.totalQuantity / 2);
    if (partialQty > 0) {
      return {
        shouldSell: true, reason: 'profit_target', orderType: 'LIMIT',
        suggestedPrice: activeSwing.target1,
        sellQuantity: partialQty,
        isPartialExit: true,
        detail: `[INIT_RISK→DE_RISKED] target1 부분익절 50% (${partialQty}주, target=${activeSwing.target1.toLocaleString()})`,
      };
    }
  }

  // 5순위: target2 또는 고정 목표가 익절 (잔량)
  const effectiveTarget = activeSwing ? activeSwing.target2 : avgPrice * (1 + config.profitPercent);

  if (currentPrice >= effectiveTarget || profitRate >= config.profitPercent) {
    const targetPrice = Math.ceil(Math.min(effectiveTarget, avgPrice * (1 + config.profitPercent)));
    return {
      shouldSell: true, reason: 'profit_target', orderType: 'LIMIT',
      suggestedPrice: targetPrice,
      detail: `[${phase}] ${activeSwing ? `target2 익절 (${(profitRate * 100).toFixed(2)}%, target2=${effectiveTarget.toLocaleString()})` : `익절 (${(profitRate * 100).toFixed(2)}%)`}`,
      isPartialExit: false,
    };
  }

  // 6순위: EMA 추세 이탈 — WEAKENING phase에서는 즉시, 그 외는 3일 후
  // D1 실험: INIT_RISK에서 ema_break 비활성화 옵션
  const skipEmaBreak = options?.disableEmaBreakInInitRisk && phase === 'INIT_RISK';
  if (!skipEmaBreak) {
    const emaBreakMinDays = phase === 'WEAKENING' ? 1 : 3;
    if (holdingDays >= emaBreakMinDays && ema5 !== null && ema20 !== null) {
      if (ema5 < ema20 && currentPrice < ema20) {
        return {
          shouldSell: true, reason: 'ema_break', orderType: 'MARKET',
          detail: `[${phase}] EMA 추세이탈 (EMA5 ${ema5.toFixed(0)} < EMA20 ${ema20.toFixed(0)}, 가격 ${currentPrice})`,
          isPartialExit: false,
        };
      }
    }
  }

  return noExit;
}

// ==================== 상태 전이 ====================

export function determineCheckInterval(
  state: SwingState,
  readinessScore: number,
  pullbackState?: SwingPullbackState,
): { newStatus: SwingStatus; checkInterval: 5 | 15 } {
  switch (state.status) {
    case 'watching':
      // SUPPORT_TEST 이상이면 ready 전환 (5분 체크)
      if (pullbackState === 'READY_TO_TRIGGER' || pullbackState === 'ENTRY_SIGNAL') {
        return { newStatus: 'ready', checkInterval: 5 };
      }
      if (pullbackState === 'SUPPORT_TEST' && readinessScore >= 50) {
        return { newStatus: 'ready', checkInterval: 5 };
      }
      // RECOVERING 상태는 5분 체크로 회복 모니터링
      if (pullbackState === 'RECOVERING') {
        return { newStatus: 'watching', checkInterval: 5 };
      }
      return { newStatus: 'watching', checkInterval: 15 };

    case 'ready':
      // HARD/SOFT 무효화 시 watching 복귀
      if (pullbackState === 'HARD_INVALIDATED' || pullbackState === 'SOFT_INVALIDATED' || readinessScore < 30) {
        return { newStatus: 'watching', checkInterval: 15 };
      }
      // TRENDING (아직 조정 없음)으로 복귀
      if (pullbackState === 'TRENDING' && readinessScore < 40) {
        return { newStatus: 'watching', checkInterval: 15 };
      }
      // RECOVERING 유지하면서 관찰
      if (pullbackState === 'RECOVERING') {
        return { newStatus: 'watching', checkInterval: 5 };
      }
      return { newStatus: 'ready', checkInterval: 5 };

    case 'holding':
      return { newStatus: 'holding', checkInterval: 5 };
    case 'trailing':
      return { newStatus: 'trailing', checkInterval: 5 };
    default:
      return { newStatus: state.status, checkInterval: 15 };
  }
}

export function updateTrailingStop(
  state: SwingState,
  currentPrice: number,
  trailingStopEnabled: boolean,
): { highestPrice: number; trailingStopActivated: boolean; trailingStopPrice: number } {
  const newHighest = Math.max(state.highestPrice, currentPrice);
  const profitRate = (currentPrice - state.avgPrice) / state.avgPrice;
  const activationThreshold = state.config.profitPercent * 0.5;
  const shouldActivate = trailingStopEnabled && profitRate >= activationThreshold;
  const trailingStopPrice = newHighest * (1 + state.config.trailingStopPercent);
  return {
    highestPrice: newHighest,
    trailingStopActivated: state.trailingStopActivated || shouldActivate,
    trailingStopPrice,
  };
}

// ==================== 유틸 ====================

export function calculateAvgPrice(buyRecords: SwingBuyRecord[]): {
  avgPrice: number; totalQuantity: number; totalInvested: number;
} {
  if (buyRecords.length === 0) return { avgPrice: 0, totalQuantity: 0, totalInvested: 0 };
  const totalQuantity = buyRecords.reduce((sum, r) => sum + r.quantity, 0);
  const totalInvested = buyRecords.reduce((sum, r) => sum + r.amount, 0);
  const avgPrice = totalQuantity > 0 ? totalInvested / totalQuantity : 0;
  return { avgPrice, totalQuantity, totalInvested };
}

export function getDefaultSwingTickerConfig(
  ticker: string, stockName: string, globalConfig: SwingConfig,
): SwingTickerConfig {
  return {
    ticker, stockName,
    principal: 1000000,
    profitPercent: globalConfig.defaultProfitPercent,
    stopLossPercent: globalConfig.defaultStopLossPercent,
    trailingStopPercent: globalConfig.trailingStopPercent,
    maxAdditionalBuys: 2,
    additionalBuyDropPercent: -0.03,
    entryStrategy: 'ema_pullback',
  };
}

export function getDefaultSwingConfig(): SwingConfig {
  return {
    tickers: [],
    globalPrincipal: 5000000,
    maxPositions: 5,
    defaultProfitPercent: 0.03,
    defaultStopLossPercent: -0.02,
    trailingStopEnabled: true,
    trailingStopPercent: -0.02,
    maxHoldingDays: 14,
  };
}

export function createInitialSwingState(
  tickerConfig: SwingTickerConfig, globalConfig: SwingConfig, cycleNumber: number,
): SwingState {
  return {
    ticker: tickerConfig.ticker,
    stockName: tickerConfig.stockName,
    status: 'watching',
    entryStrategy: tickerConfig.entryStrategy,
    checkInterval: 15,
    readinessScore: 0,
    pullbackState: 'TRENDING',
    buyRecords: [],
    avgPrice: 0, totalQuantity: 0, totalInvested: 0,
    entryDate: null, holdingDays: 0,
    highestPrice: 0, trailingStopActivated: false, trailingStopPrice: 0, partialExitDone: false, positionPhase: 'INIT_RISK', initialTradeStop: undefined,
    indicators: {
      ema5: null, ema20: null, ema60: null, rsi14: null,
      macd: null, macdSignal: null, macdHist: null,
      currentPrice: 0, ema20_5m: null, rsi14_5m: null,
      dailyVolume: 0, avgVolume20: null, tradingValue: null, atr14: null,
    },
    config: {
      principal: tickerConfig.principal,
      profitPercent: tickerConfig.profitPercent,
      stopLossPercent: tickerConfig.stopLossPercent,
      trailingStopPercent: tickerConfig.trailingStopPercent ?? globalConfig.trailingStopPercent,
      maxAdditionalBuys: tickerConfig.maxAdditionalBuys,
      additionalBuyDropPercent: tickerConfig.additionalBuyDropPercent,
    },
    cycleNumber,
  };
}
