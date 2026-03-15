/**
 * 무한매수법 계산 모듈
 * V2.2 및 V3.0 지원
 *
 * 통일된 별% 공식:
 * - 감소율 = 목표수익률 × 2 / 분할수
 * - 별% = 목표수익률 - (T × 감소율)
 *
 * 별% LOC 주문 = 평단 × (1 + 별%)
 * - 별%가 양수면: 평단 위
 * - 별%가 음수면: 평단 아래
 */

export type Phase = 'FIRST_HALF' | 'SECOND_HALF' | 'QUARTER_MODE';
export type StrategyVersion = 'v2.2' | 'v3.0';

export interface CalculateParams {
  ticker: string;
  currentPrice: number;
  totalQuantity: number;
  avgPrice: number;
  totalInvested: number;
  remainingCash: number;
  buyPerRound: number;
  splitCount: number;
  targetProfit: number;       // 예: 0.10 (10%)
  starDecreaseRate: number;   // 감소율 (자동 계산 또는 직접 입력)
  strategyVersion?: StrategyVersion; // 기본값: v3.0
  // 쿼터모드 관련
  quarterMode?: QuarterModeState;
}

/**
 * 쿼터모드 상태
 */
export interface QuarterModeState {
  isActive: boolean;          // 쿼터모드 활성화 여부
  round: number;              // 현재 쿼터모드 회차 (1~10)
  originalBuyPerRound: number; // 쿼터모드 진입 전 1회 매수금
  quarterSeed: number;        // 쿼터모드 시드 (최대 = originalBuyPerRound × 10)
  quarterBuyPerRound: number; // 쿼터모드 1회 매수금 (quarterSeed / 10)
}

export interface BuyOrder {
  orderType: 'LOC' | 'LIMIT';
  price: number;
  quantity: number;
  amount: number;
  label: string;
}

export interface SellOrder {
  orderType: 'LOC' | 'LIMIT' | 'MOC';
  price: number;
  quantity: number;
  amount: number;
  label: string;
}

export interface CalculateResult {
  tValue: number;
  phase: Phase;
  phaseLabel: string;
  starPercent: number;        // 양수 또는 음수 (예: 0.075 = 7.5%, -0.025 = -2.5%)
  targetPercent: number;
  buyOrders: BuyOrder[];
  sellOrders: SellOrder[];
  analysis: {
    currentProfitRate: number;
    targetSellPrice: number;
    distanceToTarget: number;
  };
  cycleStatus: {
    isNewCycle: boolean;    // 새 사이클 시작 (포지션 없음, 평단가 없음)
    shouldReset: boolean;   // 리셋 필요 (보유 수량 0)
  };
  strategyVersion: StrategyVersion;
  // 쿼터모드 관련
  quarterModeInfo?: {
    shouldEnterQuarterMode: boolean;  // 쿼터모드 진입 필요
    reason?: 'T_EXCEEDED' | 'INSUFFICIENT_CASH';  // 진입 사유
    quarterModeState?: QuarterModeState;  // 쿼터모드 상태
  };
}

// ==================== 공통 계산 로직 ====================

/**
 * 감소율 계산
 * 감소율 = 목표수익률 × 2 / 분할수
 */
export function calculateDecreaseRate(targetProfit: number, splitCount: number): number {
  if (splitCount <= 0) return 0;
  return (targetProfit * 2) / splitCount;
}

/**
 * T값 계산 (버전 무관하게 소수점 둘째자리에서 올림)
 */
function calculateTValue(
  totalInvested: number,
  buyPerRound: number,
  splitCount: number,
  _strategyVersion: StrategyVersion
): number {
  if (buyPerRound <= 0) return 0;
  const rawT = totalInvested / buyPerRound;

  // 소수점 둘째자리에서 올림 (버전 무관)
  const tValue = Math.ceil(rawT * 100) / 100;

  return Math.min(tValue, splitCount);
}

/**
 * 별% 계산 (통일된 공식)
 * 별% = 목표수익률 - (T × 감소율)
 * 양수 또는 음수 그대로 반환
 */
function calculateStarPercent(tValue: number, targetProfit: number, decreaseRate: number): number {
  const starPercent = targetProfit - (decreaseRate * tValue);
  return Math.round(starPercent * 10000) / 10000; // 소수점 4자리
}

/**
 * Phase 판별
 * @param quarterModeActive 쿼터모드가 이미 활성화되어 있는지 여부 (V2.2 전용)
 * @param strategyVersion 전략 버전
 * @param totalQuantity 현재 보유 수량 (새 사이클 판단용)
 */
function getPhase(
  tValue: number,
  splitCount: number,
  remainingCash: number,
  buyPerRound: number,
  quarterModeActive: boolean = false,
  strategyVersion: StrategyVersion = 'v3.0',
  totalQuantity: number = 0
): Phase {
  // V2.2 쿼터모드: 이미 활성화되어 있으면 유지
  if (strategyVersion === 'v2.2' && quarterModeActive) {
    return 'QUARTER_MODE';
  }

  // V2.2 쿼터모드 진입 조건: T > splitCount - 1 또는 잔금 < 1회 매수금
  // 단, 새 사이클(T=0, 보유수량=0)일 때는 쿼터모드 진입하지 않음
  const isNewCycle = tValue === 0 && totalQuantity === 0;
  if (strategyVersion === 'v2.2' && !isNewCycle && (tValue > splitCount - 1 || remainingCash < buyPerRound)) {
    return 'QUARTER_MODE';
  }

  // V3.0은 쿼터모드 없음 - 잔금 부족해도 후반전 유지
  const halfSplit = splitCount / 2;
  if (tValue < halfSplit) {
    return 'FIRST_HALF';
  }
  return 'SECOND_HALF';
}

/**
 * 쿼터모드 진입 조건 체크 (V2.2 전용)
 * 조건: T > splitCount - 1 또는 잔금 < 1회 매수금
 * V3.0은 쿼터모드가 없으므로 항상 false 반환
 * 새 사이클(T=0, totalQuantity=0)일 때는 쿼터모드 진입하지 않음
 */
export function shouldEnterQuarterMode(
  tValue: number,
  splitCount: number,
  remainingCash: number,
  buyPerRound: number,
  strategyVersion: StrategyVersion = 'v2.2',
  totalQuantity: number = 0
): { shouldEnter: boolean; reason?: 'T_EXCEEDED' | 'INSUFFICIENT_CASH' } {
  // V3.0은 쿼터모드 없음
  if (strategyVersion === 'v3.0') {
    return { shouldEnter: false };
  }

  // 새 사이클(T=0, 보유수량=0)일 때는 쿼터모드 진입하지 않음
  const isNewCycle = tValue === 0 && totalQuantity === 0;
  if (isNewCycle) {
    return { shouldEnter: false };
  }

  // V2.2 쿼터모드 조건
  if (tValue > splitCount - 1) {
    return { shouldEnter: true, reason: 'T_EXCEEDED' };
  }
  if (remainingCash < buyPerRound) {
    return { shouldEnter: true, reason: 'INSUFFICIENT_CASH' };
  }
  return { shouldEnter: false };
}

/**
 * 쿼터모드 시드 계산
 * 시드 = 예수금 전체 (매도금 + 기존 잔금 + 수익금)
 * 단, 최대 시드 = 기존 1회 매수금 × 10
 */
export function calculateQuarterModeSeed(
  remainingCash: number,
  originalBuyPerRound: number
): { quarterSeed: number; quarterBuyPerRound: number } {
  const maxSeed = originalBuyPerRound * 10;
  const quarterSeed = Math.min(remainingCash, maxSeed);
  const quarterBuyPerRound = quarterSeed / 10;
  return { quarterSeed, quarterBuyPerRound };
}

/**
 * 쿼터모드용 별% 계산
 * T를 분할수로 고정하여 계산 (V2.2 TQQQ 기준: -10%)
 */
function calculateQuarterModeStarPercent(targetProfit: number, decreaseRate: number, splitCount: number): number {
  // T = splitCount로 고정
  const starPercent = targetProfit - (decreaseRate * splitCount);
  return Math.round(starPercent * 10000) / 10000;
}

function getPhaseLabel(phase: Phase): string {
  switch (phase) {
    case 'FIRST_HALF': return '전반전';
    case 'SECOND_HALF': return '후반전';
    case 'QUARTER_MODE': return '쿼터모드';
  }
}

/**
 * 가격 계산 (평단 대비 percent)
 * 가격 = 평단 × (1 + percent)
 */
function calculatePrice(avgPrice: number, percent: number): number {
  return Math.round(avgPrice * (1 + percent) * 100) / 100;
}

/**
 * 주문 수량 계산 (소수점 버림)
 */
function calculateQuantity(amount: number, price: number): number {
  if (price <= 0) return 0;
  return Math.floor(amount / price);
}

/**
 * 별% 라벨 생성 (부호 포함)
 */
function formatStarPercentLabel(starPercent: number): string {
  const sign = starPercent >= 0 ? '+' : '';
  return `${sign}${(starPercent * 100).toFixed(1)}%`;
}

/**
 * 매수 주문 생성
 * 전반전: 0% LOC + 별% LOC (각 절반)
 * 후반전: 별% LOC (전액)
 * 쿼터모드: 별% LOC (쿼터모드 1회 매수금)
 */
function generateBuyOrders(
  phase: Phase,
  starPercent: number,  // 양수 또는 음수
  avgPrice: number,
  buyPerRound: number,
  currentPrice: number,
  strategyVersion: StrategyVersion,
  quarterMode?: QuarterModeState
): BuyOrder[] {
  const orders: BuyOrder[] = [];
  const versionLabel = strategyVersion === 'v2.2' ? 'V2.2' : 'V3.0';

  // 최초 매수인 경우 (평단가 = 0)
  if (avgPrice <= 0) {
    if (currentPrice > 0) {
      const quantity = calculateQuantity(buyPerRound, currentPrice);
      if (quantity > 0) {
        orders.push({
          orderType: 'LOC',
          price: currentPrice,
          quantity,
          amount: Math.round(currentPrice * quantity * 100) / 100,
          label: `최초 매수 (현재가 LOC) [${versionLabel}]`,
        });
      }
    }
    return orders;
  }

  if (phase === 'FIRST_HALF') {
    // 전반전: 2개 LOC 주문 (0%, 별%) - 각 절반
    const halfAmount = buyPerRound / 2;

    // 0% LOC 매수 (평단가)
    const zeroPrice = calculatePrice(avgPrice, 0);
    const zeroQty = calculateQuantity(halfAmount, zeroPrice);
    if (zeroQty > 0) {
      orders.push({
        orderType: 'LOC',
        price: zeroPrice,
        quantity: zeroQty,
        amount: Math.round(zeroPrice * zeroQty * 100) / 100,
        label: `전반전 0% LOC [${versionLabel}]`,
      });
    }

    // 별% LOC 매수
    const starPrice = calculatePrice(avgPrice, starPercent);
    const starQty = calculateQuantity(halfAmount, starPrice);
    if (starQty > 0) {
      orders.push({
        orderType: 'LOC',
        price: starPrice,
        quantity: starQty,
        amount: Math.round(starPrice * starQty * 100) / 100,
        label: `전반전 ${formatStarPercentLabel(starPercent)} LOC [${versionLabel}]`,
      });
    }
  } else if (phase === 'QUARTER_MODE' && quarterMode?.isActive) {
    // 쿼터모드: 별% LOC (쿼터모드 1회 매수금 사용)
    const starPrice = calculatePrice(avgPrice, starPercent);
    const qty = calculateQuantity(quarterMode.quarterBuyPerRound, starPrice);
    if (qty > 0) {
      orders.push({
        orderType: 'LOC',
        price: starPrice,
        quantity: qty,
        amount: Math.round(starPrice * qty * 100) / 100,
        label: `쿼터모드 ${quarterMode.round}/10 ${formatStarPercentLabel(starPercent)} LOC [${versionLabel}]`,
      });
    }
  } else {
    // 후반전: 1개 LOC 주문 (별%)
    const starPrice = calculatePrice(avgPrice, starPercent);
    const qty = calculateQuantity(buyPerRound, starPrice);
    if (qty > 0) {
      orders.push({
        orderType: 'LOC',
        price: starPrice,
        quantity: qty,
        amount: Math.round(starPrice * qty * 100) / 100,
        label: `후반전 ${formatStarPercentLabel(starPercent)} LOC [${versionLabel}]`,
      });
    }
  }

  return orders;
}

/**
 * 매도 주문 생성
 *
 * V2.2:
 * - 전반전/후반전: 1/4 별% LOC + 3/4 목표가 LIMIT
 * - 쿼터모드 진입시: 1/4 MOC (강제 매도, 자금 확보)
 * - 쿼터모드 진행중: 1/4 별% LOC + 3/4 목표가 LIMIT
 *
 * V3.0:
 * - 전반전/후반전: 1/4 별% LOC + 3/4 목표가 LIMIT
 * - 잔금 부족 시 (19 < T <= 20): 1/4 MOC + 3/4 목표가 LIMIT (동시에)
 */
function generateSellOrders(
  phase: Phase,
  starPercent: number,  // 양수 또는 음수
  targetPercent: number,
  avgPrice: number,
  totalQuantity: number,
  remainingCash: number,
  buyPerRound: number,
  strategyVersion: StrategyVersion,
  quarterMode?: QuarterModeState
): SellOrder[] {
  if (totalQuantity <= 0 || avgPrice <= 0) {
    return [];
  }

  const orders: SellOrder[] = [];
  const versionLabel = strategyVersion === 'v2.2' ? 'V2.2' : 'V3.0';

  // 1/4 올림 (최소 1개)
  let quarterQty = Math.max(1, Math.ceil(totalQuantity / 4));
  if (quarterQty >= totalQuantity) {
    quarterQty = totalQuantity;
  }

  // V3.0: 잔금 부족 시 MOC + LIMIT 동시 (쿼터모드 없음)
  if (strategyVersion === 'v3.0' && remainingCash < buyPerRound) {
    // 1/4 MOC 손절
    orders.push({
      orderType: 'MOC',
      price: 0,
      quantity: quarterQty,
      amount: 0,
      label: `손절 1/4 MOC [${versionLabel}]`,
    });
    // 3/4 목표가 LIMIT
    const targetQty = totalQuantity - quarterQty;
    if (targetQty > 0) {
      const targetPrice = calculatePrice(avgPrice, targetPercent);
      orders.push({
        orderType: 'LIMIT',
        price: targetPrice,
        quantity: targetQty,
        amount: Math.round(targetPrice * targetQty * 100) / 100,
        label: `목표 +${(targetPercent * 100).toFixed(0)}% LIMIT [${versionLabel}]`,
      });
    }
    return orders;
  }

  // V2.2 쿼터모드 진입 시점 (아직 활성화되지 않음) 또는 쿼터모드 10회 완료 후: MOC만 (자금확보용)
  const isQuarterModeEntry = phase === 'QUARTER_MODE' && !quarterMode?.isActive;
  const isQuarterModeReset = phase === 'QUARTER_MODE' && quarterMode?.isActive && quarterMode.round > 10;
  const needMOCOnly = isQuarterModeEntry || isQuarterModeReset;

  if (needMOCOnly) {
    // V2.2 쿼터모드: MOC 매도만 (자금 확보)
    orders.push({
      orderType: 'MOC',
      price: 0,
      quantity: quarterQty,
      amount: 0,
      label: `쿼터매도 MOC (자금확보) [${versionLabel}]`,
    });
    // 쿼터모드 진입 시에는 LIMIT 매도 없음 (MOC만)
    return orders;
  } else if (phase === 'QUARTER_MODE' && quarterMode?.isActive) {
    // V2.2 쿼터모드 진행 중: 별% LOC 쿼터매도
    const starPrice = calculatePrice(avgPrice, starPercent);
    orders.push({
      orderType: 'LOC',
      price: starPrice,
      quantity: quarterQty,
      amount: Math.round(starPrice * quarterQty * 100) / 100,
      label: `쿼터매도 ${quarterMode.round}/10 ${formatStarPercentLabel(starPercent)} LOC [${versionLabel}]`,
    });
  } else {
    // 전반전/후반전: 별% LOC 쿼터매도
    const starPrice = calculatePrice(avgPrice, starPercent);
    orders.push({
      orderType: 'LOC',
      price: starPrice,
      quantity: quarterQty,
      amount: Math.round(starPrice * quarterQty * 100) / 100,
      label: `쿼터매도 ${formatStarPercentLabel(starPercent)} LOC [${versionLabel}]`,
    });
  }

  // 나머지 3/4 목표가 LIMIT 매도
  const targetQty = totalQuantity - quarterQty;
  if (targetQty > 0) {
    const targetPrice = calculatePrice(avgPrice, targetPercent);
    orders.push({
      orderType: 'LIMIT',
      price: targetPrice,
      quantity: targetQty,
      amount: Math.round(targetPrice * targetQty * 100) / 100,
      label: `목표 +${(targetPercent * 100).toFixed(0)}% LIMIT [${versionLabel}]`,
    });
  }

  return orders;
}

/**
 * 메인 계산 함수
 */
export function calculate(params: CalculateParams): CalculateResult {
  const {
    currentPrice,
    totalQuantity,
    avgPrice,
    totalInvested,
    remainingCash,
    buyPerRound,
    splitCount,
    targetProfit,
    starDecreaseRate,
    strategyVersion = 'v3.0',
    quarterMode,
  } = params;

  // T값 계산
  const tValue = calculateTValue(totalInvested, buyPerRound, splitCount, strategyVersion);

  // 감소율: 입력값이 있으면 사용, 없으면 공식으로 계산
  const decreaseRate = starDecreaseRate > 0
    ? starDecreaseRate
    : calculateDecreaseRate(targetProfit, splitCount);

  // 쿼터모드 진입 체크 (V2.2 전용)
  const quarterModeCheck = shouldEnterQuarterMode(tValue, splitCount, remainingCash, buyPerRound, strategyVersion, totalQuantity);
  const isQuarterModeActive = quarterMode?.isActive || false;

  // Phase 판단
  const phase = getPhase(tValue, splitCount, remainingCash, buyPerRound, isQuarterModeActive, strategyVersion, totalQuantity);
  const phaseLabel = getPhaseLabel(phase);

  // 별% 계산
  let starPercent: number;
  if (phase === 'QUARTER_MODE') {
    // 쿼터모드: T를 splitCount로 고정하여 별% 계산
    starPercent = calculateQuarterModeStarPercent(targetProfit, decreaseRate, splitCount);
  } else {
    // 일반 모드: 통일된 공식
    starPercent = calculateStarPercent(tValue, targetProfit, decreaseRate);
  }

  // 쿼터모드 상태 결정 (V2.2 전용)
  let quarterModeState: QuarterModeState | undefined;
  if (strategyVersion === 'v2.2' && phase === 'QUARTER_MODE') {
    if (quarterMode?.isActive) {
      // 이미 쿼터모드 진행 중
      quarterModeState = quarterMode;
    } else {
      // 새로 쿼터모드 진입 (아직 MOC 매도 전)
      const { quarterSeed, quarterBuyPerRound: qBuyPerRound } = calculateQuarterModeSeed(remainingCash, buyPerRound);
      quarterModeState = {
        isActive: false, // MOC 매도 체결 후 true로 변경
        round: 1,
        originalBuyPerRound: buyPerRound,
        quarterSeed,
        quarterBuyPerRound: qBuyPerRound,
      };
    }
  }

  // 매수 주문에서 사용할 1회 매수금 결정
  const effectiveBuyPerRound = (phase === 'QUARTER_MODE' && quarterMode?.isActive)
    ? quarterMode.quarterBuyPerRound
    : buyPerRound;

  // 매수 주문 생성
  const buyOrders = generateBuyOrders(
    phase,
    starPercent,
    avgPrice,
    effectiveBuyPerRound,
    currentPrice,
    strategyVersion,
    quarterMode
  );

  // 매도 주문 생성
  const sellOrders = generateSellOrders(
    phase,
    starPercent,
    targetProfit,
    avgPrice,
    totalQuantity,
    remainingCash,
    buyPerRound,
    strategyVersion,
    quarterMode
  );

  // 분석 데이터
  const targetSellPrice = avgPrice > 0 ? calculatePrice(avgPrice, targetProfit) : 0;
  const currentProfitRate = avgPrice > 0 ? (currentPrice - avgPrice) / avgPrice : 0;
  const distanceToTarget = currentPrice > 0 ? (targetSellPrice - currentPrice) / currentPrice : 0;

  // 쿼터모드 정보 (V2.2 전용)
  const quarterModeInfo = (strategyVersion === 'v2.2' && (quarterModeCheck.shouldEnter || isQuarterModeActive))
    ? {
        shouldEnterQuarterMode: quarterModeCheck.shouldEnter && !isQuarterModeActive,
        reason: quarterModeCheck.reason,
        quarterModeState,
      }
    : undefined;

  return {
    tValue,
    phase,
    phaseLabel,
    starPercent,
    targetPercent: targetProfit,
    buyOrders,
    sellOrders,
    analysis: {
      currentProfitRate,
      targetSellPrice,
      distanceToTarget,
    },
    cycleStatus: {
      isNewCycle: totalQuantity <= 0 && avgPrice <= 0,
      shouldReset: totalQuantity <= 0,
    },
    strategyVersion,
    quarterModeInfo,
  };
}

/**
 * 버전별 기본 설정 반환
 * 감소율은 공식으로 자동 계산: 목표수익률 × 2 / 분할수
 */
export function getDefaultSettingsForVersion(version: StrategyVersion, ticker: string): {
  splitCount: number;
  targetProfit: number;
  starDecreaseRate: number;
} {
  let splitCount: number;
  let targetProfit: number;

  if (version === 'v2.2') {
    splitCount = 40;
    targetProfit = ticker.toUpperCase() === 'SOXL' ? 0.12 : 0.10;
  } else {
    // V3.0
    splitCount = 20;
    targetProfit = ticker.toUpperCase() === 'SOXL' ? 0.20 : 0.15;
  }

  // 감소율 자동 계산
  const starDecreaseRate = calculateDecreaseRate(targetProfit, splitCount);

  return {
    splitCount,
    targetProfit,
    starDecreaseRate,
  };
}
