/**
 * 투자원금 계산 로직 (V2: 다음 사이클 원금 기반 + 추가입금 균등분배)
 *
 * 핵심 원칙:
 * 1. 각 종목의 nextPrincipal은 cycleData에서 계산됨 (사이클 원금 + 누적 매도 수익)
 *    - config.tickerConfigs.principal은 순수 사용자 설정값 (수동 모드에서만 존재)
 * 2. 추가 입금 감지 시 모든 종목의 nextPrincipal에 균등 배분 (런타임에서만, config 미저장)
 * 3. 새 사이클 원금 = 사용자 설정값(수동) 또는 계산된 nextPrincipal(자동)
 */

export interface CycleStatus {
  ticker: string;
  needsNewCycle: boolean;
  nextPrincipal: number;  // 다음 사이클 원금 (cycleData.principal + cycleData.totalRealizedProfit)
  holdingValue: number;
  cycleData: {
    remainingCash?: number;
    principal?: number;
  } | null;
}

export interface PrincipalCalculationInput {
  accountCash: number;
  tickers: string[];
  cycleStatusMap: Map<string, CycleStatus>;
}

export interface PrincipalCalculationResult {
  totalAllocatedFunds: number;
  additionalDeposit: number;
  depositPerTicker: number;
  updatedAllocatedFunds: Map<string, number>;  // 업데이트된 nextPrincipal
  newCyclePrincipalMap: Map<string, number>;
}

/**
 * 기존 배분 자금 합계 계산
 *
 * 공식: 추가입금 = accountCash - Σ(기존 배분 자금)
 *
 * 기존 배분 자금:
 * - 진행 중인 사이클: remainingCash (Firestore 저장값)
 * - 종료된 사이클: nextPrincipal (다음 사이클 원금)
 *
 * 주의: accountCash는 순수 현금(KIS API)이므로 holdingValue(주식)는 포함하지 않음
 */
export function calculateTotalAllocatedFunds(
  tickers: string[],
  cycleStatusMap: Map<string, CycleStatus>
): number {
  return tickers.reduce((sum: number, ticker: string) => {
    const status = cycleStatusMap.get(ticker);
    const cycleData = status?.cycleData;

    if (status?.needsNewCycle) {
      // 종료된 사이클: nextPrincipal (다음 사이클 원금, 현금 형태)
      return sum + (status?.nextPrincipal || 0);
    } else {
      // 진행 중인 사이클: remainingCash만 (holdingValue는 주식이므로 제외)
      return sum + (cycleData?.remainingCash || 0);
    }
  }, 0);
}

/**
 * 추가입금 계산
 */
export function calculateAdditionalDeposit(
  accountCash: number,
  totalAllocatedFunds: number
): number {
  // 음수면 0으로 처리 (손실 등으로 계좌잔액이 할당자금보다 적을 수 있음)
  return Math.max(0, accountCash - totalAllocatedFunds);
}

/**
 * 종목별 추가입금 배분액 계산
 */
export function calculateDepositPerTicker(
  additionalDeposit: number,
  tickerCount: number
): number {
  return Math.floor(additionalDeposit / tickerCount);
}

/**
 * 모든 종목의 nextPrincipal 업데이트 계산
 * (추가입금이 있으면 모든 종목에 균등 배분)
 *
 * nextPrincipal = 해당 종목의 총 자금 (현금 + 주식)
 * - 진행 중: remainingCash + holdingValue
 * - 종료: nextPrincipal (기존 값)
 */
export function calculateUpdatedAllocatedFunds(
  tickers: string[],
  cycleStatusMap: Map<string, CycleStatus>,
  depositPerTicker: number
): Map<string, number> {
  const updatedMap = new Map<string, number>();

  for (const ticker of tickers) {
    const status = cycleStatusMap.get(ticker);
    const cycleData = status?.cycleData;

    // 현재 총 자금 계산
    let currentTotalFunds: number;
    if (status?.needsNewCycle) {
      // 종료된 사이클: nextPrincipal
      currentTotalFunds = status?.nextPrincipal || 0;
    } else {
      // 진행 중인 사이클: remainingCash + holdingValue (총 자금)
      currentTotalFunds = (cycleData?.remainingCash || 0) + (status?.holdingValue || 0);
    }

    // 추가입금 배분
    const newNextPrincipal = currentTotalFunds + depositPerTicker;
    updatedMap.set(ticker, newNextPrincipal);
  }

  return updatedMap;
}

/**
 * 새 사이클 원금 계산
 */
export function calculateNewCyclePrincipals(
  tickers: string[],
  cycleStatusMap: Map<string, CycleStatus>,
  updatedNextPrincipal: Map<string, number>
): Map<string, number> {
  const principalMap = new Map<string, number>();

  for (const ticker of tickers) {
    const status = cycleStatusMap.get(ticker);
    if (status?.needsNewCycle) {
      // 새 사이클 원금 = 업데이트된 nextPrincipal
      const principal = updatedNextPrincipal.get(ticker) || 0;
      principalMap.set(ticker, principal);
    }
  }

  return principalMap;
}

/**
 * 전체 원금 계산 수행 (메인 함수)
 */
export function calculatePrincipal(input: PrincipalCalculationInput): PrincipalCalculationResult {
  const { accountCash, tickers, cycleStatusMap } = input;

  // 1. 전체 할당자금 계산
  const totalAllocatedFunds = calculateTotalAllocatedFunds(tickers, cycleStatusMap);

  // 2. 추가입금 계산
  const additionalDeposit = calculateAdditionalDeposit(accountCash, totalAllocatedFunds);

  // 3. 종목당 추가입금 배분액
  const depositPerTicker = calculateDepositPerTicker(additionalDeposit, tickers.length);

  // 4. 모든 종목의 nextPrincipal 업데이트 (추가입금 포함)
  const updatedAllocatedFunds = calculateUpdatedAllocatedFunds(
    tickers,
    cycleStatusMap,
    depositPerTicker
  );

  // 5. 새 사이클 원금 계산
  const newCyclePrincipalMap = calculateNewCyclePrincipals(
    tickers,
    cycleStatusMap,
    updatedAllocatedFunds
  );

  return {
    totalAllocatedFunds,
    additionalDeposit,
    depositPerTicker,
    updatedAllocatedFunds,
    newCyclePrincipalMap,
  };
}
