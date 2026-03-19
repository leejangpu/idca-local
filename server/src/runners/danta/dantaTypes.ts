/**
 * 단타 v1 — 타입 정의 & 설정 & 상수
 *
 * 초단타 스캘핑 전략의 전체 타입 시스템.
 * 상태 머신: NEW_CANDIDATE → WAIT_PULLBACK → READY_TO_BREAKOUT → ENTERED → EXITED
 */

// ========================================
// 후보 상태 머신 (in-memory)
// ========================================

export type CandidatePhase =
  | 'NEW_CANDIDATE'       // 조건검색에서 수신, triggerHigh 계산 대기
  | 'WAIT_PULLBACK'       // triggerHigh 설정됨, 눌림 대기
  | 'READY_TO_BREAKOUT'   // 눌림 확인, 돌파 대기
  | 'INVALIDATED';        // 3틱 이상 눌림 등으로 무효화

// ========================================
// 포지션 상태 (persisted)
// ========================================

export type PositionStatus = 'pending_buy' | 'active' | 'pending_sell';

export type ExitReason =
  | 'target'              // 익절 (+2틱)
  | 'stop_loss'           // 손절 (-2틱)
  | 'time_stop'           // 30초 경과 + MFE < +2틱 + 현재가 < +1틱
  | 'market_close'        // 장 종료 강제 청산
  | 'manual';             // 수동

// ========================================
// 후보 (in-memory, 비영속)
// ========================================

export interface DantaCandidate {
  ticker: string;
  stockName: string;
  phase: CandidatePhase;
  discoveredAt: number;               // Date.now()
  tradeAmt: number;                   // 거래대금 (우선순위용)
  bidQty1: number;                    // 1매수잔량 (우선순위 tiebreak)

  // triggerHigh: 직전 3개 1분봉 최고가 (1회 고정)
  triggerHigh: number | null;
  triggerHighSetAt: number | null;

  // pullback 추적
  pullbackLow: number | null;         // 눌림 과정 저점
  pullbackDetectedAt: number | null;

  // 현재 시세 (매 스캔 갱신)
  lastPrice: number;
  lastAskPrice: number;
  lastBidPrice: number;
  lastUpdatedAt: number;
}

// ========================================
// 포지션 (persisted to localStore)
// ========================================

export interface DantaV1State {
  ticker: string;
  stockName: string;
  market: 'domestic';
  status: PositionStatus;
  entryPrice: number;
  entryQuantity: number;
  allocatedAmount: number;
  targetPrice: number;                // 익절가 (entryPrice + 2틱)
  stopLossPrice: number;              // 손절가 (entryPrice - 2틱)
  pullbackLow: number;                // 눌림 저점 (이탈 시 손절)
  triggerHigh: number;                // 진입 기준 고점
  pendingOrderNo: string | null;
  sellOrderNo: string | null;
  enteredAt: string;                  // ISO, 체결 시점 (시간청산 기준)
  filledAt: string | null;            // 실제 체결 시점
  updatedAt: string;
  shadowMode: boolean;
  bestProfitPct: number | null;       // MFE (최대 순행)
  worstProfitPct: number | null;      // MAE (최대 역행)
  hasReachedPlusOneTick: boolean;     // +1틱 도달 여부
  hasReachedPlusTwoTicks: boolean;    // +2틱 도달 여부
}

// ========================================
// 설정
// ========================================

export interface DantaV1Config {
  enabled: boolean;
  shadowMode: boolean;
  amountPerStock: number;             // 종목당 투입 금액 (KRW)
  maxSlots: number;                   // 동시 보유 종목 수 (기본 1)
  htsUserId: string;
  conditionSeq: string;
  conditionName: string;

  // 루프 타이밍
  candidatePollIntervalMs: number;    // 15000
  entryMonitorIntervalMs: number;     // 1000
  positionMonitorIntervalMs: number;  // 400

  // 전략 파라미터
  targetTicks: number;                // 익절 틱 수 (2)
  stopTicks: number;                  // 손절 틱 수 (2)
  pullbackValidMinTicks: number;      // 유효 눌림 최소 (1)
  pullbackValidMaxTicks: number;      // 유효 눌림 최대 (2)
  pullbackInvalidTicks: number;       // 무효 눌림 틱 수 (3)
  breakoutConfirmTicks: number;       // 돌파 확인 틱 수 (1)
  timeStopSec: number;                // 시간청산 (30)

  // 리스크
  maxConsecutiveEntriesPerSymbol: number;  // 같은 종목 연속 진입 제한 (2)
  cooldownAfterStopLossSec: number;       // 손절 후 쿨다운 (300)
  forceCloseBeforeMarketEnd: boolean;     // 장 종료 전 강제 청산
  costRatePct: number;                    // 왕복 비용률 (0.23)

  // 운영 시간 (KST 분 단위, e.g. 545 = 09:05)
  entryStartMinute: number;           // 545
  entryEndMinute: number;             // 900 (15:00)

  // safe mode: REST fallback 지속 시 신규 진입 중단 (ms)
  safeModeAfterFallbackMs: number;    // 60000 (60초)

  // NEW_CANDIDATE TTL: triggerHigh 미계산 후보 만료 (ms)
  newCandidateTtlMs: number;          // 120000 (2분)

  // warm-up: fallback 종료 후 정상 tick 확인 구간 (ms)
  warmupAfterFallbackMs: number;      // 5000 (5초)
}

// ========================================
// 로그 엔트리
// ========================================

export interface OrderLogEntry {
  type: 'BUY' | 'SELL';
  ticker: string;
  stockName: string;
  price: number;
  quantity: number;
  amount: number;
  orderType: 'LIMIT' | 'MARKET';
  shadowMode: boolean;
  reason: string;
  orderNo: string | null;
  timestamp: string;
}

export interface TradeLogEntry {
  ticker: string;
  stockName: string;
  entryPrice: number;
  exitPrice: number;
  quantity: number;
  entryAmount: number;
  exitAmount: number;
  profitAmount: number;
  profitRatePct: number;
  netPnlPct: number;
  exitReason: ExitReason;
  triggerHigh: number;
  pullbackLow: number;
  holdTimeSec: number;
  shadowMode: boolean;
  timestamp: string;
}

// ========================================
// 쿨다운 & 재진입 추적
// ========================================

export interface TickerCooldown {
  ticker: string;
  reason: ExitReason;
  expiresAt: number;          // Date.now() + cooldown ms
}

export interface TickerEntryCount {
  ticker: string;
  count: number;
  lastEntryAt: number;
}

// ========================================
// 상수
// ========================================

export const DANTA_STATE_COLLECTION = 'dantaV1State';
export const DANTA_TRADE_LOGS = 'dantaTradeLogs';
export const DANTA_SHADOW_LOGS = 'dantaShadowLogs';
export const DANTA_SCAN_LOGS = 'dantaScanLogs';
export const DANTA_ORDER_LOGS = 'dantaOrderLogs';

// ========================================
// 기본 설정값
// ========================================

export const DEFAULT_DANTA_CONFIG: Omit<DantaV1Config, 'htsUserId' | 'conditionSeq' | 'conditionName'> = {
  enabled: false,
  shadowMode: true,
  amountPerStock: 500_000,
  maxSlots: 1,
  candidatePollIntervalMs: 15_000,
  entryMonitorIntervalMs: 1_000,
  positionMonitorIntervalMs: 400,
  targetTicks: 2,
  stopTicks: 2,
  pullbackValidMinTicks: 1,
  pullbackValidMaxTicks: 2,
  pullbackInvalidTicks: 3,
  breakoutConfirmTicks: 1,
  timeStopSec: 30,
  maxConsecutiveEntriesPerSymbol: 2,
  cooldownAfterStopLossSec: 300,
  forceCloseBeforeMarketEnd: true,
  costRatePct: 0.23,
  entryStartMinute: 545,   // 09:05
  entryEndMinute: 900,      // 15:00
  safeModeAfterFallbackMs: 60_000,  // 60초
  newCandidateTtlMs: 120_000,       // 2분
  warmupAfterFallbackMs: 5_000,     // 5초
};
