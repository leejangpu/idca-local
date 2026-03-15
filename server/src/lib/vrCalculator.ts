/**
 * VR(밸류 리밸런싱) 계산 모듈
 *
 * 핵심 공식:
 * V₂ = V₁ + Pool/G ± (적립금 or 인출금)
 * 최소밴드 = V × 0.85
 * 최대밴드 = V × 1.15
 *
 * 매매 규칙:
 * - 평가금 < 최소밴드 → 매수 (밴드 안으로 복귀)
 * - 평가금 > 최대밴드 → 매도 (밴드 안으로 복귀)
 * - 최소 ≤ 평가금 ≤ 최대 → 매매 없음
 */

// ==================== 타입 정의 ====================

export type VRInvestmentMode = 'accumulate' | 'lump' | 'withdraw';
export type VRFormulaType = 'basic' | 'skill';

// VR 잔량주문 (사이클 동안 유지되는 예약 주문)
export interface VRPendingOrder {
  orderIndex: number;            // 주문 순서 (1부터 시작)
  price: number;                 // 지정가
  quantity: number;              // 수량 (기본 1주)
  targetQuantity: number;        // 체결 후 목표 보유수량 (매수: 현재+n, 매도: 현재-n)
  filled: boolean;               // 체결 여부
  filledAt?: Date;               // 체결 시각
  filledPrice?: number;          // 실제 체결가
}

// VR 잔량주문 세트
export interface VRPendingOrders {
  buy: VRPendingOrder[];
  sell: VRPendingOrder[];
  initializedAt: Date;           // 주문 초기화 시점
  baseQuantity: number;          // 초기화 시점 보유 수량
}

export interface VRCalculateParams {
  ticker: string;
  currentPrice: number;
  totalQuantity: number;

  // VR 상태
  targetValue: number;        // V (목표 평가금)
  pool: number;               // Pool (현금 보유액)
  gradient: number;           // G (기울기)
  bandPercent: number;        // 밴드 퍼센트 (0.15)

  // 설정
  investmentMode: VRInvestmentMode;
  periodicAmount: number;     // 적립금/인출금

  // 사이클 정보
  cycleNumber: number;
  lastVUpdateDate: Date;

  // Pool 사용 한도 계산용
  weekNumber: number;         // 현재 주차 (0부터 시작)
}

export interface VROrder {
  orderType: 'LOC' | 'LIMIT' | 'MOO' | 'LOO';
  price: number;
  quantity: number;
  amount: number;
  label: string;
}

export interface VRCalculateResult {
  // 현재 상태
  currentEvaluation: number;    // 현재 평가금 (수량 × 현재가)
  targetValue: number;          // V
  minBand: number;              // 최소밴드
  maxBand: number;              // 최대밴드

  // 매매 판단
  action: 'buy' | 'sell' | 'hold';
  actionReason: string;

  // 주문 정보
  buyOrders: VROrder[];
  sellOrders: VROrder[];

  // 분석 정보
  analysis: {
    deviationPercent: number;   // 밴드 이탈 비율
    poolUsageLimit: number;     // Pool 사용 한도
    poolAvailable: number;      // 사용 가능 Pool
    currentProfitRate: number;  // 현재 수익률 (평가금 기준)
  };

  // 다음 V 업데이트 정보
  nextVUpdate: {
    needsUpdate: boolean;       // V 업데이트 필요 여부 (2주 경과)
    newTargetValue?: number;    // 새 V 값
    daysUntilUpdate: number;    // 업데이트까지 남은 일수
  };
}

// ==================== 계산 함수 ====================

/**
 * Pool 사용 한도 계산
 * 적립식: 75% → 점차 감소
 * 거치식: 50% → 점차 감소
 * 인출식: 25% → 점차 감소
 *
 * 26주마다 5%씩 감소, 최소 10%까지
 */
export function calculatePoolUsageLimit(
  mode: VRInvestmentMode,
  weekNumber: number
): number {
  const baseLimit =
    mode === 'accumulate' ? 0.75 :
    mode === 'lump' ? 0.50 :
    0.25;

  // 26주(약 6개월)마다 5% 감소
  const decaySteps = Math.floor(weekNumber / 26);
  const decayAmount = decaySteps * 0.05;
  const result = baseLimit - decayAmount;

  return Math.max(0.10, Math.min(result, baseLimit));
}

/**
 * 밴드 계산
 */
export function calculateBands(
  targetValue: number,
  bandPercent: number
): { minBand: number; maxBand: number } {
  return {
    minBand: Math.round(targetValue * (1 - bandPercent) * 100) / 100,
    maxBand: Math.round(targetValue * (1 + bandPercent) * 100) / 100,
  };
}

/**
 * V값 업데이트 계산 (2주 사이클)
 * 기본공식: V₂ = V₁ + Pool/G ± (적립금 or 인출금)
 * 실력공식: V₂ = V₁ + Pool/G + (E - V₁)/(2√G) ± (적립금 or 인출금)
 */
export function calculateNewTargetValue(
  currentV: number,
  pool: number,
  gradient: number,
  periodicAmount: number,
  mode: VRInvestmentMode,
  formulaType: VRFormulaType = 'basic',
  currentEvaluation?: number
): number {
  const poolContribution = pool / gradient;
  const periodicContribution = mode === 'withdraw' ? -Math.abs(periodicAmount) : periodicAmount;

  let skillAdjustment = 0;
  if (formulaType === 'skill' && currentEvaluation !== undefined) {
    skillAdjustment = (currentEvaluation - currentV) / (2 * Math.sqrt(gradient));
  }

  const newV = currentV + poolContribution + skillAdjustment + periodicContribution;
  return Math.round(newV * 100) / 100;
}

/**
 * 매수점 계산
 * 매수점 = VR_MIN / (현재보유수량 + n)
 */
export function calculateBuyPrice(
  minBand: number,
  currentQuantity: number,
  additionalQuantity: number
): number {
  const totalQuantity = currentQuantity + additionalQuantity;
  if (totalQuantity <= 0) return 0;
  return Math.round((minBand / totalQuantity) * 100) / 100;
}

/**
 * 매도점 계산
 * 매도점 = VR_MAX / (현재보유수량 - n)
 */
export function calculateSellPrice(
  maxBand: number,
  currentQuantity: number,
  sellQuantity: number
): number {
  const remainingQuantity = currentQuantity - sellQuantity;
  if (remainingQuantity <= 0) return 0;
  return Math.round((maxBand / remainingQuantity) * 100) / 100;
}

/**
 * 매수 수량 계산 (밴드 안으로 복귀)
 */
export function calculateBuyQuantity(
  currentEvaluation: number,
  minBand: number,
  currentPrice: number,
  poolAvailable: number
): number {
  if (currentEvaluation >= minBand) return 0;
  if (currentPrice <= 0) return 0;

  // 밴드 복귀에 필요한 금액
  const deficitAmount = minBand - currentEvaluation;
  const idealQuantity = Math.ceil(deficitAmount / currentPrice);

  // Pool 한도 내에서 매수 가능한 수량
  const affordableQuantity = Math.floor(poolAvailable / currentPrice);

  return Math.max(0, Math.min(idealQuantity, affordableQuantity));
}

/**
 * 매도 수량 계산 (밴드 안으로 복귀)
 */
export function calculateSellQuantity(
  currentEvaluation: number,
  maxBand: number,
  currentPrice: number,
  totalQuantity: number
): number {
  if (currentEvaluation <= maxBand) return 0;
  if (currentPrice <= 0) return 0;

  // 밴드 복귀에 필요한 금액
  const excessAmount = currentEvaluation - maxBand;
  const idealQuantity = Math.ceil(excessAmount / currentPrice);

  // 보유 수량 한도 내에서 매도
  return Math.max(0, Math.min(idealQuantity, totalQuantity));
}

/**
 * 2주 경과 여부 및 남은 일수 계산
 */
export function checkVUpdateNeeded(lastVUpdateDate: Date, currentDate: Date = new Date()): {
  needsUpdate: boolean;
  daysUntilUpdate: number;
} {
  const twoWeeksMs = 14 * 24 * 60 * 60 * 1000;
  const elapsedMs = currentDate.getTime() - lastVUpdateDate.getTime();
  const remainingMs = twoWeeksMs - elapsedMs;

  return {
    needsUpdate: elapsedMs >= twoWeeksMs,
    daysUntilUpdate: Math.max(0, Math.ceil(remainingMs / (24 * 60 * 60 * 1000))),
  };
}

/**
 * 주차 계산 (사이클 시작일 기준)
 */
export function calculateWeekNumber(cycleStartDate: Date, currentDate: Date = new Date()): number {
  const msPerWeek = 7 * 24 * 60 * 60 * 1000;
  const elapsedMs = currentDate.getTime() - cycleStartDate.getTime();
  return Math.floor(elapsedMs / msPerWeek);
}

// ==================== 메인 계산 함수 ====================

/**
 * VR 매매 계산
 */
export function calculateVR(params: VRCalculateParams): VRCalculateResult {
  const {
    ticker,
    currentPrice,
    totalQuantity,
    targetValue,
    pool,
    gradient,
    bandPercent,
    investmentMode,
    periodicAmount,
    lastVUpdateDate,
    weekNumber,
  } = params;

  // 1. 현재 평가금 계산
  const currentEvaluation = Math.round(totalQuantity * currentPrice * 100) / 100;

  // 2. 밴드 계산
  const { minBand, maxBand } = calculateBands(targetValue, bandPercent);

  // 3. Pool 사용 한도 계산
  const poolUsageLimit = calculatePoolUsageLimit(investmentMode, weekNumber);
  const poolAvailable = Math.round(pool * poolUsageLimit * 100) / 100;

  // 4. V 업데이트 필요 여부 확인
  const vUpdateCheck = checkVUpdateNeeded(lastVUpdateDate);
  let newTargetValue: number | undefined;

  if (vUpdateCheck.needsUpdate) {
    newTargetValue = calculateNewTargetValue(
      targetValue,
      pool,
      gradient,
      periodicAmount,
      investmentMode
    );
  }

  // 5. 매매 판단 및 주문 생성
  let action: 'buy' | 'sell' | 'hold' = 'hold';
  let actionReason = '평가금이 밴드 내에 있습니다';
  const buyOrders: VROrder[] = [];
  const sellOrders: VROrder[] = [];

  if (currentEvaluation < minBand) {
    // 매수 필요
    action = 'buy';
    const deficit = minBand - currentEvaluation;
    actionReason = `평가금($${currentEvaluation.toFixed(2)})이 최소밴드($${minBand.toFixed(2)})보다 $${deficit.toFixed(2)} 부족`;

    const buyQuantity = calculateBuyQuantity(currentEvaluation, minBand, currentPrice, poolAvailable);

    if (buyQuantity > 0) {
      // 매수점 계산 (목표 수량 기준)
      const buyPrice = calculateBuyPrice(minBand, totalQuantity, buyQuantity);
      const amount = Math.round(buyPrice * buyQuantity * 100) / 100;

      buyOrders.push({
        orderType: 'LIMIT',
        price: buyPrice,
        quantity: buyQuantity,
        amount,
        label: `VR 매수 ${buyQuantity}주 @ $${buyPrice.toFixed(2)} [${ticker}]`,
      });
    } else if (poolAvailable < currentPrice) {
      actionReason += ` (Pool 부족으로 매수 불가: 사용가능 $${poolAvailable.toFixed(2)})`;
    }
  } else if (currentEvaluation > maxBand) {
    // 매도 필요
    action = 'sell';
    const excess = currentEvaluation - maxBand;
    actionReason = `평가금($${currentEvaluation.toFixed(2)})이 최대밴드($${maxBand.toFixed(2)})보다 $${excess.toFixed(2)} 초과`;

    const sellQuantity = calculateSellQuantity(currentEvaluation, maxBand, currentPrice, totalQuantity);

    if (sellQuantity > 0) {
      // 매도점 계산 (목표 수량 기준)
      const sellPrice = calculateSellPrice(maxBand, totalQuantity, sellQuantity);
      const amount = Math.round(sellPrice * sellQuantity * 100) / 100;

      sellOrders.push({
        orderType: 'LIMIT',
        price: sellPrice,
        quantity: sellQuantity,
        amount,
        label: `VR 매도 ${sellQuantity}주 @ $${sellPrice.toFixed(2)} [${ticker}]`,
      });
    }
  }

  // 6. 분석 정보 계산
  let deviationPercent = 0;
  if (currentEvaluation < minBand) {
    deviationPercent = -((minBand - currentEvaluation) / targetValue);
  } else if (currentEvaluation > maxBand) {
    deviationPercent = (currentEvaluation - maxBand) / targetValue;
  }

  const currentProfitRate = targetValue > 0
    ? (currentEvaluation - targetValue) / targetValue
    : 0;

  return {
    currentEvaluation,
    targetValue,
    minBand,
    maxBand,
    action,
    actionReason,
    buyOrders,
    sellOrders,
    analysis: {
      deviationPercent: Math.round(deviationPercent * 10000) / 10000,
      poolUsageLimit,
      poolAvailable,
      currentProfitRate: Math.round(currentProfitRate * 10000) / 10000,
    },
    nextVUpdate: {
      needsUpdate: vUpdateCheck.needsUpdate,
      newTargetValue,
      daysUntilUpdate: vUpdateCheck.daysUntilUpdate,
    },
  };
}

// ==================== 다중 가격대 주문 생성 ====================

/**
 * 다중 가격대 매수 주문 생성
 * 현재 수량 + 1, +2, +3, ... 각각의 매수점에 1주씩 주문
 *
 * 예시 (90주 보유, minBand = $4,207.50):
 * - 91주: $4,207.50 / 91 = $46.24
 * - 92주: $4,207.50 / 92 = $45.73
 * - 93주: $4,207.50 / 93 = $45.24
 * ...
 */
export function generateMultiPriceBuyOrders(
  ticker: string,
  minBand: number,
  currentQuantity: number,
  poolAvailable: number,
  maxOrders: number = 20  // 최대 주문 개수 제한
): VROrder[] {
  const orders: VROrder[] = [];
  let remainingPool = poolAvailable;
  let targetQuantity = currentQuantity + 1;

  while (orders.length < maxOrders && remainingPool > 0) {
    const buyPrice = calculateBuyPrice(minBand, currentQuantity, targetQuantity - currentQuantity);

    // 가격이 0 이하면 중단
    if (buyPrice <= 0) break;

    // Pool이 부족하면 중단
    if (remainingPool < buyPrice) break;

    orders.push({
      orderType: 'LIMIT',
      price: buyPrice,
      quantity: 1,
      amount: buyPrice,
      label: `VR 매수 ${targetQuantity}주째 @ $${buyPrice.toFixed(2)} [${ticker}]`,
    });

    remainingPool -= buyPrice;
    targetQuantity++;
  }

  return orders;
}

/**
 * 다중 가격대 매도 주문 생성
 * 현재 수량 - 1, -2, -3, ... 각각의 매도점에 1주씩 주문
 *
 * 예시 (90주 보유, maxBand = $5,692.50):
 * - 89주: $5,692.50 / 89 = $63.96
 * - 88주: $5,692.50 / 88 = $64.69
 * - 87주: $5,692.50 / 87 = $65.43
 * ...
 */
export function generateMultiPriceSellOrders(
  ticker: string,
  maxBand: number,
  currentQuantity: number,
  maxOrders: number = 20  // 최대 주문 개수 제한
): VROrder[] {
  const orders: VROrder[] = [];
  let sellCount = 1;

  while (orders.length < maxOrders && sellCount < currentQuantity) {
    const sellPrice = calculateSellPrice(maxBand, currentQuantity, sellCount);

    // 가격이 0 이하면 중단
    if (sellPrice <= 0) break;

    orders.push({
      orderType: 'LIMIT',
      price: sellPrice,
      quantity: 1,
      amount: sellPrice,
      label: `VR 매도 ${currentQuantity - sellCount}주로 @ $${sellPrice.toFixed(2)} [${ticker}]`,
    });

    sellCount++;
  }

  return orders;
}

/**
 * VR 다중 가격대 주문 계산 (매일 예약주문용)
 * 기존 calculateVR과 달리 여러 가격대에 분산 주문 생성
 */
export function calculateVRMultiPrice(params: VRCalculateParams): VRCalculateResult {
  const {
    ticker,
    currentPrice,
    totalQuantity,
    targetValue,
    pool,
    gradient,
    bandPercent,
    investmentMode,
    periodicAmount,
    lastVUpdateDate,
    weekNumber,
  } = params;

  // 1. 현재 평가금 계산
  const currentEvaluation = Math.round(totalQuantity * currentPrice * 100) / 100;

  // 2. 밴드 계산
  const { minBand, maxBand } = calculateBands(targetValue, bandPercent);

  // 3. Pool 사용 한도 계산
  const poolUsageLimit = calculatePoolUsageLimit(investmentMode, weekNumber);
  const poolAvailable = Math.round(pool * poolUsageLimit * 100) / 100;

  // 4. V 업데이트 필요 여부 확인
  const vUpdateCheck = checkVUpdateNeeded(lastVUpdateDate);
  let newTargetValue: number | undefined;

  if (vUpdateCheck.needsUpdate) {
    newTargetValue = calculateNewTargetValue(
      targetValue,
      pool,
      gradient,
      periodicAmount,
      investmentMode
    );
  }

  // 5. 다중 가격대 주문 생성 (항상 생성)
  const buyOrders = generateMultiPriceBuyOrders(ticker, minBand, totalQuantity, poolAvailable);
  const sellOrders = generateMultiPriceSellOrders(ticker, maxBand, totalQuantity);

  // 6. 매매 판단
  let action: 'buy' | 'sell' | 'hold' = 'hold';
  let actionReason = '';

  if (buyOrders.length > 0 && sellOrders.length > 0) {
    action = 'hold';
    actionReason = `매수 ${buyOrders.length}건, 매도 ${sellOrders.length}건 예약주문 준비`;
  } else if (buyOrders.length > 0) {
    action = 'buy';
    actionReason = `매수 ${buyOrders.length}건 예약주문 준비 (Pool 사용가능: $${poolAvailable.toFixed(2)})`;
  } else if (sellOrders.length > 0) {
    action = 'sell';
    actionReason = `매도 ${sellOrders.length}건 예약주문 준비`;
  } else {
    actionReason = '주문 생성 불가 (Pool 부족 또는 보유수량 없음)';
  }

  // 7. 분석 정보 계산
  let deviationPercent = 0;
  if (currentEvaluation < minBand) {
    deviationPercent = -((minBand - currentEvaluation) / targetValue);
  } else if (currentEvaluation > maxBand) {
    deviationPercent = (currentEvaluation - maxBand) / targetValue;
  }

  const currentProfitRate = targetValue > 0
    ? (currentEvaluation - targetValue) / targetValue
    : 0;

  return {
    currentEvaluation,
    targetValue,
    minBand,
    maxBand,
    action,
    actionReason,
    buyOrders,
    sellOrders,
    analysis: {
      deviationPercent: Math.round(deviationPercent * 10000) / 10000,
      poolUsageLimit,
      poolAvailable,
      currentProfitRate: Math.round(currentProfitRate * 10000) / 10000,
    },
    nextVUpdate: {
      needsUpdate: vUpdateCheck.needsUpdate,
      newTargetValue,
      daysUntilUpdate: vUpdateCheck.daysUntilUpdate,
    },
  };
}

/**
 * VR 초기 상태 생성
 */
export function createInitialVRState(
  ticker: string,
  initialInvestment: number,
  investmentMode: VRInvestmentMode,
  periodicAmount: number,
  gradient: number = 10,
  bandPercent: number = 0.15
): {
  ticker: string;
  status: 'active';
  targetValue: number;
  pool: number;
  gradient: number;
  bandPercent: number;
  cycleNumber: number;
  periodicAmount: number;
  investmentMode: VRInvestmentMode;
  minBand: number;
  maxBand: number;
  poolUsageLimit: number;
  initialInvestment: number;
  totalRealizedProfit: number;
  totalQuantity: number;
  avgPrice: number;
} {
  const { minBand, maxBand } = calculateBands(initialInvestment, bandPercent);
  const poolUsageLimit = calculatePoolUsageLimit(investmentMode, 0);

  return {
    ticker,
    status: 'active',
    targetValue: initialInvestment,
    pool: 0,
    gradient,
    bandPercent,
    cycleNumber: 1,
    periodicAmount,
    investmentMode,
    minBand,
    maxBand,
    poolUsageLimit,
    initialInvestment,
    totalRealizedProfit: 0,
    totalQuantity: 0,
    avgPrice: 0,
  };
}

// ==================== 잔량주문 관리 (사이클 기반) ====================

/**
 * 사이클 시작 시 모든 매수/매도 주문을 결정
 *
 * 핵심 개념:
 * - 사이클 시작 시점의 보유 수량과 밴드를 기준으로 주문 결정
 * - 이 주문들은 사이클 종료까지 변경되지 않음
 * - 매일 미체결 주문만 LIMIT 주문으로 제출
 *
 * 주문 생성 규칙:
 * - 매수: Pool의 60%까지 주문 생성 (개수 무제한)
 * - 매도: 10개 고정
 *
 * @param ticker 종목
 * @param currentQuantity 현재 보유 수량
 * @param minBand 최소밴드 (V × 0.85)
 * @param maxBand 최대밴드 (V × 1.15)
 * @param poolAvailable 사용 가능 Pool (이미 poolUsageLimit 적용된 값)
 * @param maxSellOrders 매도 주문 개수 (기본 10)
 */
export function initializeCycleOrders(
  ticker: string,
  currentQuantity: number,
  minBand: number,
  maxBand: number,
  poolAvailable: number,
  maxSellOrders: number = 10
): VRPendingOrders {
  const buyOrders: VRPendingOrder[] = [];
  const sellOrders: VRPendingOrder[] = [];

  // 매수 주문: Pool의 60%까지 사용
  const buyBudget = poolAvailable * 0.60;
  let remainingBudget = buyBudget;
  let buyIndex = 1;

  while (remainingBudget > 0) {
    const targetQty = currentQuantity + buyIndex;
    const buyPrice = calculateBuyPrice(minBand, currentQuantity, buyIndex);

    if (buyPrice <= 0) break;
    if (remainingBudget < buyPrice) break;

    buyOrders.push({
      orderIndex: buyIndex,
      price: buyPrice,
      quantity: 1,
      targetQuantity: targetQty,
      filled: false,
    });

    remainingBudget -= buyPrice;
    buyIndex++;
  }

  // 매도 주문: 10개 고정
  for (let i = 1; i <= maxSellOrders && i < currentQuantity; i++) {
    const targetQty = currentQuantity - i;
    const sellPrice = calculateSellPrice(maxBand, currentQuantity, i);

    if (sellPrice <= 0) break;
    if (targetQty <= 0) break;

    sellOrders.push({
      orderIndex: i,
      price: sellPrice,
      quantity: 1,
      targetQuantity: targetQty,
      filled: false,
    });
  }

  console.log(`[VR] 사이클 주문 초기화 완료 - 매수 ${buyOrders.length}건 (예산 $${buyBudget.toFixed(2)}), 매도 ${sellOrders.length}건`);

  return {
    buy: buyOrders,
    sell: sellOrders,
    initializedAt: new Date(),
    baseQuantity: currentQuantity,
  };
}

/**
 * 미체결 주문만 필터링
 * Firestore에서 읽어온 데이터도 처리 가능하도록 방어 코드 추가
 */
export function getUnfilledOrders(pendingOrders: VRPendingOrders | { buy?: VRPendingOrder[]; sell?: VRPendingOrder[] }): {
  buyOrders: VRPendingOrder[];
  sellOrders: VRPendingOrder[];
} {
  const buyArray = Array.isArray(pendingOrders.buy) ? pendingOrders.buy : [];
  const sellArray = Array.isArray(pendingOrders.sell) ? pendingOrders.sell : [];

  return {
    buyOrders: buyArray.filter(o => !o.filled),
    sellOrders: sellArray.filter(o => !o.filled),
  };
}

/**
 * 체결된 주문을 표시
 * 체결 데이터를 받아서 pendingOrders에서 해당 주문을 찾아 filled=true로 표시
 *
 * @param pendingOrders 현재 잔량주문
 * @param executedOrders 체결된 주문들 (KIS API에서 조회)
 * @returns 업데이트된 pendingOrders
 */
export function markFilledOrders(
  pendingOrders: VRPendingOrders,
  executedOrders: Array<{
    side: 'buy' | 'sell';
    price: number;
    quantity: number;
    executedAt: Date;
  }>
): VRPendingOrders {
  const updatedBuy = [...pendingOrders.buy];
  const updatedSell = [...pendingOrders.sell];

  for (const exec of executedOrders) {
    const orderList = exec.side === 'buy' ? updatedBuy : updatedSell;

    // 가격이 비슷한 미체결 주문 찾기 (0.5% 오차 허용)
    const priceThreshold = exec.price * 0.005;
    const matchedOrder = orderList.find(
      o => !o.filled && Math.abs(o.price - exec.price) <= priceThreshold
    );

    if (matchedOrder) {
      matchedOrder.filled = true;
      matchedOrder.filledAt = exec.executedAt;
      matchedOrder.filledPrice = exec.price;
      console.log(`[VR] 체결 반영 - ${exec.side} @ $${exec.price} → 주문 #${matchedOrder.orderIndex}`);
    }
  }

  return {
    ...pendingOrders,
    buy: updatedBuy,
    sell: updatedSell,
  };
}

/**
 * 잔량주문을 VROrder 형식으로 변환 (KIS API 주문 제출용)
 * Firestore에서 읽어온 데이터도 처리 가능
 */
export function pendingOrdersToVROrders(
  ticker: string,
  pendingOrders: VRPendingOrders | { buy?: VRPendingOrder[]; sell?: VRPendingOrder[] }
): { buyOrders: VROrder[]; sellOrders: VROrder[] } {
  if (!pendingOrders) {
    console.log('[VR] pendingOrdersToVROrders: pendingOrders is null/undefined');
    return { buyOrders: [], sellOrders: [] };
  }

  const { buyOrders: unfilledBuy, sellOrders: unfilledSell } = getUnfilledOrders(pendingOrders);

  const buyOrders: VROrder[] = unfilledBuy.map(o => ({
    orderType: 'LIMIT' as const,
    price: o.price,
    quantity: o.quantity,
    amount: o.price * o.quantity,
    label: `VR 매수 ${o.targetQuantity}주째 @ $${o.price.toFixed(2)} [${ticker}]`,
  }));

  const sellOrders: VROrder[] = unfilledSell.map(o => ({
    orderType: 'LIMIT' as const,
    price: o.price,
    quantity: o.quantity,
    amount: o.price * o.quantity,
    label: `VR 매도 ${o.targetQuantity}주로 @ $${o.price.toFixed(2)} [${ticker}]`,
  }));

  return { buyOrders, sellOrders };
}

/**
 * 현재가 기준 주문 조정 (당일 제출용)
 *
 * 가격이 급변하여 일부 주문이 현재가를 벗어난 경우,
 * 벗어난 주문들을 현재가에 수량 합산하여 하나의 주문으로 통합합니다.
 *
 * - 매도: price <= currentPrice인 주문 → MOO(장개시시장가) 1건으로 통합
 * - 매수: price >= currentPrice인 주문 → currentPrice 지정가 1건으로 통합
 * - Firestore의 pendingOrders는 수정하지 않음 (당일 제출용 조정만)
 */
export function adjustOrdersForCurrentPrice(
  buyOrders: VROrder[],
  sellOrders: VROrder[],
  currentPrice: number,
  ticker: string
): { buyOrders: VROrder[]; sellOrders: VROrder[] } {
  // 매도: price <= currentPrice인 주문을 MOO로 통합
  const outOfRangeSell = sellOrders.filter(o => o.price <= currentPrice);
  const inRangeSell = sellOrders.filter(o => o.price > currentPrice);

  let adjustedSellOrders: VROrder[];
  if (outOfRangeSell.length > 0) {
    const consolidatedQty = outOfRangeSell.reduce((sum, o) => sum + o.quantity, 0);

    console.log(
      `[VR] 매도 주문 조정: ${outOfRangeSell.length}건 통합 ` +
      `(${outOfRangeSell.map(o => `$${o.price.toFixed(2)}`).join(', ')} → MOO × ${consolidatedQty}주)`
    );

    const consolidatedOrder: VROrder = {
      orderType: 'MOO',
      price: 0,
      quantity: consolidatedQty,
      amount: 0,
      label: `VR 매도 ${consolidatedQty}주 통합 MOO [${ticker}]`,
    };

    adjustedSellOrders = [consolidatedOrder, ...inRangeSell];
  } else {
    adjustedSellOrders = sellOrders;
  }

  // 매수: price >= currentPrice인 주문을 currentPrice 지정가로 통합
  const outOfRangeBuy = buyOrders.filter(o => o.price >= currentPrice);
  const inRangeBuy = buyOrders.filter(o => o.price < currentPrice);

  let adjustedBuyOrders: VROrder[];
  if (outOfRangeBuy.length > 0) {
    const consolidatedQty = outOfRangeBuy.reduce((sum, o) => sum + o.quantity, 0);
    const bufferPrice = Math.round(currentPrice * 1.10 * 100) / 100;
    const consolidatedAmount = Math.round(bufferPrice * consolidatedQty * 100) / 100;

    console.log(
      `[VR] 매수 주문 조정: ${outOfRangeBuy.length}건 통합 ` +
      `(${outOfRangeBuy.map(o => `$${o.price.toFixed(2)}`).join(', ')} → LOO $${bufferPrice.toFixed(2)} × ${consolidatedQty}주)`
    );

    const consolidatedOrder: VROrder = {
      orderType: 'LOO',
      price: bufferPrice,         // 10% 버퍼 (체결 보장용, 실제 체결은 시작가)
      quantity: consolidatedQty,
      amount: consolidatedAmount,
      label: `VR 매수 ${consolidatedQty}주 통합 LOO @ $${bufferPrice.toFixed(2)} [${ticker}]`,
    };

    adjustedBuyOrders = [consolidatedOrder, ...inRangeBuy];
  } else {
    adjustedBuyOrders = buyOrders;
  }

  return { buyOrders: adjustedBuyOrders, sellOrders: adjustedSellOrders };
}

/**
 * Firestore Timestamp 또는 Date를 Date로 변환
 */
function toDate(value: Date | { toDate?: () => Date } | undefined): Date {
  if (!value) return new Date(0);
  if (value instanceof Date) return value;
  if (typeof value.toDate === 'function') return value.toDate();
  return new Date(0);
}

/**
 * 주문 초기화가 필요한지 확인
 * - pendingOrders가 없으면 필요
 * - 새 사이클이 시작됐으면 필요 (V 업데이트 후)
 */
export function needsOrderInitialization(
  pendingOrders: VRPendingOrders | { buy: VRPendingOrder[]; sell: VRPendingOrder[]; initializedAt: { toDate?: () => Date } | Date } | undefined,
  lastVUpdateDate: Date
): boolean {
  if (!pendingOrders) return true;
  if (!pendingOrders.buy || !pendingOrders.sell) return true;

  // Firestore Timestamp를 Date로 변환
  const initializedAt = toDate(pendingOrders.initializedAt);

  // V 업데이트 이후에 주문이 초기화되지 않았으면 재초기화 필요
  if (initializedAt < lastVUpdateDate) {
    console.log('[VR] V 업데이트 후 주문 재초기화 필요');
    return true;
  }

  return false;
}
