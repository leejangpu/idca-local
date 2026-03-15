/**
 * 떨사오팔 계산 모듈
 *
 * 핵심 규칙:
 * - 매수: LOC 매수, 전일 종가 (종가 ≤ 전일 종가면 체결)
 * - 매도: LOC 매도, 매수가 × (1 + x%) (매수 기록별 개별 주문)
 * - 첫 매수: LOC 매수, 현재가 +10% (체결 보장)
 * - 강제 매도: MOC, N영업일 무거래 시 보유 절반 강제 매도
 */

// ==================== 타입 정의 ====================

export interface BuyRecord {
  id: string;               // 고유 ID
  buyPrice: number;          // 매수 체결가
  quantity: number;          // 매수 수량
  buyAmount: number;         // 매수 금액 (buyPrice × quantity)
  buyDate: string;           // 매수 체결일 (YYYY-MM-DD)
}

export interface DdsobCalculateParams {
  ticker: string;
  currentPrice: number;
  previousClose: number;     // 전일 종가

  // 사이클 상태
  buyRecords: BuyRecord[];   // 현재 보유 매수 기록
  splitCount: number;        // 분할 수 (n)
  profitPercent: number;     // 익절 목표 (x%, 소수: 0.01 = 1%)
  amountPerRound: number;    // 1회분 금액

  // 첫 매수 여부
  isFirstBuy: boolean;       // 사이클 첫 매수 여부

  // 강제 매도
  forceSellDays: number;     // 강제 매도 조건 (0=비활성)
  daysWithoutTrade: number;  // 매수도 매도도 없는 연속 영업일 수

  // 최대 매수 횟수 (강제 매도 시 감소)
  maxRounds: number;         // 현 사이클 최대 매수 횟수 (초기값 = splitCount)
}

export interface DdsobOrder {
  side: 'BUY' | 'SELL';
  orderType: 'LOC' | 'MOC';
  price: number;
  quantity: number;
  amount: number;
  label: string;
  buyRecordId?: string;      // 매도 시 대응 매수 기록 ID
  isForceSell?: boolean;     // 강제 매도 여부
}

export interface DdsobCalculateResult {
  // 매매 판단
  action: 'buy' | 'sell' | 'both' | 'hold' | 'force_sell';
  actionReason: string;

  // 주문 정보
  buyOrders: DdsobOrder[];
  sellOrders: DdsobOrder[];

  // 분석 정보
  analysis: {
    usedRounds: number;        // 사용 중인 회분
    availableRounds: number;   // 매수 가능 회분
    maxRounds: number;         // 현 사이클 최대 매수 횟수
    totalBuyRecords: number;   // 보유 매수 기록 수
    amountPerRound: number;    // 1회분 금액
    daysWithoutTrade: number;  // 무거래 연속일
    forceSellDays: number;     // 강제 매도 기준
  };
}

// ==================== 유틸리티 함수 ====================

/**
 * 금액 기반 수량 계산 (소수점 내림)
 */
export function calculateQuantity(amount: number, price: number): number {
  if (price <= 0) return 0;
  return Math.floor(amount / price);
}

/**
 * 고유 ID 생성 (매수 기록용)
 */
export function generateBuyRecordId(): string {
  return `br_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;
}

// ==================== 주문 생성 함수 ====================

/**
 * 매수 주문 생성
 * - 첫 매수: LOC, 현재가 × 1.10 (체결 보장)
 * - 이후: LOC, 전일 종가
 */
export function generateBuyOrder(
  ticker: string,
  currentPrice: number,
  previousClose: number,
  amountPerRound: number,
  isFirstBuy: boolean
): DdsobOrder | null {
  const buyPrice = isFirstBuy
    ? Math.round(currentPrice * 1.10 * 100) / 100   // 첫 매수: +10%
    : Math.round(previousClose * 100) / 100;          // 이후: 전일 종가

  if (buyPrice <= 0) return null;

  const quantity = calculateQuantity(amountPerRound, buyPrice);
  if (quantity <= 0) return null;

  const amount = Math.round(buyPrice * quantity * 100) / 100;

  return {
    side: 'BUY',
    orderType: 'LOC',
    price: buyPrice,
    quantity,
    amount,
    label: isFirstBuy
      ? `첫 매수 LOC ${quantity}주 @ $${buyPrice.toFixed(2)} (현재가+10%) [${ticker}]`
      : `매수 LOC ${quantity}주 @ $${buyPrice.toFixed(2)} (전일종가) [${ticker}]`,
  };
}

/**
 * 매도 주문 생성 (매수 기록별 개별)
 * LOC 매도: 매수가 × (1 + x%)
 */
export function generateSellOrders(
  ticker: string,
  buyRecords: BuyRecord[],
  profitPercent: number
): DdsobOrder[] {
  return buyRecords.map(record => {
    const sellPrice = Math.round(record.buyPrice * (1 + profitPercent) * 100) / 100;
    const amount = Math.round(sellPrice * record.quantity * 100) / 100;

    return {
      side: 'SELL' as const,
      orderType: 'LOC' as const,
      price: sellPrice,
      quantity: record.quantity,
      amount,
      label: `매도 LOC ${record.quantity}주 @ $${sellPrice.toFixed(2)} (매수가 $${record.buyPrice.toFixed(2)} +${(profitPercent * 100).toFixed(1)}%) [${ticker}]`,
      buyRecordId: record.id,
    };
  });
}

/**
 * 강제 매도 주문 생성
 * MOC(장마감 시장가), 오래된 매수 기록부터 절반
 */
export function generateForceSellOrders(
  ticker: string,
  buyRecords: BuyRecord[]
): DdsobOrder[] {
  if (buyRecords.length === 0) return [];

  const numToSell = Math.max(1, Math.floor(buyRecords.length / 2));

  // 오래된 순 정렬 (id에 timestamp 포함)
  const sorted = [...buyRecords].sort((a, b) => a.id.localeCompare(b.id));
  const targets = sorted.slice(0, numToSell);

  return targets.map(record => ({
    side: 'SELL' as const,
    orderType: 'MOC' as const,
    price: 0, // MOC는 시장가
    quantity: record.quantity,
    amount: 0, // 체결 시 결정
    label: `강제매도 MOC ${record.quantity}주 (매수가 $${record.buyPrice.toFixed(2)}) [${ticker}]`,
    buyRecordId: record.id,
    isForceSell: true,
  }));
}

// ==================== 메인 계산 함수 ====================

/**
 * 떨사오팔 매매 계산
 */
export function calculateDdsob(params: DdsobCalculateParams): DdsobCalculateResult {
  const {
    ticker,
    currentPrice,
    previousClose,
    buyRecords,
    profitPercent,
    amountPerRound,
    isFirstBuy,
    forceSellDays,
    daysWithoutTrade,
    maxRounds,
  } = params;

  const usedRounds = buyRecords.length;
  const availableRounds = maxRounds - usedRounds;

  const buyOrders: DdsobOrder[] = [];
  const sellOrders: DdsobOrder[] = [];
  let action: DdsobCalculateResult['action'] = 'hold';
  let actionReason = '';

  // 1. 강제 매도 체크 (최우선)
  if (
    forceSellDays > 0 &&
    buyRecords.length > 0 &&
    daysWithoutTrade >= forceSellDays
  ) {
    const forceSells = generateForceSellOrders(ticker, buyRecords);
    sellOrders.push(...forceSells);
    action = 'force_sell';
    actionReason = `${daysWithoutTrade}영업일 무거래 → ${forceSells.length}건 강제매도(MOC)`;

    return {
      action,
      actionReason,
      buyOrders,
      sellOrders,
      analysis: {
        usedRounds,
        availableRounds,
        maxRounds,
        totalBuyRecords: buyRecords.length,
        amountPerRound,
        daysWithoutTrade,
        forceSellDays,
      },
    };
  }

  // 2. 일반 매도 주문 생성 (매수 기록별)
  if (buyRecords.length > 0) {
    const sells = generateSellOrders(ticker, buyRecords, profitPercent);
    sellOrders.push(...sells);
  }

  // 3. 매수 주문 생성 (가용 회분이 있을 때)
  if (availableRounds > 0) {
    const buyOrder = generateBuyOrder(ticker, currentPrice, previousClose, amountPerRound, isFirstBuy);
    if (buyOrder) {
      buyOrders.push(buyOrder);
    }
  }

  // 4. 액션 판단
  if (buyOrders.length > 0 && sellOrders.length > 0) {
    action = 'both';
    actionReason = `매수 ${buyOrders.length}건 + 매도 ${sellOrders.length}건 주문`;
  } else if (buyOrders.length > 0) {
    action = 'buy';
    actionReason = isFirstBuy
      ? `첫 매수 (현재가 $${currentPrice.toFixed(2)}, +10% LOC)`
      : `매수 (전일종가 $${previousClose.toFixed(2)} LOC)`;
  } else if (sellOrders.length > 0) {
    action = 'sell';
    actionReason = `매도 ${sellOrders.length}건 (전량 소진, 매수 없음)`;
  } else {
    actionReason = '주문 없음 (가용 회분 및 매수 기록 없음)';
  }

  return {
    action,
    actionReason,
    buyOrders,
    sellOrders,
    analysis: {
      usedRounds,
      availableRounds,
      maxRounds,
      totalBuyRecords: buyRecords.length,
      amountPerRound,
      daysWithoutTrade,
      forceSellDays,
    },
  };
}
