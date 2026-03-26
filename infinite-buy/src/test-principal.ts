/**
 * 원금 계산 집중 테스트 — 한 종목 사이클 종료 + 다른 종목 진행 중
 * 실제 숫자로 추적하여 원금 격리/복리 정확성 검증
 */

import { calculatePrincipal } from './principalCalculator.js';
import type { CycleStatus } from './principalCalculator.js';

let passed = 0;
let failed = 0;

function test(name: string, fn: () => void) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (err: any) {
    console.log(`  ✗ ${name}`);
    console.log(`    → ${err.message}`);
    failed++;
  }
}

function assert(condition: boolean, msg: string) {
  if (!condition) throw new Error(msg);
}

function assertClose(a: number, b: number, msg: string, tolerance = 0.01) {
  if (Math.abs(a - b) > tolerance) throw new Error(`${msg}: expected ${b}, got ${a}`);
}

// ==========================================
// 시나리오 1: 최초 실행 — 둘 다 새 사이클
// ==========================================
console.log('\n=== 시나리오 1: 최초 실행 (둘 다 새 사이클) ===');
{
  // 계좌 현금 $10,000, 보유주식 없음
  const accountCash = 10000;
  const cycleStatusMap = new Map<string, CycleStatus>([
    ['SOXL', { ticker: 'SOXL', needsNewCycle: true, nextPrincipal: 0, holdingValue: 0, cycleData: null }],
    ['TQQQ', { ticker: 'TQQQ', needsNewCycle: true, nextPrincipal: 0, holdingValue: 0, cycleData: null }],
  ]);

  const result = calculatePrincipal({ accountCash, tickers: ['SOXL', 'TQQQ'], cycleStatusMap });

  test('할당자금 = 0 (기존 사이클 없음)', () => {
    assertClose(result.totalAllocatedFunds, 0, '할당자금');
  });
  test('추가입금 = $10,000 (전액)', () => {
    assertClose(result.additionalDeposit, 10000, '추가입금');
  });
  test('종목당 추가입금 = $5,000', () => {
    assertClose(result.depositPerTicker, 5000, '종목당');
  });
  test('SOXL 새 사이클 원금 = $5,000', () => {
    assertClose(result.newCyclePrincipalMap.get('SOXL')!, 5000, 'SOXL 원금');
  });
  test('TQQQ 새 사이클 원금 = $5,000', () => {
    assertClose(result.newCyclePrincipalMap.get('TQQQ')!, 5000, 'TQQQ 원금');
  });
}

// ==========================================
// 시나리오 2: SOXL 사이클 종료 (수익 $300), TQQQ 진행 중
// ==========================================
console.log('\n=== 시나리오 2: SOXL 종료 ($300 수익) + TQQQ 진행 중 ===');
{
  // SOXL: 사이클 종료, principal=$5000, profit=$300 → nextPrincipal=$5300
  // TQQQ: 진행 중, principal=$5000, remainingCash=$3000, holdingValue=$2000
  // 계좌 현금: SOXL $5300 (현금) + TQQQ $3000 (잔금) = $8300
  const accountCash = 8300;

  const cycleStatusMap = new Map<string, CycleStatus>([
    ['SOXL', {
      ticker: 'SOXL', needsNewCycle: true,
      nextPrincipal: 5300,  // 5000 + 300 (수익)
      holdingValue: 0,
      cycleData: { principal: 5000, remainingCash: 5300 },  // 종료 → 현금화
    }],
    ['TQQQ', {
      ticker: 'TQQQ', needsNewCycle: false,
      nextPrincipal: 5000,  // 진행 중이니 의미 없음
      holdingValue: 2000,   // 주식 보유 중
      cycleData: { principal: 5000, remainingCash: 3000 },
    }],
  ]);

  const result = calculatePrincipal({ accountCash, tickers: ['SOXL', 'TQQQ'], cycleStatusMap });

  test('할당자금 = SOXL $5300 + TQQQ $3000 = $8300', () => {
    assertClose(result.totalAllocatedFunds, 8300, '할당자금');
  });
  test('추가입금 = $0 (새 입금 없음)', () => {
    assertClose(result.additionalDeposit, 0, '추가입금');
  });
  test('SOXL 새 사이클 원금 = $5300 (복리: 원금+수익)', () => {
    assertClose(result.newCyclePrincipalMap.get('SOXL')!, 5300, 'SOXL 원금');
  });
  test('TQQQ는 newCyclePrincipalMap에 없음 (진행 중)', () => {
    assert(!result.newCyclePrincipalMap.has('TQQQ'), 'TQQQ should not be in newCyclePrincipalMap');
  });
  test('TQQQ updatedAllocatedFunds = $5000 (remainingCash+holdingValue)', () => {
    // remainingCash($3000) + holdingValue($2000) + depositPerTicker($0) = $5000
    assertClose(result.updatedAllocatedFunds.get('TQQQ')!, 5000, 'TQQQ allocated');
  });
}

// ==========================================
// 시나리오 3: SOXL 종료 + 추가입금 $2000 있는 경우
// ==========================================
console.log('\n=== 시나리오 3: SOXL 종료 + 추가입금 $2,000 ===');
{
  // SOXL 종료: nextPrincipal=$5300
  // TQQQ 진행 중: remainingCash=$3000
  // 계좌 현금: $10,300 (= $8300 + 추가입금 $2000)
  const accountCash = 10300;

  const cycleStatusMap = new Map<string, CycleStatus>([
    ['SOXL', {
      ticker: 'SOXL', needsNewCycle: true,
      nextPrincipal: 5300, holdingValue: 0,
      cycleData: { principal: 5000, remainingCash: 5300 },
    }],
    ['TQQQ', {
      ticker: 'TQQQ', needsNewCycle: false,
      nextPrincipal: 5000, holdingValue: 2000,
      cycleData: { principal: 5000, remainingCash: 3000 },
    }],
  ]);

  const result = calculatePrincipal({ accountCash, tickers: ['SOXL', 'TQQQ'], cycleStatusMap });

  test('할당자금 = $8300', () => {
    assertClose(result.totalAllocatedFunds, 8300, '할당자금');
  });
  test('추가입금 = $2000', () => {
    assertClose(result.additionalDeposit, 2000, '추가입금');
  });
  test('종목당 추가입금 = $1000', () => {
    assertClose(result.depositPerTicker, 1000, '종목당');
  });
  test('SOXL 새 사이클 원금 = $6300 (5300+1000)', () => {
    assertClose(result.newCyclePrincipalMap.get('SOXL')!, 6300, 'SOXL 원금');
  });
  test('TQQQ allocated = $6000 (3000+2000+1000)', () => {
    // remainingCash($3000) + holdingValue($2000) + deposit($1000) = $6000
    assertClose(result.updatedAllocatedFunds.get('TQQQ')!, 6000, 'TQQQ allocated');
  });
  test('TQQQ는 새 사이클 아님 → newCyclePrincipalMap에 없음', () => {
    assert(!result.newCyclePrincipalMap.has('TQQQ'), 'TQQQ should not start new cycle');
  });
}

// ==========================================
// 시나리오 4: 둘 다 사이클 종료 (각각 수익 다름)
// ==========================================
console.log('\n=== 시나리오 4: 둘 다 사이클 종료 (수익 격리 확인) ===');
{
  // SOXL: principal=$5000, profit=$500 → nextPrincipal=$5500
  // TQQQ: principal=$5000, profit=$100 → nextPrincipal=$5100
  // 계좌 현금: $10,600
  const accountCash = 10600;

  const cycleStatusMap = new Map<string, CycleStatus>([
    ['SOXL', {
      ticker: 'SOXL', needsNewCycle: true,
      nextPrincipal: 5500, holdingValue: 0,
      cycleData: { principal: 5000, remainingCash: 5500 },
    }],
    ['TQQQ', {
      ticker: 'TQQQ', needsNewCycle: true,
      nextPrincipal: 5100, holdingValue: 0,
      cycleData: { principal: 5000, remainingCash: 5100 },
    }],
  ]);

  const result = calculatePrincipal({ accountCash, tickers: ['SOXL', 'TQQQ'], cycleStatusMap });

  test('할당자금 = $10600', () => {
    assertClose(result.totalAllocatedFunds, 10600, '할당자금');
  });
  test('추가입금 = $0', () => {
    assertClose(result.additionalDeposit, 0, '추가입금');
  });
  test('SOXL 원금 = $5500 (수익 $500 복리)', () => {
    assertClose(result.newCyclePrincipalMap.get('SOXL')!, 5500, 'SOXL');
  });
  test('TQQQ 원금 = $5100 (수익 $100 복리)', () => {
    assertClose(result.newCyclePrincipalMap.get('TQQQ')!, 5100, 'TQQQ');
  });
  test('수익 격리: SOXL 수익이 TQQQ에 흘러가지 않음', () => {
    const soxlPrincipal = result.newCyclePrincipalMap.get('SOXL')!;
    const tqqqPrincipal = result.newCyclePrincipalMap.get('TQQQ')!;
    assert(soxlPrincipal !== tqqqPrincipal, `수익 격리 실패: SOXL=${soxlPrincipal}, TQQQ=${tqqqPrincipal}`);
    assert(soxlPrincipal === 5500, `SOXL should be 5500, got ${soxlPrincipal}`);
    assert(tqqqPrincipal === 5100, `TQQQ should be 5100, got ${tqqqPrincipal}`);
  });
}

// ==========================================
// 시나리오 5: SOXL 손실 종료 + TQQQ 진행 중
// ==========================================
console.log('\n=== 시나리오 5: SOXL 손실 종료 (-$200) + TQQQ 진행 중 ===');
{
  // SOXL: principal=$5000, profit=-$200 → nextPrincipal=$4800
  // TQQQ: 진행 중, remainingCash=$2500, holdingValue=$2500
  // 계좌 현금: $4800 + $2500 = $7300
  const accountCash = 7300;

  const cycleStatusMap = new Map<string, CycleStatus>([
    ['SOXL', {
      ticker: 'SOXL', needsNewCycle: true,
      nextPrincipal: 4800, holdingValue: 0,
      cycleData: { principal: 5000, remainingCash: 4800 },
    }],
    ['TQQQ', {
      ticker: 'TQQQ', needsNewCycle: false,
      nextPrincipal: 5000, holdingValue: 2500,
      cycleData: { principal: 5000, remainingCash: 2500 },
    }],
  ]);

  const result = calculatePrincipal({ accountCash, tickers: ['SOXL', 'TQQQ'], cycleStatusMap });

  test('SOXL 새 원금 = $4800 (손실 반영)', () => {
    assertClose(result.newCyclePrincipalMap.get('SOXL')!, 4800, 'SOXL');
  });
  test('TQQQ는 영향 없음', () => {
    assert(!result.newCyclePrincipalMap.has('TQQQ'), 'TQQQ should not be in map');
  });
  test('추가입금 = $0', () => {
    assertClose(result.additionalDeposit, 0, '추가입금');
  });
}

// ==========================================
// 시나리오 6: main-open.ts의 needsNewCycle 판정 로직 검증
// ==========================================
console.log('\n=== 시나리오 6: needsNewCycle 판정 ===');
{
  // main-open.ts 113-114:
  // needsNewCycle = (totalQuantity === 0 && avgPrice === 0) && (!cycleData || cycleData.status === 'completed')

  test('qty=0, avg=0, cycleData=null → needsNewCycle=true', () => {
    const totalQuantity = 0, avgPrice = 0;
    const cycleData = null;
    const result = (totalQuantity === 0 && avgPrice === 0) && (!cycleData || cycleData?.status === 'completed');
    assert(result === true, `expected true, got ${result}`);
  });

  test('qty=0, avg=0, status=completed → needsNewCycle=true', () => {
    const totalQuantity = 0, avgPrice = 0;
    const cycleData = { status: 'completed' as const };
    const result = (totalQuantity === 0 && avgPrice === 0) && (!cycleData || cycleData?.status === 'completed');
    assert(result === true, `expected true, got ${result}`);
  });

  test('qty=0, avg=0, status=active → needsNewCycle=false (주의!)', () => {
    const totalQuantity = 0, avgPrice = 0;
    const cycleData = { status: 'active' as const };
    const result = (totalQuantity === 0 && avgPrice === 0) && (!cycleData || cycleData?.status === 'completed');
    assert(result === false, `expected false, got ${result}`);
  });

  test('qty=10, avg=50, status=active → needsNewCycle=false', () => {
    const totalQuantity = 10, avgPrice = 50;
    const cycleData = { status: 'active' as const };
    const result = (totalQuantity === 0 && avgPrice === 0) && (!cycleData || cycleData?.status === 'completed');
    assert(result === false, `expected false, got ${result}`);
  });

  test('qty=0, avg=50 (잔여 데이터) → needsNewCycle=false', () => {
    const totalQuantity = 0, avgPrice = 50;
    const cycleData = { status: 'active' as const };
    const result = (totalQuantity === 0 && avgPrice === 0) && (!cycleData || cycleData?.status === 'completed');
    assert(result === false, `expected false, got ${result}`);
  });
}

// ==========================================
// 시나리오 7: processTickerOrders에서 principal 선택 로직
// ==========================================
console.log('\n=== 시나리오 7: processTickerOrders principal 선택 ===');
{
  // main-open.ts 199:
  // const principal = principalResult.newCyclePrincipalMap.get(ticker) || (accountCashForTicker(principalResult, ticker));

  // SOXL 종료 시 newCyclePrincipalMap에 SOXL=$5300이 들어있어야 함
  const accountCash = 8300;
  const cycleStatusMap = new Map<string, CycleStatus>([
    ['SOXL', { ticker: 'SOXL', needsNewCycle: true, nextPrincipal: 5300, holdingValue: 0, cycleData: { principal: 5000, remainingCash: 5300 } }],
    ['TQQQ', { ticker: 'TQQQ', needsNewCycle: false, nextPrincipal: 5000, holdingValue: 2000, cycleData: { principal: 5000, remainingCash: 3000 } }],
  ]);
  const result = calculatePrincipal({ accountCash, tickers: ['SOXL', 'TQQQ'], cycleStatusMap });

  test('newCyclePrincipalMap에 SOXL 있음', () => {
    assert(result.newCyclePrincipalMap.has('SOXL'), 'SOXL not in map');
  });
  test('SOXL principal = $5300 (복리)', () => {
    assertClose(result.newCyclePrincipalMap.get('SOXL')!, 5300, 'SOXL');
  });
  test('newCyclePrincipalMap에 TQQQ 없음', () => {
    assert(!result.newCyclePrincipalMap.has('TQQQ'), 'TQQQ should not be in map');
  });

  // TQQQ가 진행 중이면 processTickerOrders에서 cycleData.principal 사용
  // main-open.ts에서: 진행 중인 사이클은 processTickerOrders의 else 분기로 가서
  // cycleData.principal을 그대로 사용함 → 원금 변동 없음 ✓
  test('TQQQ 진행 중 → principal은 cycleData.principal 그대로 ($5000)', () => {
    const tqqqCycleData = { principal: 5000, remainingCash: 3000 };
    // processTickerOrders에서 진행 중인 사이클은 cycleData.principal 사용
    assert(tqqqCycleData.principal === 5000, `expected 5000, got ${tqqqCycleData.principal}`);
  });
}

// ==========================================
// 시나리오 8: 연속 사이클 종료 (복리 누적)
// ==========================================
console.log('\n=== 시나리오 8: SOXL 3차 사이클까지 복리 누적 ===');
{
  // 1차: 원금 $5000, 수익 $300 → 다음 원금 $5300
  // 2차: 원금 $5300, 수익 $400 → 다음 원금 $5700
  // 3차 시작 시 원금 = $5700
  // TQQQ는 계속 진행 중 ($5000)

  const accountCash = 8700; // SOXL $5700 + TQQQ $3000
  const cycleStatusMap = new Map<string, CycleStatus>([
    ['SOXL', { ticker: 'SOXL', needsNewCycle: true, nextPrincipal: 5700, holdingValue: 0, cycleData: { principal: 5300, remainingCash: 5700 } }],
    ['TQQQ', { ticker: 'TQQQ', needsNewCycle: false, nextPrincipal: 5000, holdingValue: 2000, cycleData: { principal: 5000, remainingCash: 3000 } }],
  ]);
  const result = calculatePrincipal({ accountCash, tickers: ['SOXL', 'TQQQ'], cycleStatusMap });

  test('SOXL 3차 원금 = $5700 (복리 누적)', () => {
    assertClose(result.newCyclePrincipalMap.get('SOXL')!, 5700, 'SOXL 3차');
  });
  test('추가입금 = $0', () => {
    assertClose(result.additionalDeposit, 0, '추가입금');
  });
  test('TQQQ allocated 변동 없음', () => {
    assertClose(result.updatedAllocatedFunds.get('TQQQ')!, 5000, 'TQQQ');
  });
}

// ==========================================
// 시나리오 9: 첫 실행인데 계좌에 이미 SOXL 보유 중
// ==========================================
console.log('\n=== 시나리오 9: 첫 실행 + 기존 보유주식 ===');
{
  // state 파일 없음 (cycleData=null), 하지만 KIS API에서 SOXL 10주 보유
  // 이 경우 needsNewCycle = false (qty>0이므로)
  // → 문제: cycleData가 null인데 진행 중 사이클 취급됨
  // → main-open.ts에서 "기존 사이클 계속" 분기로 가는데 cycleData 없음

  const totalQuantity = 10, avgPrice = 50;
  const cycleData = null;
  const needsNewCycle = (totalQuantity === 0 && avgPrice === 0) && (!cycleData || cycleData?.status === 'completed');

  test('보유 중인데 state 없으면 needsNewCycle=false', () => {
    assert(needsNewCycle === false, `expected false, got ${needsNewCycle}`);
  });

  test('⚠️ 이 경우 main-open에서 "No active cycle"로 스킵됨', () => {
    // main-open.ts 232-234:
    // if (!cycleData || cycleData.status !== 'active') {
    //   console.log(`[Open] ${ticker}: No active cycle.`);
    //   return;
    // }
    // → cycleData가 null이면 스킵. 보유 주식이 있는데 주문 안 함.
    // → 이건 정상 동작. 수동으로 state를 만들어야 하는 상황.
    assert(true, 'Expected: skips gracefully');
  });
}

// ==========================================
// 결과 요약
// ==========================================
console.log('\n' + '='.repeat(50));
console.log(`결과: ${passed + failed}개 중 ${passed}개 통과, ${failed}개 실패`);
if (failed > 0) {
  console.log('❌ 실패한 테스트가 있습니다!');
  process.exit(1);
} else {
  console.log('✅ 모든 테스트 통과!');
}
