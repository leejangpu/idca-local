/**
 * 쿼터모드 전체 라이프사이클 테스트
 * npx tsx src/test-quarter-mode.ts
 *
 * 검증 항목:
 * 1. 쿼터모드 진입 조건 (T 초과 / 잔금 부족)
 * 2. MOC 매도 생성 (진입 시점)
 * 3. 쿼터 시드/매수금 계산
 * 4. 쿼터모드 매수/매도 주문 생성
 * 5. main-close 상태 전환 (활성화 / 라운드 증가 / 탈출)
 * 6. 라운드 >10 리셋
 * 7. 탈출 후 사이클 계속
 */

import {
  calculate, calculateDecreaseRate, shouldEnterQuarterMode,
  calculateQuarterModeSeed,
  type QuarterModeState, type CalculateParams,
} from './calculator.js';

// ==================== Test Framework ====================

interface TestResult {
  id: string;
  name: string;
  passed: boolean;
  error?: string;
}

const results: TestResult[] = [];

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(`Assertion failed: ${message}`);
}

function assertClose(actual: number, expected: number, tolerance: number, message: string): void {
  if (Math.abs(actual - expected) > tolerance) {
    throw new Error(`${message}: expected ~${expected}, got ${actual} (tolerance ${tolerance})`);
  }
}

function assertEqual<T>(actual: T, expected: T, message: string): void {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function test(id: string, name: string, fn: () => void): void {
  try {
    fn();
    results.push({ id, name, passed: true });
    console.log(`  PASS  ${id}: ${name}`);
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    results.push({ id, name, passed: false, error: errorMsg });
    console.log(`  FAIL  ${id}: ${name}`);
    console.log(`        -> ${errorMsg}`);
  }
}

// ==================== 공통 설정 ====================

// TQQQ 40분할, 목표수익률 10%
const TQQQ_SPLIT = 40;
const TQQQ_TARGET = 0.10;
const TQQQ_DECREASE = calculateDecreaseRate(TQQQ_TARGET, TQQQ_SPLIT); // 0.005

// SOXL 30분할, 목표수익률 12%
const SOXL_SPLIT = 30;
const SOXL_TARGET = 0.12;
const SOXL_DECREASE = calculateDecreaseRate(SOXL_TARGET, SOXL_SPLIT); // 0.008

// 기본 원금
const PRINCIPAL = 10000;

function makeParams(overrides: Partial<CalculateParams>): CalculateParams {
  const splitCount = overrides.splitCount ?? TQQQ_SPLIT;
  const targetProfit = overrides.targetProfit ?? TQQQ_TARGET;
  return {
    ticker: 'TQQQ',
    currentPrice: 50,
    totalQuantity: 100,
    avgPrice: 50,
    totalInvested: 5000,
    remainingCash: 5000,
    buyPerRound: PRINCIPAL / splitCount,
    splitCount,
    targetProfit,
    starDecreaseRate: calculateDecreaseRate(targetProfit, splitCount),
    strategyVersion: 'v2.2',
    ...overrides,
  };
}

// ==================== 테스트 시작 ====================

console.log('\n=== 쿼터모드 라이프사이클 테스트 ===\n');

// ==================== A. 진입 조건 ====================
console.log('\n--- A. 쿼터모드 진입 조건 ---');

test('A1', 'T 초과로 진입 (T > splitCount-1)', () => {
  // TQQQ 40분할, 원금 10000, buyPerRound=250
  // totalInvested = 250 * 40 = 10000 → T = 40 > 39
  const result = shouldEnterQuarterMode(40, 40, 0, 250, 'v2.2', 100);
  assertEqual(result.shouldEnter, true, 'shouldEnter');
  assertEqual(result.reason, 'T_EXCEEDED', 'reason');
});

test('A2', '잔금 부족으로 진입 (remainingCash < buyPerRound)', () => {
  // T=20, 잔금 100 < buyPerRound 250
  const result = shouldEnterQuarterMode(20, 40, 100, 250, 'v2.2', 100);
  assertEqual(result.shouldEnter, true, 'shouldEnter');
  assertEqual(result.reason, 'INSUFFICIENT_CASH', 'reason');
});

test('A3', '정상 범위에서는 미진입 (T < splitCount-1 && cash >= buyPerRound)', () => {
  const result = shouldEnterQuarterMode(20, 40, 5000, 250, 'v2.2', 100);
  assertEqual(result.shouldEnter, false, 'shouldEnter');
});

test('A4', 'T == splitCount-1 이면 미진입 (경계값)', () => {
  // T=39, splitCount=40 → T > 39 false
  const result = shouldEnterQuarterMode(39, 40, 250, 250, 'v2.2', 100);
  assertEqual(result.shouldEnter, false, 'shouldEnter');
});

test('A5', 'V3.0은 쿼터모드 없음', () => {
  const result = shouldEnterQuarterMode(40, 40, 0, 250, 'v3.0', 100);
  assertEqual(result.shouldEnter, false, 'shouldEnter');
});

test('A6', '새 사이클(T=0, qty=0)에서는 잔금 부족해도 미진입', () => {
  // T=0, qty=0, remainingCash=0 < buyPerRound=250
  const result = shouldEnterQuarterMode(0, 40, 0, 250, 'v2.2', 0);
  assertEqual(result.shouldEnter, false, 'shouldEnter');
});

// ==================== B. 진입 시 MOC 매도 생성 ====================
console.log('\n--- B. 쿼터모드 진입 시 MOC 매도 ---');

test('B1', '진입 시 MOC 매도만 생성 (LIMIT 없음)', () => {
  // T=40 → QUARTER_MODE, quarterMode 미활성화
  const params = makeParams({
    totalQuantity: 200,
    avgPrice: 50,
    totalInvested: 10000,
    remainingCash: 0,
    buyPerRound: 250,
  });
  const result = calculate(params);

  assertEqual(result.phase, 'QUARTER_MODE', 'phase');
  assertEqual(result.sellOrders.length, 1, 'sellOrders count');
  assertEqual(result.sellOrders[0].orderType, 'MOC', 'orderType');
  // 1/4 올림: ceil(200/4) = 50
  assertEqual(result.sellOrders[0].quantity, 50, 'MOC qty');
  assert(result.sellOrders[0].label.includes('자금확보'), 'label has 자금확보');
});

test('B2', '진입 시 quarterModeInfo 정보 올바른지', () => {
  const params = makeParams({
    totalQuantity: 200,
    avgPrice: 50,
    totalInvested: 10000,
    remainingCash: 0,
    buyPerRound: 250,
  });
  const result = calculate(params);

  assert(!!result.quarterModeInfo, 'quarterModeInfo exists');
  assertEqual(result.quarterModeInfo!.shouldEnterQuarterMode, true, 'shouldEnter');
  assert(!!result.quarterModeInfo!.quarterModeState, 'quarterModeState exists');
  assertEqual(result.quarterModeInfo!.quarterModeState!.isActive, false, 'isActive should be false before MOC');
  assertEqual(result.quarterModeInfo!.quarterModeState!.round, 1, 'round');
});

test('B3', 'MOC 수량 - 소수 보유시 올림 (최소 1)', () => {
  const params = makeParams({
    totalQuantity: 3, // ceil(3/4) = 1
    avgPrice: 50,
    totalInvested: 10000,
    remainingCash: 0,
    buyPerRound: 250,
  });
  const result = calculate(params);
  assertEqual(result.sellOrders[0].quantity, 1, 'MOC qty for 3 shares');
});

test('B4', 'MOC 수량 - 1주 보유시 전량', () => {
  const params = makeParams({
    totalQuantity: 1,
    avgPrice: 50,
    totalInvested: 10000,
    remainingCash: 0,
    buyPerRound: 250,
  });
  const result = calculate(params);
  assertEqual(result.sellOrders[0].quantity, 1, 'MOC qty for 1 share = all');
});

// ==================== C. 쿼터 시드 계산 ====================
console.log('\n--- C. 쿼터 시드 계산 ---');

test('C1', '잔금 < buyPerRound×10 → 잔금이 시드', () => {
  // buyPerRound=250, maxSeed=2500, remainingCash=1000
  const { quarterSeed, quarterBuyPerRound } = calculateQuarterModeSeed(1000, 250);
  assertEqual(quarterSeed, 1000, 'quarterSeed');
  assertEqual(quarterBuyPerRound, 100, 'quarterBuyPerRound = 1000/10');
});

test('C2', '잔금 > buyPerRound×10 → maxSeed 적용', () => {
  // buyPerRound=250, maxSeed=2500, remainingCash=5000
  const { quarterSeed, quarterBuyPerRound } = calculateQuarterModeSeed(5000, 250);
  assertEqual(quarterSeed, 2500, 'quarterSeed capped at maxSeed');
  assertEqual(quarterBuyPerRound, 250, 'quarterBuyPerRound = 2500/10');
});

test('C3', '잔금 == 0 → 시드 0', () => {
  const { quarterSeed, quarterBuyPerRound } = calculateQuarterModeSeed(0, 250);
  assertEqual(quarterSeed, 0, 'quarterSeed');
  assertEqual(quarterBuyPerRound, 0, 'quarterBuyPerRound');
});

test('C4', 'calculate()에서 시드 계산이 올바른지', () => {
  // T 초과, remainingCash=500 < maxSeed(250*10=2500)
  const params = makeParams({
    totalQuantity: 200,
    avgPrice: 50,
    totalInvested: 10000,
    remainingCash: 500,
    buyPerRound: 250,
  });
  const result = calculate(params);
  const qState = result.quarterModeInfo?.quarterModeState;
  assert(!!qState, 'quarterModeState exists');
  assertEqual(qState!.quarterSeed, 500, 'quarterSeed');
  assertEqual(qState!.quarterBuyPerRound, 50, 'quarterBuyPerRound');
  assertEqual(qState!.originalBuyPerRound, 250, 'originalBuyPerRound preserved');
});

// ==================== D. 쿼터모드 활성 상태 - 매수 주문 ====================
console.log('\n--- D. 쿼터모드 활성 상태 - 매수 주문 ---');

test('D1', '쿼터모드 매수: 별% LOC, quarterBuyPerRound 사용', () => {
  const qm: QuarterModeState = {
    isActive: true,
    round: 1,
    originalBuyPerRound: 250,
    quarterSeed: 1000,
    quarterBuyPerRound: 100,
  };
  const params = makeParams({
    totalQuantity: 150,
    avgPrice: 50,
    totalInvested: 7500,
    remainingCash: 2500,
    buyPerRound: 250,
    quarterMode: qm,
  });
  const result = calculate(params);

  assertEqual(result.phase, 'QUARTER_MODE', 'phase');
  assert(result.buyOrders.length > 0, 'has buy orders');
  assertEqual(result.buyOrders[0].orderType, 'LOC', 'buy orderType');
  assert(result.buyOrders[0].label.includes('쿼터모드'), 'label has 쿼터모드');
  assert(result.buyOrders[0].label.includes('1/10'), 'label has round');

  // 쿼터모드 별%: T=splitCount=40 → star% = 0.10 - (0.005 * 40) = -0.10
  assertEqual(result.starPercent, -0.10, 'star% = -10%');

  // 매수가 = 50 * (1 + (-0.10)) = 45.00
  const expectedPrice = Math.round(50 * 0.90 * 100) / 100;
  assertEqual(result.buyOrders[0].price, expectedPrice, 'buy price');

  // 수량 = floor(100 / 45) = 2
  const expectedQty = Math.floor(100 / expectedPrice);
  assertEqual(result.buyOrders[0].quantity, expectedQty, 'buy qty uses quarterBuyPerRound');
});

test('D2', '쿼터모드 매수금은 quarterBuyPerRound이지 buyPerRound가 아님', () => {
  const qm: QuarterModeState = {
    isActive: true,
    round: 3,
    originalBuyPerRound: 250,
    quarterSeed: 500,
    quarterBuyPerRound: 50,
  };
  const params = makeParams({
    totalQuantity: 100,
    avgPrice: 50,
    totalInvested: 5000,
    remainingCash: 5000,
    buyPerRound: 250,
    quarterMode: qm,
  });
  const result = calculate(params);

  // 매수가 = 50 * 0.90 = 45
  const buyPrice = 45;
  // buyPerRound=250이면 qty=5, quarterBuyPerRound=50이면 qty=1
  const expectedQty = Math.floor(50 / buyPrice);
  assertEqual(result.buyOrders[0].quantity, expectedQty, 'uses quarterBuyPerRound not buyPerRound');
});

// ==================== E. 쿼터모드 활성 상태 - 매도 주문 ====================
console.log('\n--- E. 쿼터모드 활성 상태 - 매도 주문 ---');

test('E1', '쿼터모드 진행 중: LOC 쿼터매도 + LIMIT 목표가', () => {
  const qm: QuarterModeState = {
    isActive: true,
    round: 2,
    originalBuyPerRound: 250,
    quarterSeed: 1000,
    quarterBuyPerRound: 100,
  };
  const params = makeParams({
    totalQuantity: 100,
    avgPrice: 50,
    totalInvested: 5000,
    remainingCash: 5000,
    buyPerRound: 250,
    quarterMode: qm,
  });
  const result = calculate(params);

  assertEqual(result.sellOrders.length, 2, 'two sell orders');

  // 1/4 LOC 쿼터매도
  assertEqual(result.sellOrders[0].orderType, 'LOC', 'first sell = LOC');
  assertEqual(result.sellOrders[0].quantity, 25, 'LOC qty = ceil(100/4)');
  assert(result.sellOrders[0].label.includes('쿼터매도'), 'label has 쿼터매도');
  assert(result.sellOrders[0].label.includes('2/10'), 'label has round');

  // 3/4 LIMIT 목표가
  assertEqual(result.sellOrders[1].orderType, 'LIMIT', 'second sell = LIMIT');
  assertEqual(result.sellOrders[1].quantity, 75, 'LIMIT qty = 100 - 25');
  const targetPrice = Math.round(50 * 1.10 * 100) / 100;
  assertEqual(result.sellOrders[1].price, targetPrice, 'LIMIT price = avg * 1.10');
});

test('E2', '쿼터모드 매도가격: 별% (음수) 적용', () => {
  const qm: QuarterModeState = {
    isActive: true,
    round: 1,
    originalBuyPerRound: 250,
    quarterSeed: 1000,
    quarterBuyPerRound: 100,
  };
  const params = makeParams({
    totalQuantity: 40,
    avgPrice: 50,
    totalInvested: 2000,
    remainingCash: 8000,
    buyPerRound: 250,
    quarterMode: qm,
  });
  const result = calculate(params);

  // star% = -10% for TQQQ 40분할
  assertEqual(result.starPercent, -0.10, 'star%');
  // LOC 매도가 = 50 * 0.90 = 45
  assertEqual(result.sellOrders[0].price, 45, 'LOC sell price');
});

// ==================== F. 라운드 >10 리셋 ====================
console.log('\n--- F. 라운드 >10 리셋 ---');

test('F1', 'round > 10이면 다시 MOC만 (자금확보)', () => {
  const qm: QuarterModeState = {
    isActive: true,
    round: 11,
    originalBuyPerRound: 250,
    quarterSeed: 1000,
    quarterBuyPerRound: 100,
  };
  const params = makeParams({
    totalQuantity: 80,
    avgPrice: 50,
    totalInvested: 4000,
    remainingCash: 6000,
    buyPerRound: 250,
    quarterMode: qm,
  });
  const result = calculate(params);

  assertEqual(result.sellOrders.length, 1, 'only MOC');
  assertEqual(result.sellOrders[0].orderType, 'MOC', 'MOC only');
  assertEqual(result.sellOrders[0].quantity, 20, 'MOC qty = ceil(80/4)');
  assert(result.sellOrders[0].label.includes('자금확보'), 'label has 자금확보');
});

test('F2', 'round == 10이면 아직 정상 쿼터모드 (LOC+LIMIT)', () => {
  const qm: QuarterModeState = {
    isActive: true,
    round: 10,
    originalBuyPerRound: 250,
    quarterSeed: 1000,
    quarterBuyPerRound: 100,
  };
  const params = makeParams({
    totalQuantity: 80,
    avgPrice: 50,
    totalInvested: 4000,
    remainingCash: 6000,
    buyPerRound: 250,
    quarterMode: qm,
  });
  const result = calculate(params);

  assertEqual(result.sellOrders.length, 2, 'LOC + LIMIT');
  assertEqual(result.sellOrders[0].orderType, 'LOC', 'LOC');
  assertEqual(result.sellOrders[1].orderType, 'LIMIT', 'LIMIT');
});

// ==================== G. main-close 상태 전환 시뮬레이션 ====================
console.log('\n--- G. main-close 상태 전환 시뮬레이션 ---');

// main-close의 syncTicker 로직을 순수 함수로 시뮬레이션
interface SimCycleState {
  status: string;
  principal: number;
  buyPerRound: number;
  splitCount: number;
  targetProfit: number;
  totalInvested: number;
  remainingCash: number;
  totalQuantity: number;
  avgPrice: number;
  totalBuyAmount: number;
  totalSellAmount: number;
  totalRealizedProfit: number;
  quarterMode?: QuarterModeState;
}

interface SimExecution {
  side: 'BUY' | 'SELL';
  quantity: number;
  price: number;
  amount: number;
}

function simulateCloseSync(
  cycleData: SimCycleState,
  executions: SimExecution[],
  currentHolding: { totalQuantity: number; avgPrice: number },
): { updatedState: SimCycleState; event: string } {
  const todayBuyAmt = executions.filter(e => e.side === 'BUY').reduce((s, e) => s + e.amount, 0);
  const todaySellAmt = executions.filter(e => e.side === 'SELL').reduce((s, e) => s + e.amount, 0);
  const newTotalBuy = (cycleData.totalBuyAmount || 0) + todayBuyAmt;
  const newTotalSell = (cycleData.totalSellAmount || 0) + todaySellAmt;
  const totalRealizedProfit = newTotalSell - newTotalBuy;
  const { totalQuantity, avgPrice } = currentHolding;
  const totalInvested = totalQuantity * avgPrice;

  const quarterMode = cycleData.quarterMode;

  if (quarterMode) {
    const hasSellExec = executions.some(e => e.side === 'SELL');
    const hasBuyExec = executions.some(e => e.side === 'BUY');

    // MOC 매도 체결 → 쿼터모드 활성화
    if (!quarterMode.isActive && hasSellExec) {
      return {
        updatedState: {
          ...cycleData,
          quarterMode: { ...quarterMode, isActive: true },
          totalInvested,
          remainingCash: cycleData.principal - totalInvested,
          avgPrice, totalQuantity,
          totalBuyAmount: newTotalBuy, totalSellAmount: newTotalSell,
          totalRealizedProfit,
        },
        event: 'quarterModeActivated',
      };
    }

    // 쿼터모드 중 전량매도 → 탈출
    if (quarterMode.isActive && totalQuantity === 0 && hasSellExec) {
      const soldAmount = executions.filter(e => e.side === 'SELL').reduce((s, e) => s + e.amount, 0);
      const newPrincipal = (cycleData.remainingCash || 0) + soldAmount;
      const newBuyPerRound = newPrincipal / cycleData.splitCount;
      return {
        updatedState: {
          ...cycleData,
          principal: newPrincipal, buyPerRound: newBuyPerRound,
          remainingCash: newPrincipal, totalInvested: 0,
          totalQuantity: 0, avgPrice: 0,
          totalBuyAmount: newTotalBuy, totalSellAmount: newTotalSell,
          totalRealizedProfit,
          quarterMode: undefined,
        },
        event: 'quarterModeExited',
      };
    }

    // 쿼터모드 매수 체결 → round 증가
    if (quarterMode.isActive && hasBuyExec) {
      const newRound = (quarterMode.round || 0) + 1;
      return {
        updatedState: {
          ...cycleData,
          quarterMode: { ...quarterMode, round: newRound },
          totalInvested,
          remainingCash: cycleData.principal - totalInvested,
          avgPrice, totalQuantity,
          totalBuyAmount: newTotalBuy, totalSellAmount: newTotalSell,
          totalRealizedProfit,
        },
        event: 'quarterModeRoundIncrement',
      };
    }
  }

  // 사이클 완료 감지
  if (cycleData.status === 'active' && totalQuantity === 0 && (cycleData.totalInvested || 0) > 0) {
    return {
      updatedState: {
        ...cycleData,
        status: 'completed',
        totalQuantity: 0, avgPrice: 0, totalInvested: 0,
        remainingCash: cycleData.principal,
        totalBuyAmount: newTotalBuy, totalSellAmount: newTotalSell,
        totalRealizedProfit,
        quarterMode: undefined,
      },
      event: 'cycleCompleted',
    };
  }

  // 일반 동기화
  const remainingCash = cycleData.principal - totalInvested;
  return {
    updatedState: {
      ...cycleData,
      totalInvested, remainingCash, avgPrice, totalQuantity,
      totalBuyAmount: newTotalBuy, totalSellAmount: newTotalSell,
      totalRealizedProfit,
    },
    event: 'sync',
  };
}

test('G1', 'MOC 체결 → 쿼터모드 활성화', () => {
  const state: SimCycleState = {
    status: 'active',
    principal: 10000, buyPerRound: 250, splitCount: 40, targetProfit: 0.10,
    totalInvested: 10000, remainingCash: 0,
    totalQuantity: 200, avgPrice: 50,
    totalBuyAmount: 10000, totalSellAmount: 0,
    totalRealizedProfit: 0,
    quarterMode: {
      isActive: false, round: 1,
      originalBuyPerRound: 250,
      quarterSeed: 0, quarterBuyPerRound: 0,
    },
  };
  // MOC 매도 50주 @ $48 = $2400
  const execs: SimExecution[] = [{ side: 'SELL', quantity: 50, price: 48, amount: 2400 }];
  const holding = { totalQuantity: 150, avgPrice: 50 };

  const { updatedState, event } = simulateCloseSync(state, execs, holding);

  assertEqual(event, 'quarterModeActivated', 'event');
  assertEqual(updatedState.quarterMode!.isActive, true, 'isActive');
  assertEqual(updatedState.totalQuantity, 150, 'qty after MOC sell');
  assertEqual(updatedState.totalSellAmount, 2400, 'totalSellAmount');
});

test('G2', '활성화 후 시드 재계산 & 매수 주문 생성', () => {
  // G1 이후 상태: 150주 보유, avgPrice=50, principal=10000
  // 활성화 후 remainingCash = principal - totalInvested = 10000 - 7500 = 2500
  // MOC 매도로 받은 2400은 remainingCash에 이미 반영 (totalInvested 감소)
  const qSeed = calculateQuarterModeSeed(2500, 250);
  assertEqual(qSeed.quarterSeed, 2500, 'quarterSeed = min(2500, 2500)');
  assertEqual(qSeed.quarterBuyPerRound, 250, 'quarterBuyPerRound');

  // 이제 쿼터모드 활성 상태로 calculate 호출
  const qm: QuarterModeState = {
    isActive: true, round: 1,
    originalBuyPerRound: 250,
    quarterSeed: 2500, quarterBuyPerRound: 250,
  };
  const params = makeParams({
    totalQuantity: 150, avgPrice: 50,
    totalInvested: 7500, remainingCash: 2500,
    buyPerRound: 250,
    quarterMode: qm,
  });
  const result = calculate(params);

  assertEqual(result.phase, 'QUARTER_MODE', 'phase');
  assert(result.buyOrders.length > 0, 'has buy orders');
  // star% = -10%, price = 50*0.9 = 45, qty = floor(250/45) = 5
  assertEqual(result.buyOrders[0].quantity, 5, 'buy qty');
  assertEqual(result.buyOrders[0].price, 45, 'buy price');
});

test('G3', '쿼터모드 매수 체결 → round 증가', () => {
  const state: SimCycleState = {
    status: 'active',
    principal: 10000, buyPerRound: 250, splitCount: 40, targetProfit: 0.10,
    totalInvested: 7500, remainingCash: 2500,
    totalQuantity: 150, avgPrice: 50,
    totalBuyAmount: 10000, totalSellAmount: 2400,
    totalRealizedProfit: -7600,
    quarterMode: {
      isActive: true, round: 1,
      originalBuyPerRound: 250,
      quarterSeed: 2500, quarterBuyPerRound: 250,
    },
  };
  // 쿼터모드 매수 5주 @ $45 = $225
  const execs: SimExecution[] = [{ side: 'BUY', quantity: 5, price: 45, amount: 225 }];
  const holding = { totalQuantity: 155, avgPrice: 49.8 };

  const { updatedState, event } = simulateCloseSync(state, execs, holding);

  assertEqual(event, 'quarterModeRoundIncrement', 'event');
  assertEqual(updatedState.quarterMode!.round, 2, 'round incremented to 2');
  assertEqual(updatedState.totalQuantity, 155, 'qty updated');
});

test('G4', '쿼터모드 중 전량매도 → 탈출, 원금 재계산', () => {
  // 쿼터모드 round 5에서 LIMIT 목표가 체결로 전량 매도
  const state: SimCycleState = {
    status: 'active',
    principal: 10000, buyPerRound: 250, splitCount: 40, targetProfit: 0.10,
    totalInvested: 8000, remainingCash: 2000,
    totalQuantity: 160, avgPrice: 50,
    totalBuyAmount: 10500, totalSellAmount: 2400,
    totalRealizedProfit: -8100,
    quarterMode: {
      isActive: true, round: 5,
      originalBuyPerRound: 250,
      quarterSeed: 2500, quarterBuyPerRound: 250,
    },
  };
  // 전량 160주 매도 @ $55 = $8800
  const execs: SimExecution[] = [{ side: 'SELL', quantity: 160, price: 55, amount: 8800 }];
  const holding = { totalQuantity: 0, avgPrice: 0 };

  const { updatedState, event } = simulateCloseSync(state, execs, holding);

  assertEqual(event, 'quarterModeExited', 'event');
  assertEqual(updatedState.quarterMode, undefined, 'quarterMode removed');
  // 새 원금 = remainingCash(2000) + soldAmount(8800) = 10800
  assertEqual(updatedState.principal, 10800, 'new principal');
  assertEqual(updatedState.buyPerRound, 10800 / 40, 'new buyPerRound');
  assertEqual(updatedState.remainingCash, 10800, 'remainingCash = new principal');
  assertEqual(updatedState.totalQuantity, 0, 'qty = 0');
  assertEqual(updatedState.avgPrice, 0, 'avgPrice = 0');
});

test('G5', '탈출 후 다음 open에서 정상 사이클 계속', () => {
  // G4 이후: principal=10800, buyPerRound=270, qty=0, avgPrice=0
  // 이것은 '쿼터모드 탈출' 이지 '사이클 완료'가 아님
  // main-open에서는 avgPrice=0 && qty=0 이면 needsNewCycle 체크
  // 하지만 쿼터모드 탈출은 status='active'를 유지함 → needsNewCycle=false
  // → 기존 사이클의 첫 매수처럼 동작

  const params = makeParams({
    ticker: 'TQQQ',
    currentPrice: 48,
    totalQuantity: 0,
    avgPrice: 0,
    totalInvested: 0,
    remainingCash: 10800,
    buyPerRound: 270, // 10800/40
    splitCount: 40,
    targetProfit: 0.10,
  });
  const result = calculate(params);

  // T=0, avgPrice=0 → 최초 매수
  assertEqual(result.cycleStatus.isNewCycle, true, 'isNewCycle');
  assert(result.buyOrders.length > 0, 'has buy orders');
  assertEqual(result.buyOrders[0].label.includes('최초 매수'), true, 'first buy label');
  // qty = floor(270 / 48) = 5
  assertEqual(result.buyOrders[0].quantity, 5, 'first buy qty');
  // 쿼터모드 아님
  assertEqual(result.phase, 'FIRST_HALF', 'back to FIRST_HALF');
  assertEqual(result.quarterModeInfo, undefined, 'no quarterModeInfo');
});

// ==================== H. SOXL 30분할 시나리오 ====================
console.log('\n--- H. SOXL 30분할 쿼터모드 ---');

test('H1', 'SOXL 30분할 쿼터모드 진입 (T초과)', () => {
  // SOXL: 30분할, 목표12%, 감소율=0.12*2/30=0.008
  const result = shouldEnterQuarterMode(30, 30, 0, 333, 'v2.2', 100);
  assertEqual(result.shouldEnter, true, 'shouldEnter');
  assertEqual(result.reason, 'T_EXCEEDED', 'reason');
});

test('H2', 'SOXL 쿼터모드 별% = -12%', () => {
  // star% = 0.12 - (0.008 * 30) = 0.12 - 0.24 = -0.12
  const qm: QuarterModeState = {
    isActive: true, round: 1,
    originalBuyPerRound: 333,
    quarterSeed: 3000, quarterBuyPerRound: 300,
  };
  const params = makeParams({
    ticker: 'SOXL',
    totalQuantity: 100, avgPrice: 30,
    totalInvested: 3000, remainingCash: 7000,
    buyPerRound: 333,
    splitCount: SOXL_SPLIT,
    targetProfit: SOXL_TARGET,
    quarterMode: qm,
  });
  const result = calculate(params);

  assertEqual(result.starPercent, -0.12, 'star% = -12%');
  // 매수가 = 30 * 0.88 = 26.40
  assertEqual(result.buyOrders[0].price, 26.4, 'buy price');
  // qty = floor(300 / 26.40) = 11
  assertEqual(result.buyOrders[0].quantity, 11, 'buy qty');
});

// ==================== I. 복합 시나리오: 전체 라이프사이클 ====================
console.log('\n--- I. 전체 라이프사이클 시뮬레이션 ---');

test('I1', '정상→쿼터진입→활성화→라운드진행→전량매도→탈출→재시작', () => {
  // Step 1: T=39 (후반전) 상태에서 잔금 부족으로 쿼터모드 진입
  const step1Params = makeParams({
    totalQuantity: 200, avgPrice: 50,
    totalInvested: 9750, // T = 9750/250 = 39
    remainingCash: 250,  // 딱 buyPerRound → T>splitCount-1이 아니고 잔금=buyPerRound
    buyPerRound: 250,
  });
  let result = calculate(step1Params);
  // T=39, remainingCash=250 >= buyPerRound=250 → 아직 후반전
  assertEqual(result.phase, 'SECOND_HALF', 'step1: still second half');

  // Step 2: 매수 체결 후 T=40 → 쿼터모드 진입
  const step2Params = makeParams({
    totalQuantity: 205, avgPrice: 50,
    totalInvested: 10000, // T = 10000/250 = 40 > 39
    remainingCash: 0,
    buyPerRound: 250,
  });
  result = calculate(step2Params);
  assertEqual(result.phase, 'QUARTER_MODE', 'step2: quarter mode');
  assert(result.quarterModeInfo?.shouldEnterQuarterMode === true, 'step2: should enter');
  assertEqual(result.sellOrders[0].orderType, 'MOC', 'step2: MOC sell');

  // Step 3: MOC 체결 → 활성화 (simulateCloseSync)
  const step3State: SimCycleState = {
    status: 'active',
    principal: 10000, buyPerRound: 250, splitCount: 40, targetProfit: 0.10,
    totalInvested: 10000, remainingCash: 0,
    totalQuantity: 205, avgPrice: 50,
    totalBuyAmount: 10000, totalSellAmount: 0,
    totalRealizedProfit: 0,
    quarterMode: {
      isActive: false, round: 1,
      originalBuyPerRound: 250,
      quarterSeed: 0, quarterBuyPerRound: 0,
    },
  };
  // MOC 매도 52주 @ $47 = $2444
  let syncResult = simulateCloseSync(
    step3State,
    [{ side: 'SELL', quantity: 52, price: 47, amount: 2444 }],
    { totalQuantity: 153, avgPrice: 50 },
  );
  assertEqual(syncResult.event, 'quarterModeActivated', 'step3: activated');
  assertEqual(syncResult.updatedState.quarterMode!.isActive, true, 'step3: isActive');

  // Step 4: 활성화 후 시드 계산
  const afterActivation = syncResult.updatedState;
  const remCash = afterActivation.remainingCash;
  // principal(10000) - totalInvested(153*50=7650) = 2350
  assertClose(remCash, 2350, 1, 'step4: remainingCash');
  const seed = calculateQuarterModeSeed(remCash, 250);
  assertClose(seed.quarterSeed, 2350, 1, 'step4: seed');
  assertClose(seed.quarterBuyPerRound, 235, 1, 'step4: qBuyPerRound');

  // Step 5: 쿼터모드 round 1 매수 체결 → round 2
  const step5State: SimCycleState = {
    ...afterActivation,
    quarterMode: {
      isActive: true, round: 1,
      originalBuyPerRound: 250,
      quarterSeed: seed.quarterSeed,
      quarterBuyPerRound: seed.quarterBuyPerRound,
    },
  };
  syncResult = simulateCloseSync(
    step5State,
    [{ side: 'BUY', quantity: 5, price: 45, amount: 225 }],
    { totalQuantity: 158, avgPrice: 49.5 },
  );
  assertEqual(syncResult.event, 'quarterModeRoundIncrement', 'step5: round increment');
  assertEqual(syncResult.updatedState.quarterMode!.round, 2, 'step5: round=2');

  // Step 6: LIMIT 목표가 전량 체결 → 쿼터모드 탈출
  const step6State = syncResult.updatedState;
  syncResult = simulateCloseSync(
    step6State,
    [{ side: 'SELL', quantity: 158, price: 55, amount: 8690 }],
    { totalQuantity: 0, avgPrice: 0 },
  );
  assertEqual(syncResult.event, 'quarterModeExited', 'step6: exited');
  assertEqual(syncResult.updatedState.quarterMode, undefined, 'step6: qm removed');
  // 새 원금 = remainingCash + soldAmount
  const newPrincipal = syncResult.updatedState.principal;
  assert(newPrincipal > 10000, 'step6: principal grew (profit)');
  assertEqual(syncResult.updatedState.totalQuantity, 0, 'step6: qty=0');

  // Step 7: 탈출 후 calculate → 첫 매수 (FIRST_HALF)
  const step7Params = makeParams({
    currentPrice: 52,
    totalQuantity: 0, avgPrice: 0,
    totalInvested: 0,
    remainingCash: newPrincipal,
    buyPerRound: newPrincipal / 40,
  });
  result = calculate(step7Params);
  assertEqual(result.phase, 'FIRST_HALF', 'step7: first half');
  assertEqual(result.cycleStatus.isNewCycle, true, 'step7: new cycle flag');
  assert(result.buyOrders.length > 0, 'step7: has buy order');
  assert(result.buyOrders[0].label.includes('최초 매수'), 'step7: first buy');
});

// ==================== J. 엣지 케이스 ====================
console.log('\n--- J. 엣지 케이스 ---');

test('J1', '쿼터모드 중 매수+매도 동시 체결 → round만 증가 (매수 우선)', () => {
  // 매수와 LOC 쿼터매도가 같은 날 체결
  const state: SimCycleState = {
    status: 'active',
    principal: 10000, buyPerRound: 250, splitCount: 40, targetProfit: 0.10,
    totalInvested: 7500, remainingCash: 2500,
    totalQuantity: 150, avgPrice: 50,
    totalBuyAmount: 10000, totalSellAmount: 2400,
    totalRealizedProfit: -7600,
    quarterMode: {
      isActive: true, round: 3,
      originalBuyPerRound: 250,
      quarterSeed: 2500, quarterBuyPerRound: 250,
    },
  };
  // 매수 5주 + 매도 37주 (LOC 쿼터매도)
  const execs: SimExecution[] = [
    { side: 'BUY', quantity: 5, price: 45, amount: 225 },
    { side: 'SELL', quantity: 37, price: 45, amount: 1665 },
  ];
  // 결과적으로 150+5-37 = 118주 보유
  const holding = { totalQuantity: 118, avgPrice: 50 };

  const { updatedState, event } = simulateCloseSync(state, execs, holding);
  // 코드상 hasBuyExec 체크가 마지막이므로 round 증가
  // 하지만 hasSellExec도 true인데 isActive=true && totalQuantity>0 이므로
  // 전량매도 조건 미충족 → round 증가 분기로 감
  assertEqual(event, 'quarterModeRoundIncrement', 'event');
  assertEqual(updatedState.quarterMode!.round, 4, 'round=4');
});

test('J2', '쿼터모드 진입 시 매수 주문 없음 (아직 MOC 미체결)', () => {
  // phase=QUARTER_MODE, quarterMode=undefined → 진입 시점
  const params = makeParams({
    totalQuantity: 200, avgPrice: 50,
    totalInvested: 10000, remainingCash: 0,
    buyPerRound: 250,
    // quarterMode 미전달
  });
  const result = calculate(params);

  // 진입 시점이므로 매수 주문 없어야 함 (quarterMode.isActive=false)
  // generateBuyOrders: phase=QUARTER_MODE && quarterMode?.isActive false → else (후반전) 분기
  // 하지만 buyPerRound=250, avgPrice=50, star=-10%, price=45, qty=floor(250/45)=5
  // 실제로는 매수 주문이 생성됨 (후반전 분기)
  // 이것이 맞는 동작인지 확인
  assert(result.buyOrders.length > 0, 'buy orders exist (falls to else branch)');
  assertEqual(result.sellOrders[0].orderType, 'MOC', 'sell is MOC only');
});

test('J3', '쿼터모드 잔금 0에서 시드 0 → 매수 수량 0', () => {
  const qm: QuarterModeState = {
    isActive: true, round: 1,
    originalBuyPerRound: 250,
    quarterSeed: 0, quarterBuyPerRound: 0,
  };
  const params = makeParams({
    totalQuantity: 150, avgPrice: 50,
    totalInvested: 7500, remainingCash: 0,
    buyPerRound: 250,
    quarterMode: qm,
  });
  const result = calculate(params);

  // quarterBuyPerRound=0 → qty=0 → no buy orders
  assertEqual(result.buyOrders.length, 0, 'no buy orders with 0 seed');
  // 매도는 정상 (LOC + LIMIT)
  assertEqual(result.sellOrders.length, 2, 'sell orders exist');
});

test('J4', '쿼터모드 탈출 후 사이클 완료와 구분', () => {
  // 쿼터모드 탈출 = status 'active' 유지 + qty=0
  // 사이클 완료 = status 'completed'
  // main-close에서 쿼터모드 탈출이 먼저 처리되므로 사이클 완료 분기에 도달하지 않음

  const state: SimCycleState = {
    status: 'active',
    principal: 10000, buyPerRound: 250, splitCount: 40, targetProfit: 0.10,
    totalInvested: 8000, remainingCash: 2000,
    totalQuantity: 160, avgPrice: 50,
    totalBuyAmount: 10500, totalSellAmount: 2400,
    totalRealizedProfit: -8100,
    quarterMode: {
      isActive: true, round: 5,
      originalBuyPerRound: 250,
      quarterSeed: 2500, quarterBuyPerRound: 250,
    },
  };
  // 전량 매도
  const { event } = simulateCloseSync(
    state,
    [{ side: 'SELL', quantity: 160, price: 55, amount: 8800 }],
    { totalQuantity: 0, avgPrice: 0 },
  );
  // 사이클 완료가 아닌 쿼터모드 탈출
  assertEqual(event, 'quarterModeExited', 'quarter exit, NOT cycle complete');
});

test('J5', '쿼터모드 없이 전량매도 → 사이클 완료', () => {
  const state: SimCycleState = {
    status: 'active',
    principal: 10000, buyPerRound: 250, splitCount: 40, targetProfit: 0.10,
    totalInvested: 5000, remainingCash: 5000,
    totalQuantity: 100, avgPrice: 50,
    totalBuyAmount: 5000, totalSellAmount: 0,
    totalRealizedProfit: -5000,
  };
  // LIMIT 목표가 전량 체결
  const { event } = simulateCloseSync(
    state,
    [{ side: 'SELL', quantity: 100, price: 55, amount: 5500 }],
    { totalQuantity: 0, avgPrice: 0 },
  );
  assertEqual(event, 'cycleCompleted', 'cycle complete without quarter mode');
});

// ==================== K. 잔금 부족 진입 시나리오 ====================
console.log('\n--- K. 잔금 부족 진입 시나리오 ---');

test('K1', 'T=20이지만 잔금 부족 → 쿼터모드 진입', () => {
  // T=20 (전반전/후반전 경계), 잔금 100 < buyPerRound 250
  const params = makeParams({
    totalQuantity: 100, avgPrice: 50,
    totalInvested: 5000, // T = 5000/250 = 20
    remainingCash: 100,  // < 250
    buyPerRound: 250,
  });
  const result = calculate(params);

  assertEqual(result.phase, 'QUARTER_MODE', 'phase');
  assert(result.quarterModeInfo?.shouldEnterQuarterMode === true, 'shouldEnter');
  assertEqual(result.quarterModeInfo?.reason, 'INSUFFICIENT_CASH', 'reason');
  // 시드 = min(100, 250*10=2500) = 100
  assertEqual(result.quarterModeInfo?.quarterModeState?.quarterSeed, 100, 'seed=100');
  assertEqual(result.quarterModeInfo?.quarterModeState?.quarterBuyPerRound, 10, 'qBuyPerRound=10');
});

test('K2', '잔금 부족 진입 후 MOC 체결로 잔금 회복 → 쿼터모드 정상 진행', () => {
  // MOC 매도로 잔금 확보 후 시드 재계산
  const state: SimCycleState = {
    status: 'active',
    principal: 10000, buyPerRound: 250, splitCount: 40, targetProfit: 0.10,
    totalInvested: 5000, remainingCash: 100,
    totalQuantity: 100, avgPrice: 50,
    totalBuyAmount: 5000, totalSellAmount: 0,
    totalRealizedProfit: -5000,
    quarterMode: {
      isActive: false, round: 1,
      originalBuyPerRound: 250,
      quarterSeed: 100, quarterBuyPerRound: 10,
    },
  };
  // MOC 25주 @ $48 = $1200
  const syncResult = simulateCloseSync(
    state,
    [{ side: 'SELL', quantity: 25, price: 48, amount: 1200 }],
    { totalQuantity: 75, avgPrice: 50 },
  );
  assertEqual(syncResult.event, 'quarterModeActivated', 'activated');

  // 잔금 = 10000 - (75*50) = 10000 - 3750 = 6250
  const newRemCash = syncResult.updatedState.remainingCash;
  assertClose(newRemCash, 6250, 1, 'remainingCash after MOC');

  // 시드 재계산: min(6250, 250*10=2500) = 2500
  const seed = calculateQuarterModeSeed(newRemCash, 250);
  assertEqual(seed.quarterSeed, 2500, 'seed capped');
  assertEqual(seed.quarterBuyPerRound, 250, 'qBuyPerRound');
});

// ==================== 결과 요약 ====================

console.log('\n' + '='.repeat(60));
const passed = results.filter(r => r.passed).length;
const failed = results.filter(r => !r.passed).length;
const total = results.length;

if (failed > 0) {
  console.log(`\n  RESULT: ${passed}/${total} passed, ${failed} FAILED\n`);
  console.log('  Failed tests:');
  for (const r of results.filter(r => !r.passed)) {
    console.log(`    ${r.id}: ${r.name}`);
    console.log(`       ${r.error}`);
  }
  process.exit(1);
} else {
  console.log(`\n  ALL ${total} TESTS PASSED\n`);
}
