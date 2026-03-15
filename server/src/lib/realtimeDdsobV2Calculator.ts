/**
 * 실사오팔v2 (Realtime DDSOB V2) 계산 모듈
 *
 * 실사오팔의 독립 복사본. 기존 실사오팔(v1)과 완전히 분리되어 독립적으로 수정 가능.
 * 국내주식(domestic) + 해외주식(overseas) 듀얼 마켓 지원.
 *
 * 핵심 규칙 (v2 전략):
 * - 매수: LIMIT 매수, 현재가 × (1 + buffer) (현재가 ≤ 평단가일 때, 첫 매수는 무조건)
 * - 매도: 평균단가 기반 단일 LIMIT 매도 — KIS 평단가 × (1 + profitPercent) 에 전량 매도
 *         체결 가능 여부와 무관하게 보유 중이면 항상 매도 주문
 * - 매도 우선: currentPrice >= 매도목표가 이면 매수 스킵
 * - 첫 매수: LIMIT 매수, 현재가 × (1 + buffer) (무조건 체결)
 * - 강제 매도: 제거됨 (v2에서 비활성)
 */

import { MarketType, roundPrice, formatPrice, roundToKoreanTick, roundToKoreanTickCeil } from './marketUtils';

// ==================== 타입 정의 ====================

export interface RealtimeBuyRecordV2 {
  id: string;               // 고유 ID
  buyPrice: number;          // 매수 체결가
  quantity: number;          // 매수 수량
  buyAmount: number;         // 매수 금액 (buyPrice × quantity)
  buyDate: string;           // 매수 체결 시각 (ISO datetime)
  rsi5m?: number | null;     // 매수 시점 5분봉 RSI
  rsi15m?: number | null;    // 매수 시점 15분봉 RSI
  rsi5mBars?: number;        // RSI 계산에 사용된 5분봉 캔들 수
  rsi15mBars?: number;       // RSI 계산에 사용된 15분봉 캔들 수
}

export interface RealtimeDdsobV2CalculateParams {
  ticker: string;
  market?: MarketType;       // 국내/해외 (기본: 'overseas')
  currentPrice: number;
  previousPrice: number;     // 이전 체크 시점 현재가 (기준가)

  // 사이클 상태
  buyRecords: RealtimeBuyRecordV2[];
  splitCount: number;
  profitPercent: number;     // 익절 목표 (0.01 = 1%)
  amountPerRound: number;

  // 첫 매수 여부
  isFirstBuy: boolean;

  // 최대 매수 횟수
  maxRounds: number;

  // 지정가 버퍼
  bufferPercent: number;     // 버퍼 (0.01 = 1%)

  // KIS API 잔고 정보 (평단가 기반 매도용)
  kisAvgPrice: number;       // KIS API 평단가 (pchs_avg_pric)
  kisHoldingQty: number;     // KIS API 보유수량

  // 캔들 카운터 (분석용으로 유지, 강제매도에는 사용하지 않음)
  candlesSinceCycleStart: number;

  // 국내주식 호가단위 (API에서 조회, 없으면 가격대별 자동 계산)
  tickSize?: number;

  // 최소 낙폭 (0.001 = 0.1%, 평단가 대비 이 이상 하락해야 매수, 0=비활성)
  minDropPercent?: number;

  // 피크 확인: 직전 캔들이 N캔들 중 고점이면 매수 스킵
  recentPrices?: number[];     // 최근 N캔들 가격 배열
  peakCheckCandles?: number;   // 피크 확인 캔들 수 (0=비활성, 기본: 10)
}

export interface RealtimeDdsobV2Order {
  side: 'BUY' | 'SELL';
  orderType: 'LIMIT';       // 항상 LIMIT (지정가)
  price: number;             // 지정가 (버퍼 적용)
  quantity: number;
  amount: number;
  label: string;
  buyRecordId?: string;      // 매도 시 대응 매수 기록 ID
  isForceSell?: boolean;     // 강제 매도 여부
}

export interface RealtimeDdsobV2CalculateResult {
  action: 'buy' | 'sell' | 'both' | 'hold';
  actionReason: string;

  buyOrders: RealtimeDdsobV2Order[];
  sellOrders: RealtimeDdsobV2Order[];

  // 매도 가능 상태 (currentPrice >= targetSellPrice) — 매수 스킵 판단에 사용
  sellable: boolean;
  targetSellPrice: number;   // 평단가 기반 매도 목표가 (0이면 보유 없음)

  analysis: {
    usedRounds: number;
    availableRounds: number;
    maxRounds: number;
    totalBuyRecords: number;
    amountPerRound: number;
    candlesSinceCycleStart: number;
    kisAvgPrice: number;
    kisHoldingQty: number;
  };
}

// ==================== 유틸리티 함수 ====================

/**
 * 금액 기반 수량 계산 (소수점 내림)
 */
export function calculateQuantityV2(amount: number, price: number): number {
  if (price <= 0) return 0;
  return Math.floor(amount / price);
}

/**
 * 고유 ID 생성 (매수 기록용)
 */
export function generateRealtimeBuyRecordIdV2(): string {
  return `rbr_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;
}

/**
 * 주문 가격 반올림 (마켓별)
 * - 해외: 소수점 2자리
 * - 국내: 호가단위 반올림
 */
function roundOrderPrice(price: number, market: MarketType, tickSize?: number): number {
  if (market === 'domestic') {
    return roundToKoreanTick(price, tickSize);
  }
  return roundPrice(price, market);
}

/**
 * 매도 목표가 전용 반올림 (마켓별, 올림)
 * - 해외: 소수점 2자리 올림
 * - 국내: 호가단위 올림 → 최소 익절 마진 보장
 */
function roundSellTargetPrice(price: number, market: MarketType, tickSize?: number): number {
  if (market === 'domestic') {
    return roundToKoreanTickCeil(price, tickSize);
  }
  return Math.ceil(price * 100) / 100;
}

// ==================== 점증 분할 (Ascending Split) ====================

/**
 * 급경사 점증 분할: 회차별 매수금액 계산
 *
 * 가중치: [2^0, 2^1, ..., 2^(splitCount-1)] (급경사)
 * 최소 1주(국내) 보장 후 나머지를 가중치로 배분.
 * minOrderAmount 미달 시 균등 배분 fallback.
 *
 * @param principal      원금
 * @param splitCount     총 분할 수
 * @param roundIndex     현재 회차 (0-indexed, buyRecords.length)
 * @param buyPrice       매수 예상가 (1주 보장 기준)
 * @param minOrderAmount 최소 주문금액 (기본: 0)
 * @returns 이번 회차 매수금액
 */
export function getAscendingAmountForRound(
  principal: number,
  splitCount: number,
  roundIndex: number,
  buyPrice: number,
  minOrderAmount: number = 0,
): number {
  if (splitCount <= 0 || roundIndex < 0 || roundIndex >= splitCount) {
    return principal / Math.max(splitCount, 1);
  }

  const equalAmount = principal / splitCount;
  const weight = Math.pow(2, roundIndex);
  const weightSum = Math.pow(2, splitCount) - 1;

  if (minOrderAmount > 0) {
    // 소수점 매수 가능한 경우: 원금 전체를 가중치로 배분
    // 최소주문금액 미달 회차는 minOrderAmount로 보정, 초과분은 후반 회차에서 차감
    const rawAmounts: number[] = [];
    for (let i = 0; i < splitCount; i++) {
      rawAmounts.push(principal * Math.pow(2, i) / weightSum);
    }
    // 최소주문금액 보정: 미달 회차를 올리고 초과분을 후반에서 차감
    let deficit = 0;
    for (let i = 0; i < splitCount; i++) {
      if (rawAmounts[i] < minOrderAmount) {
        deficit += minOrderAmount - rawAmounts[i];
        rawAmounts[i] = minOrderAmount;
      }
    }
    // 후반 회차(큰 순서)에서 deficit 차감
    for (let i = splitCount - 1; i >= 0 && deficit > 0; i--) {
      const canDeduct = rawAmounts[i] - minOrderAmount;
      if (canDeduct > 0) {
        const deduct = Math.min(canDeduct, deficit);
        rawAmounts[i] -= deduct;
        deficit -= deduct;
      }
    }
    // deficit 해소 불가 시 균등 배분
    if (deficit > 0) {
      return equalAmount;
    }
    return rawAmounts[roundIndex];
  }

  // 국내: 1주 보장 후 나머지 배분
  const baseTotalCost = buyPrice * splitCount;
  const remaining = principal - baseTotalCost;

  if (remaining <= 0) {
    return equalAmount;
  }

  return buyPrice + remaining * weight / weightSum;
}

/**
 * 점증 분할 가격 필터 상한가
 *
 * 마지막 회차가 첫 회차의 minLastRatio배 이상 매수 가능하도록
 * maxPrice = principal / (splitCount + (minLastRatio - 1) × 2)
 */
export function getAscendingMaxPrice(
  principal: number,
  splitCount: number,
  minLastRatio: number = 5,
): number {
  const weightConstant = 2; // 급경사 모드: w_sum/w_max ≈ 2
  return Math.floor(principal / (splitCount + (minLastRatio - 1) * weightConstant));
}

// ==================== 주문 생성 함수 ====================

/**
 * 매수 주문 생성
 * LIMIT 매수: 현재가 × (1 + buffer)
 */
export function generateRealtimeBuyOrderV2(
  ticker: string,
  currentPrice: number,
  previousPrice: number,
  amountPerRound: number,
  isFirstBuy: boolean,
  bufferPercent: number,
  market: MarketType = 'overseas',
  tickSize?: number,
  minDropPercent?: number,
  avgBuyPrice?: number,
): RealtimeDdsobV2Order | null {
  // 매수 조건 (첫 매수는 무조건 통과):
  // 1) 직전 캔들보다 하락해야 함
  // 2) 평단가 대비 minDropPercent 이상 하락해야 함 (평단가 없으면 기준가 폴백)
  if (!isFirstBuy) {
    // 조건1: 직전 캔들 대비 하락
    if (currentPrice >= previousPrice) {
      return null;
    }
    // 조건2: 평단가 대비 최소 낙폭
    const refPrice = (avgBuyPrice && avgBuyPrice > 0) ? avgBuyPrice : previousPrice;
    if (currentPrice > refPrice * (1 - (minDropPercent || 0))) {
      return null;
    }
  }

  const buyPrice = roundOrderPrice(currentPrice * (1 + bufferPercent), market, tickSize);
  if (buyPrice <= 0) return null;

  const quantity = calculateQuantityV2(amountPerRound, buyPrice);
  if (quantity <= 0) return null;

  const amount = roundPrice(buyPrice * quantity, market);
  const fp = (p: number) => formatPrice(p, market);
  const refPrice = (avgBuyPrice && avgBuyPrice > 0) ? avgBuyPrice : previousPrice;
  const refLabel = (avgBuyPrice && avgBuyPrice > 0) ? '평단가' : '기준가';

  return {
    side: 'BUY',
    orderType: 'LIMIT',
    price: buyPrice,
    quantity,
    amount,
    label: isFirstBuy
      ? `첫 매수 LIMIT ${quantity}주 @ ${fp(buyPrice)} (현재가 ${fp(currentPrice)}, 기준가 ${fp(previousPrice)}) [${ticker}]`
      : `매수 LIMIT ${quantity}주 @ ${fp(buyPrice)} (현재가 ${fp(currentPrice)}, ${refLabel} ${fp(refPrice)}) [${ticker}]`,
  };
}

/**
 * 평균단가 기반 단일 매도 주문 생성
 * LIMIT 매도: KIS 평단가 × (1 + profitPercent) 에 전량 매도
 * 체결 가능 여부와 무관하게 보유 중이면 항상 1건 생성
 */
export function generateRealtimeSellOrdersV2(
  ticker: string,
  kisAvgPrice: number,
  kisHoldingQty: number,
  profitPercent: number,
  market: MarketType = 'overseas',
  tickSize?: number
): RealtimeDdsobV2Order[] {
  if (kisHoldingQty <= 0 || kisAvgPrice <= 0) return [];

  const fp = (p: number) => formatPrice(p, market);
  const targetPrice = roundSellTargetPrice(kisAvgPrice * (1 + profitPercent), market, tickSize);
  const amount = roundPrice(targetPrice * kisHoldingQty, market);

  return [{
    side: 'SELL',
    orderType: 'LIMIT',
    price: targetPrice,
    quantity: kisHoldingQty,
    amount,
    label: `매도 LIMIT ${kisHoldingQty}주 @ ${fp(targetPrice)} (평단가 ${fp(kisAvgPrice)} +${(profitPercent * 100).toFixed(1)}%) [${ticker}]`,
  }];
}

// generateRealtimeForceSellOrdersV2 — v2에서 강제매도 제거됨

// ==================== 메인 계산 함수 ====================

/**
 * 실사오팔v2 매매 계산
 *
 * 매도 전략: 평균단가 기반 단일 매도
 * 1. 보유 중(kisHoldingQty > 0) → 항상 매도 주문 1건 생성 (avgPrice × (1+n%))
 * 2. currentPrice >= targetSellPrice → 매도 가능 상태 → 매수 스킵
 * 3. currentPrice < targetSellPrice → 매수 조건 충족 시 매수도 함께 진행
 */
export function calculateRealtimeDdsobV2(params: RealtimeDdsobV2CalculateParams): RealtimeDdsobV2CalculateResult {
  const {
    ticker,
    market = 'overseas',
    currentPrice,
    previousPrice,
    buyRecords,
    profitPercent,
    amountPerRound,
    isFirstBuy,
    candlesSinceCycleStart,
    maxRounds,
    bufferPercent,
    kisAvgPrice,
    kisHoldingQty,
    tickSize,
    minDropPercent,
    recentPrices,
    peakCheckCandles,
  } = params;

  const usedRounds = buyRecords.length;
  const availableRounds = maxRounds - usedRounds;
  const fp = (p: number) => formatPrice(p, market);

  const buyOrders: RealtimeDdsobV2Order[] = [];
  const sellOrders: RealtimeDdsobV2Order[] = [];
  let action: RealtimeDdsobV2CalculateResult['action'] = 'hold';
  let actionReason = '';
  let sellable = false;
  let targetSellPrice = 0;

  // 1. 매도 주문 생성: 보유 중이면 항상 1건 (평단가 기반)
  if (kisHoldingQty > 0 && kisAvgPrice > 0) {
    const sells = generateRealtimeSellOrdersV2(ticker, kisAvgPrice, kisHoldingQty, profitPercent, market, tickSize);
    sellOrders.push(...sells);
    if (sells.length > 0) {
      targetSellPrice = sells[0].price;
      sellable = currentPrice >= targetSellPrice;
    }
  }

  // 2. 매수 주문 생성: 매도 불가능(sellable=false) + 가용 회분 있을 때
  if (!sellable && availableRounds > 0) {
    const buyOrder = generateRealtimeBuyOrderV2(
      ticker, currentPrice, previousPrice, amountPerRound, isFirstBuy, bufferPercent, market, tickSize, minDropPercent, kisAvgPrice
    );
    if (buyOrder) {
      // 피크 체크: 직전 캔들이 N캔들 중 고점이면 매수 스킵
      const pcc = peakCheckCandles || 0;
      if (pcc > 0 && recentPrices && recentPrices.length >= pcc) {
        const lastPrice = recentPrices[recentPrices.length - 1];
        const maxPrice = Math.max(...recentPrices);
        if (lastPrice >= maxPrice) {
          return {
            action: 'hold',
            actionReason: `매수 조건 충족했으나 직전 캔들(${fp(lastPrice)})이 ${pcc}캔들 중 고점 → 스킵`,
            buyOrders: [],
            sellOrders,
            sellable,
            targetSellPrice,
            analysis: {
              usedRounds, availableRounds, maxRounds,
              totalBuyRecords: buyRecords.length, amountPerRound,
              candlesSinceCycleStart, kisAvgPrice, kisHoldingQty,
            },
          };
        }
      }
      buyOrders.push(buyOrder);
    }
  }

  // 3. 액션 판단
  if (buyOrders.length > 0 && sellOrders.length > 0) {
    action = 'both';
    actionReason = `매수 1건 + 매도 1건 (평단가 ${fp(kisAvgPrice)}, 목표 ${fp(targetSellPrice)}, 현재가 ${fp(currentPrice)})`;
  } else if (buyOrders.length > 0) {
    action = 'buy';
    const refPrice = (kisAvgPrice > 0 && !isFirstBuy) ? kisAvgPrice : previousPrice;
    const refLabel = (kisAvgPrice > 0 && !isFirstBuy) ? '평단가' : '기준가';
    actionReason = isFirstBuy
      ? `첫 매수 (현재가 ${fp(currentPrice)}, 기준가 ${fp(previousPrice)}, LIMIT +${(bufferPercent * 100).toFixed(0)}%)`
      : `매수 (현재가 ${fp(currentPrice)}, ${refLabel} ${fp(refPrice)})`;
  } else if (sellOrders.length > 0) {
    action = 'sell';
    actionReason = sellable
      ? `매도만 (현재가 ${fp(currentPrice)} ≥ 목표 ${fp(targetSellPrice)}, 매수 스킵)`
      : `매도 대기 (현재가 ${fp(currentPrice)} < 목표 ${fp(targetSellPrice)}, 매수 조건 미충족)`;
  } else {
    const holdRefPrice = (kisAvgPrice > 0 && !isFirstBuy) ? kisAvgPrice : previousPrice;
    const holdRefLabel = (kisAvgPrice > 0 && !isFirstBuy) ? '평단가' : '기준가';
    actionReason = availableRounds <= 0
      ? '주문 없음 (가용 회분 소진)'
      : `주문 없음 (현재가 ${fp(currentPrice)} > ${holdRefLabel} ${fp(holdRefPrice)})`;
  }

  return {
    action,
    actionReason,
    buyOrders,
    sellOrders,
    sellable,
    targetSellPrice,
    analysis: {
      usedRounds,
      availableRounds,
      maxRounds,
      totalBuyRecords: buyRecords.length,
      amountPerRound,
      candlesSinceCycleStart,
      kisAvgPrice,
      kisHoldingQty,
    },
  };
}
