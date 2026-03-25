/**
 * 단타 v2 — 타입 정의 & 설정 & 상수
 *
 * 조건검색 → 즉시 매수 → 청산 감시.
 * 후보 등록/눌림/돌파 단계 없이 조건검색 결과를 바로 진입.
 */

// ========================================
// 포지션 상태 (persisted)
// ========================================

export type PositionStatus = 'pending_buy' | 'active' | 'pending_sell';

export type ExitReason =
  | 'target'              // 익절 (+N%)
  | 'stop_loss'           // 손절 (-N%)
  | 'time_stop'           // 시간청산
  | 'market_close'        // 장 종료 강제 청산
  | 'manual';             // 수동

// ========================================
// 포지션 (persisted to localStore)
// ========================================

export interface DantaV2State {
  ticker: string;
  stockName: string;
  market: 'domestic';
  status: PositionStatus;
  entryPrice: number;
  entryQuantity: number;
  allocatedAmount: number;
  targetPrice: number;
  stopLossPrice: number;
  pendingOrderNo: string | null;
  sellOrderNo: string | null;
  enteredAt: string;                  // ISO, 체결 시점 (시간청산 기준)
  filledAt: string | null;            // 실제 체결 시점
  updatedAt: string;
  shadowMode: boolean;
  bestProfitPct: number | null;       // MFE (최대 순행)
  worstProfitPct: number | null;      // MAE (최대 역행)
  hasReachedHalfTarget: boolean;      // 목표의 절반 도달 여부
  hasReachedTarget: boolean;          // 목표가 도달 여부
}

// ========================================
// 설정
// ========================================

export interface DantaV2Config {
  enabled: boolean;
  shadowMode: boolean;
  amountPerStock: number;             // 종목당 투입 금액 (KRW)
  maxSlots: number;                   // 동시 보유 종목 수 (기본 1)
  htsUserId: string;
  conditionSeq: string;
  conditionName: string;

  // 루프 타이밍
  candidatePollIntervalMs: number;    // 조건검색 간격 (15000)
  positionMonitorIntervalMs: number;  // 포지션 감시 간격 (400)

  // 전략 파라미터
  targetPct: number;                  // 익절 % (0.5)
  stopPct: number;                    // 손절 % (0.5)
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

export const DANTA_STATE_COLLECTION = 'dantaV2State';
export const DANTA_TRADE_LOGS = 'dantaTradeLogs';
export const DANTA_SHADOW_LOGS = 'dantaShadowLogs';
export const DANTA_SCAN_LOGS = 'dantaScanLogs';
export const DANTA_ORDER_LOGS = 'dantaOrderLogs';

// ========================================
// 기본 설정값
// ========================================

export const DEFAULT_DANTA_CONFIG: Omit<DantaV2Config, 'htsUserId' | 'conditionSeq' | 'conditionName'> = {
  enabled: false,
  shadowMode: true,
  amountPerStock: 500_000,
  maxSlots: 1,
  candidatePollIntervalMs: 15_000,
  positionMonitorIntervalMs: 400,
  targetPct: 0.5,
  stopPct: 0.5,
  timeStopSec: 30,
  maxConsecutiveEntriesPerSymbol: 0,
  cooldownAfterStopLossSec: 0,
  forceCloseBeforeMarketEnd: true,
  costRatePct: 0.23,
  entryStartMinute: 540,   // 09:00
  entryEndMinute: 900,      // 15:00
  safeModeAfterFallbackMs: 60_000,  // 60초
  warmupAfterFallbackMs: 5_000,     // 5초
};
