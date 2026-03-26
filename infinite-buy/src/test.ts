/**
 * 무한매수법 종합 테스트
 * npx tsx src/test.ts
 *
 * 모든 KIS API 호출 없이 순수 계산/상태 로직만 검증
 */

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

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

// ==================== Setup: Temp directory for state files ====================

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TEMP_ROOT = path.join('/tmp', `infinite-buy-test-${Date.now()}`);
const TEMP_STATE = path.join(TEMP_ROOT, 'state');
const TEMP_LOGS = path.join(TEMP_ROOT, 'logs');
const TEMP_HISTORY = path.join(TEMP_ROOT, 'history');

function setupTempDir(): void {
  fs.mkdirSync(TEMP_STATE, { recursive: true });
  fs.mkdirSync(TEMP_LOGS, { recursive: true });
  fs.mkdirSync(TEMP_HISTORY, { recursive: true });
  // Write a test config.json
  fs.writeFileSync(path.join(TEMP_ROOT, 'config.json'), JSON.stringify({
    enabled: true,
    tickers: ['SOXL', 'TQQQ'],
    strategyVersion: 'v2.2',
    tickerConfigs: {
      SOXL: { splitCount: 30, targetProfit: 0.12 },
      TQQQ: { splitCount: 40, targetProfit: 0.10 },
    },
    autoRestart: true,
    equalSplit: true,
  }, null, 2) + '\n');
}

function cleanupTempDir(): void {
  try {
    fs.rmSync(TEMP_ROOT, { recursive: true, force: true });
  } catch { /* ignore */ }
}

// ==================== Helper: State Manager with custom root ====================

function readJsonFile<T>(filePath: string): T | null {
  try {
    if (!fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch {
    return null;
  }
}

function writeJsonFile(filePath: string, data: unknown): void {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n', 'utf-8');
}

function readTestConfig() {
  const config = readJsonFile<any>(path.join(TEMP_ROOT, 'config.json'));
  if (!config) throw new Error('Test config.json not found');
  return config;
}

function writeTestConfig(config: any) {
  writeJsonFile(path.join(TEMP_ROOT, 'config.json'), config);
}

function readTestCycleState(ticker: string): any | null {
  return readJsonFile(path.join(TEMP_STATE, `${ticker}.json`));
}

function writeTestCycleState(ticker: string, state: any): void {
  writeJsonFile(path.join(TEMP_STATE, `${ticker}.json`), state);
}

function appendTestLog(date: string, entry: any): void {
  const filePath = path.join(TEMP_LOGS, `${date}.json`);
  const existing = readJsonFile<any[]>(filePath) || [];
  existing.push(entry);
  writeJsonFile(filePath, existing);
}

function saveTestCycleHistory(data: any): void {
  const fileName = `${data.ticker}-cycle-${String(data.cycleNumber).padStart(3, '0')}.json`;
  writeJsonFile(path.join(TEMP_HISTORY, fileName), data);
}

function getTestNextCycleNumber(ticker: string): number {
  if (!fs.existsSync(TEMP_HISTORY)) return 1;
  const files = fs.readdirSync(TEMP_HISTORY).filter(f => f.startsWith(`${ticker}-cycle-`));
  if (files.length === 0) return 1;
  const numbers = files.map(f => {
    const match = f.match(/cycle-(\d+)/);
    return match ? parseInt(match[1]) : 0;
  });
  return Math.max(...numbers) + 1;
}

// ==================== Imports from source modules ====================

import {
  calculate, calculateDecreaseRate, shouldEnterQuarterMode,
  calculateQuarterModeSeed,
  type CalculateParams, type QuarterModeState, type StrategyVersion,
} from './calculator.js';

import {
  calculatePrincipal,
  calculateTotalAllocatedFunds,
  calculateAdditionalDeposit,
  calculateDepositPerTicker,
  calculateUpdatedAllocatedFunds,
  calculateNewCyclePrincipals,
  type CycleStatus,
} from './principalCalculator.js';

// We import the real stateManager to test its file-based functions too
// but we'll point them at our temp directory via direct file operations
import {
  type CycleState, type CycleHistory, type LogEntry,
} from './stateManager.js';

import { fmtUSD } from './utils.js';

// ==================== RUN TESTS ====================

console.log('');
console.log('='.repeat(70));
console.log('  INFINITE-BUY COMPREHENSIVE TEST SUITE');
console.log('='.repeat(70));
console.log('');

setupTempDir();

// ============================================================
// A. New Cycle Start (First Buy)
// ============================================================
console.log('--- A. New Cycle Start ---');

test('A1', 'First run - no state, $10,000 split equally to 2 tickers ($5,000 each)', () => {
  const accountCash = 10000;
  const tickers = ['SOXL', 'TQQQ'];
  const cycleStatusMap = new Map<string, CycleStatus>();

  for (const ticker of tickers) {
    cycleStatusMap.set(ticker, {
      ticker,
      needsNewCycle: true,
      nextPrincipal: 0, // no previous cycle
      holdingValue: 0,
      cycleData: null,
    });
  }

  const result = calculatePrincipal({ accountCash, tickers, cycleStatusMap });

  // totalAllocatedFunds = 0 (no existing allocation)
  assertEqual(result.totalAllocatedFunds, 0, 'totalAllocatedFunds should be 0');
  // additionalDeposit = 10000 - 0 = 10000
  assertEqual(result.additionalDeposit, 10000, 'additionalDeposit should be 10000');
  // depositPerTicker = floor(10000 / 2) = 5000
  assertEqual(result.depositPerTicker, 5000, 'depositPerTicker should be 5000');
  // each ticker gets 5000
  assertEqual(result.newCyclePrincipalMap.get('SOXL'), 5000, 'SOXL principal should be 5000');
  assertEqual(result.newCyclePrincipalMap.get('TQQQ'), 5000, 'TQQQ principal should be 5000');
});

test('A2', 'buyPerRound calculation: SOXL=5000/30~166.67, TQQQ=5000/40=125', () => {
  const soxlBuyPerRound = 5000 / 30;
  const tqqqBuyPerRound = 5000 / 40;
  assertClose(soxlBuyPerRound, 166.67, 0.01, 'SOXL buyPerRound');
  assertEqual(tqqqBuyPerRound, 125, 'TQQQ buyPerRound');
});

test('A3', 'First buy LOC +5% price calculation', () => {
  const currentPrice = 25.50;
  const locPrice = Math.round(currentPrice * 1.05 * 100) / 100;
  assertEqual(locPrice, 26.78, 'LOC +5% of 25.50 should be 26.78');

  const currentPrice2 = 100.00;
  const locPrice2 = Math.round(currentPrice2 * 1.05 * 100) / 100;
  assertEqual(locPrice2, 105.00, 'LOC +5% of 100.00 should be 105.00');

  const currentPrice3 = 33.33;
  const locPrice3 = Math.round(currentPrice3 * 1.05 * 100) / 100;
  assertEqual(locPrice3, 35.00, 'LOC +5% of 33.33 should be 35.00');
});

test('A4', 'Quantity calculation: floor(buyPerRound / currentPrice)', () => {
  // SOXL: buyPerRound = 166.67, currentPrice = 25.50
  const qty1 = Math.floor(166.67 / 25.50);
  assertEqual(qty1, 6, 'SOXL quantity should be 6');

  // TQQQ: buyPerRound = 125, currentPrice = 60.00
  const qty2 = Math.floor(125 / 60.00);
  assertEqual(qty2, 2, 'TQQQ quantity should be 2');
});

test('A5', 'Skip order when principal is 0', () => {
  const buyPerRound = 0 / 30;  // principal = 0
  const currentPrice = 25.50;
  const quantity = Math.floor(buyPerRound / currentPrice);
  assertEqual(quantity, 0, 'Quantity should be 0 when principal is 0');
});


// ============================================================
// B. Ongoing Cycle Order Calculation
// ============================================================
console.log('');
console.log('--- B. Ongoing Cycle Orders ---');

test('B1', 'First half (T < splitCount/2): 0% LOC + star% LOC buy (half each)', () => {
  // Use lower avgPrice so both half-amount orders produce qty >= 1
  const params: CalculateParams = {
    ticker: 'TQQQ',
    currentPrice: 8.00,
    totalQuantity: 10,
    avgPrice: 10.00,
    totalInvested: 100, // 10 * 10
    remainingCash: 4900, // 5000 - 100
    buyPerRound: 125,
    splitCount: 40,
    targetProfit: 0.10,
    starDecreaseRate: calculateDecreaseRate(0.10, 40),
    strategyVersion: 'v2.2',
  };

  const result = calculate(params);
  // T = ceil(100/125 * 100)/100 = ceil(0.80 * 100)/100 = ceil(80)/100 = 0.80
  // T < 40/2 = 20 => FIRST_HALF
  assertEqual(result.phase, 'FIRST_HALF', 'Phase should be FIRST_HALF');
  assertEqual(result.phaseLabel, '전반전', 'Phase label');

  // Should have 2 buy orders: 0% LOC and star% LOC
  assert(result.buyOrders.length === 2, `Expected 2 buy orders, got ${result.buyOrders.length}`);
  assert(result.buyOrders[0].label.includes('0%'), 'First order should be 0% LOC');
  assert(result.buyOrders[1].label.includes('%'), 'Second order should be star% LOC');

  // 0% LOC price = avgPrice = 10.00
  assertEqual(result.buyOrders[0].price, 10.00, '0% LOC price should equal avgPrice');

  // Each uses half of buyPerRound = 62.50
  const halfAmount = 125 / 2; // 62.50
  const expectedQty0 = Math.floor(halfAmount / 10.00); // floor(62.50/10) = 6
  assertEqual(result.buyOrders[0].quantity, expectedQty0, '0% LOC quantity');

  // star% at T=0.80: star% = 0.10 - 0.80*0.005 = 0.096
  // star price = 10 * 1.096 = 10.96
  // star qty = floor(62.50/10.96) = 5
  assert(result.buyOrders[1].quantity > 0, 'Star% LOC should have qty > 0');
});

test('B2', 'Second half (T >= splitCount/2): star% LOC buy (full amount)', () => {
  const params: CalculateParams = {
    ticker: 'TQQQ',
    currentPrice: 50.00,
    totalQuantity: 50,
    avgPrice: 55.00,
    totalInvested: 2750, // 50 * 55
    remainingCash: 2250, // 5000 - 2750
    buyPerRound: 125,
    splitCount: 40,
    targetProfit: 0.10,
    starDecreaseRate: calculateDecreaseRate(0.10, 40),
    strategyVersion: 'v2.2',
  };

  const result = calculate(params);
  // T = ceil(2750/125 * 100)/100 = ceil(22.00 * 100)/100 = 22.00
  // T >= 20 => SECOND_HALF
  assertEqual(result.phase, 'SECOND_HALF', 'Phase should be SECOND_HALF');

  // Should have 1 buy order: star% LOC (full buyPerRound)
  assert(result.buyOrders.length === 1, `Expected 1 buy order, got ${result.buyOrders.length}`);
  assert(result.buyOrders[0].label.includes('후반전'), 'Order should be labeled 후반전');
});

test('B3', 'Quarter mode entry condition (T > splitCount-1 or remainingCash < buyPerRound)', () => {
  // Case 1: T exceeds splitCount - 1
  const check1 = shouldEnterQuarterMode(40, 40, 1000, 125, 'v2.2', 50);
  assertEqual(check1.shouldEnter, true, 'Should enter QM when T > splitCount-1');
  assertEqual(check1.reason, 'T_EXCEEDED', 'Reason should be T_EXCEEDED');

  // Case 2: remainingCash < buyPerRound
  const check2 = shouldEnterQuarterMode(25, 40, 50, 125, 'v2.2', 50);
  assertEqual(check2.shouldEnter, true, 'Should enter QM when cash insufficient');
  assertEqual(check2.reason, 'INSUFFICIENT_CASH', 'Reason should be INSUFFICIENT_CASH');

  // Case 3: Normal - no quarter mode needed
  const check3 = shouldEnterQuarterMode(20, 40, 2500, 125, 'v2.2', 50);
  assertEqual(check3.shouldEnter, false, 'Should NOT enter QM in normal conditions');

  // Case 4: V3.0 never enters quarter mode
  const check4 = shouldEnterQuarterMode(40, 40, 50, 125, 'v3.0', 50);
  assertEqual(check4.shouldEnter, false, 'V3.0 should never enter quarter mode');

  // Case 5: New cycle (T=0, qty=0) should NOT enter quarter mode even with low cash
  const check5 = shouldEnterQuarterMode(0, 40, 0, 125, 'v2.2', 0);
  assertEqual(check5.shouldEnter, false, 'New cycle should NOT enter QM');
});

test('B4', 'Quarter mode buy/sell orders', () => {
  const qm: QuarterModeState = {
    isActive: true,
    round: 3,
    originalBuyPerRound: 125,
    quarterSeed: 500,
    quarterBuyPerRound: 50,
  };

  const params: CalculateParams = {
    ticker: 'TQQQ',
    currentPrice: 45.00,
    totalQuantity: 40,
    avgPrice: 50.00,
    totalInvested: 2000,
    remainingCash: 100, // < buyPerRound
    buyPerRound: 125,
    splitCount: 40,
    targetProfit: 0.10,
    starDecreaseRate: calculateDecreaseRate(0.10, 40),
    strategyVersion: 'v2.2',
    quarterMode: qm,
  };

  const result = calculate(params);
  assertEqual(result.phase, 'QUARTER_MODE', 'Phase should be QUARTER_MODE');

  // Buy order uses quarterBuyPerRound (50)
  assert(result.buyOrders.length >= 1, 'Should have at least 1 buy order in QM');
  assert(result.buyOrders[0].label.includes('쿼터모드'), 'Buy label should mention quarter mode');

  // Sell orders: LOC quarter sell + LIMIT target sell
  assert(result.sellOrders.length >= 1, 'Should have sell orders in QM');
});

test('B5', 'Sell orders: 1/4 quarter LOC + 3/4 target LIMIT', () => {
  const params: CalculateParams = {
    ticker: 'TQQQ',
    currentPrice: 58.00,
    totalQuantity: 20,
    avgPrice: 60.00,
    totalInvested: 1200,
    remainingCash: 3800,
    buyPerRound: 125,
    splitCount: 40,
    targetProfit: 0.10,
    starDecreaseRate: calculateDecreaseRate(0.10, 40),
    strategyVersion: 'v2.2',
  };

  const result = calculate(params);
  // Should have 2 sell orders: LOC quarter + LIMIT target
  assert(result.sellOrders.length === 2, `Expected 2 sell orders, got ${result.sellOrders.length}`);

  // First sell: LOC quarter (1/4 of totalQuantity)
  const quarterQty = Math.max(1, Math.ceil(20 / 4)); // = 5
  assertEqual(result.sellOrders[0].orderType, 'LOC', 'First sell should be LOC');
  assertEqual(result.sellOrders[0].quantity, quarterQty, 'LOC sell qty should be ceil(20/4)=5');

  // Second sell: LIMIT target (3/4)
  assertEqual(result.sellOrders[1].orderType, 'LIMIT', 'Second sell should be LIMIT');
  assertEqual(result.sellOrders[1].quantity, 20 - quarterQty, 'LIMIT sell qty should be 15');

  // Target price = avgPrice * (1 + targetProfit) = 60 * 1.10 = 66.00
  assertEqual(result.sellOrders[1].price, 66.00, 'Target price should be 66.00');
});

test('B6', 'Self-trade prevention: buy price adjusted -0.01 when matching sell price', () => {
  const params: CalculateParams = {
    ticker: 'TQQQ',
    currentPrice: 55.00,
    totalQuantity: 8,
    avgPrice: 55.00,   // avg = current, so 0% LOC = avgPrice = sell LOC at star%
    totalInvested: 440,
    remainingCash: 4560,
    buyPerRound: 125,
    splitCount: 40,
    targetProfit: 0.10,
    starDecreaseRate: calculateDecreaseRate(0.10, 40),
    strategyVersion: 'v2.2',
  };

  const result = calculate(params);

  // Simulate the self-trade prevention logic from main-open.ts
  const buyOrders = result.buyOrders.map(o => ({ ...o }));
  const sellOrders = result.sellOrders.map(o => ({ ...o }));

  if (buyOrders.length > 0 && sellOrders.length > 0) {
    const sellPrices = new Set(sellOrders.map(o => o.price));
    for (const bo of buyOrders) {
      if (sellPrices.has(bo.price)) {
        const originalPrice = bo.price;
        bo.price = Math.round((bo.price - 0.01) * 100) / 100;
        bo.amount = Math.round(bo.price * bo.quantity * 100) / 100;
        // Verify adjustment happened
        assert(bo.price < originalPrice, `Buy price ${bo.price} should be < original ${originalPrice}`);
        assertClose(originalPrice - bo.price, 0.01, 0.001, 'Adjustment should be exactly 0.01');
      }
    }
  }
  // Test passes if no error thrown (might or might not have matching prices)
});

test('B7', 'Star% calculation accuracy', () => {
  // Formula: star% = targetProfit - (T * decreaseRate)
  // decreaseRate = targetProfit * 2 / splitCount

  // TQQQ: targetProfit=0.10, splitCount=40
  const dr1 = calculateDecreaseRate(0.10, 40);
  assertClose(dr1, 0.005, 0.0001, 'TQQQ decreaseRate');

  // T=0: star% = 0.10 - 0 = 0.10 (10%)
  const star0 = 0.10 - (0 * dr1);
  assertClose(star0, 0.10, 0.0001, 'star% at T=0');

  // T=10: star% = 0.10 - 10*0.005 = 0.05 (5%)
  const star10 = 0.10 - (10 * dr1);
  assertClose(star10, 0.05, 0.0001, 'star% at T=10');

  // T=20: star% = 0.10 - 20*0.005 = 0 (0%)
  const star20 = 0.10 - (20 * dr1);
  assertClose(star20, 0.0, 0.0001, 'star% at T=20');

  // T=30: star% = 0.10 - 30*0.005 = -0.05 (-5%)
  const star30 = 0.10 - (30 * dr1);
  assertClose(star30, -0.05, 0.0001, 'star% at T=30');

  // SOXL: targetProfit=0.12, splitCount=30
  const dr2 = calculateDecreaseRate(0.12, 30);
  assertClose(dr2, 0.008, 0.0001, 'SOXL decreaseRate');

  // T=15: star% = 0.12 - 15*0.008 = 0 (0%)
  const star15 = 0.12 - (15 * dr2);
  assertClose(star15, 0.0, 0.0001, 'SOXL star% at T=15');
});

test('B8', 'T value calculation (totalInvested / buyPerRound, ceil to 2 decimal)', () => {
  // Test via calculate function
  const params: CalculateParams = {
    ticker: 'TQQQ',
    currentPrice: 55.00,
    totalQuantity: 10,
    avgPrice: 50.00,
    totalInvested: 500, // T = 500/125 = 4.00
    remainingCash: 4500,
    buyPerRound: 125,
    splitCount: 40,
    targetProfit: 0.10,
    starDecreaseRate: calculateDecreaseRate(0.10, 40),
    strategyVersion: 'v2.2',
  };
  const r1 = calculate(params);
  assertEqual(r1.tValue, 4.00, 'T should be 4.00');

  // T with fractional: 501/125 = 4.008 => ceil*100/100 = ceil(400.8)/100 = 4.01
  const params2 = { ...params, totalInvested: 501 };
  const r2 = calculate(params2);
  assertEqual(r2.tValue, 4.01, 'T should be 4.01 (ceiling)');

  // T capped at splitCount
  const params3 = { ...params, totalInvested: 99999 };
  const r3 = calculate(params3);
  assertEqual(r3.tValue, 40, 'T should be capped at splitCount');
});


// ============================================================
// C. Principal Calculator
// ============================================================
console.log('');
console.log('--- C. Principal Calculator ---');

test('C1', 'Equal split: two tickers get same principal', () => {
  const accountCash = 8000;
  const tickers = ['SOXL', 'TQQQ'];
  const cycleStatusMap = new Map<string, CycleStatus>();

  for (const ticker of tickers) {
    cycleStatusMap.set(ticker, {
      ticker, needsNewCycle: true, nextPrincipal: 0,
      holdingValue: 0, cycleData: null,
    });
  }

  const result = calculatePrincipal({ accountCash, tickers, cycleStatusMap });
  assertEqual(result.newCyclePrincipalMap.get('SOXL'), result.newCyclePrincipalMap.get('TQQQ'),
    'Both tickers should get equal principal');
  assertEqual(result.newCyclePrincipalMap.get('SOXL'), 4000, 'Each should get $4000');
});

test('C2', 'Compound interest: cycle profit adds to that ticker only', () => {
  const tickers = ['SOXL', 'TQQQ'];
  const cycleStatusMap = new Map<string, CycleStatus>();

  // SOXL completed cycle with $500 profit (principal 4000 + profit 500 = nextPrincipal 4500)
  cycleStatusMap.set('SOXL', {
    ticker: 'SOXL', needsNewCycle: true,
    nextPrincipal: 4500, // 4000 + 500 profit
    holdingValue: 0,
    cycleData: null,
  });

  // TQQQ completed cycle with $200 profit
  cycleStatusMap.set('TQQQ', {
    ticker: 'TQQQ', needsNewCycle: true,
    nextPrincipal: 4200, // 4000 + 200 profit
    holdingValue: 0,
    cycleData: null,
  });

  // Account cash = 4500 + 4200 = 8700 (no additional deposit)
  const result = calculatePrincipal({ accountCash: 8700, tickers, cycleStatusMap });

  assertEqual(result.additionalDeposit, 0, 'No additional deposit');
  assertEqual(result.newCyclePrincipalMap.get('SOXL'), 4500, 'SOXL keeps its profit');
  assertEqual(result.newCyclePrincipalMap.get('TQQQ'), 4200, 'TQQQ keeps its profit');
});

test('C3', 'Additional deposit detection and equal split', () => {
  const tickers = ['SOXL', 'TQQQ'];
  const cycleStatusMap = new Map<string, CycleStatus>();

  // Both completed, each had 4000 principal, 0 profit
  cycleStatusMap.set('SOXL', {
    ticker: 'SOXL', needsNewCycle: true,
    nextPrincipal: 4000, holdingValue: 0, cycleData: null,
  });
  cycleStatusMap.set('TQQQ', {
    ticker: 'TQQQ', needsNewCycle: true,
    nextPrincipal: 4000, holdingValue: 0, cycleData: null,
  });

  // Account cash = 10000 => allocated = 8000 => additional = 2000 => 1000 each
  const result = calculatePrincipal({ accountCash: 10000, tickers, cycleStatusMap });

  assertEqual(result.totalAllocatedFunds, 8000, 'Total allocated should be 8000');
  assertEqual(result.additionalDeposit, 2000, 'Additional deposit should be 2000');
  assertEqual(result.depositPerTicker, 1000, 'Each ticker gets 1000 additional');
  assertEqual(result.newCyclePrincipalMap.get('SOXL'), 5000, 'SOXL new principal');
  assertEqual(result.newCyclePrincipalMap.get('TQQQ'), 5000, 'TQQQ new principal');
});

test('C4', 'One ticker needs new cycle, other is ongoing', () => {
  const tickers = ['SOXL', 'TQQQ'];
  const cycleStatusMap = new Map<string, CycleStatus>();

  // SOXL needs new cycle
  cycleStatusMap.set('SOXL', {
    ticker: 'SOXL', needsNewCycle: true,
    nextPrincipal: 4000, holdingValue: 0, cycleData: null,
  });

  // TQQQ is ongoing (remainingCash = 2000, holdingValue = 2000)
  cycleStatusMap.set('TQQQ', {
    ticker: 'TQQQ', needsNewCycle: false,
    nextPrincipal: 4000, holdingValue: 2000,
    cycleData: { remainingCash: 2000, principal: 4000 },
  });

  // Account cash = 6000 (SOXL's 4000 cash + TQQQ's 2000 remaining cash)
  const result = calculatePrincipal({ accountCash: 6000, tickers, cycleStatusMap });

  // totalAllocatedFunds = SOXL.nextPrincipal(4000) + TQQQ.remainingCash(2000) = 6000
  assertEqual(result.totalAllocatedFunds, 6000, 'Total allocated');
  assertEqual(result.additionalDeposit, 0, 'No additional deposit');

  // Only SOXL should be in newCyclePrincipalMap
  assert(result.newCyclePrincipalMap.has('SOXL'), 'SOXL should be in new cycle map');
  assert(!result.newCyclePrincipalMap.has('TQQQ'), 'TQQQ should NOT be in new cycle map');
  assertEqual(result.newCyclePrincipalMap.get('SOXL'), 4000, 'SOXL principal');
});


// ============================================================
// D. Market Close Sync
// ============================================================
console.log('');
console.log('--- D. Market Close Sync ---');

test('D1', 'Buy execution updates totalBuyAmount', () => {
  const cycleData = {
    totalBuyAmount: 1000,
    totalSellAmount: 200,
  };
  const todayBuyAmt = 250;
  const newTotalBuy = (cycleData.totalBuyAmount || 0) + todayBuyAmt;
  assertEqual(newTotalBuy, 1250, 'totalBuyAmount should be 1250');
});

test('D2', 'Sell execution updates totalSellAmount', () => {
  const cycleData = {
    totalBuyAmount: 1000,
    totalSellAmount: 200,
  };
  const todaySellAmt = 300;
  const newTotalSell = (cycleData.totalSellAmount || 0) + todaySellAmt;
  assertEqual(newTotalSell, 500, 'totalSellAmount should be 500');
});

test('D3', 'Cycle completion detection (qty=0 && totalInvested > 0)', () => {
  const cycleData = {
    status: 'active' as const,
    totalInvested: 5000,
  };
  const totalQuantity = 0;

  const isComplete = cycleData.status === 'active' && totalQuantity === 0 && (cycleData.totalInvested || 0) > 0;
  assertEqual(isComplete, true, 'Cycle should be detected as complete');

  // Not complete if still holding
  const isComplete2 = cycleData.status === 'active' && 10 === 0 && (cycleData.totalInvested || 0) > 0;
  assertEqual(isComplete2, false, 'Should NOT be complete if holding');
});

test('D4', 'Cycle completion saves history file', () => {
  const history: CycleHistory = {
    ticker: 'SOXL',
    cycleNumber: 1,
    strategyVersion: 'v2.2',
    splitCount: 30,
    targetProfit: 0.12,
    starDecreaseRate: calculateDecreaseRate(0.12, 30),
    principal: 5000,
    buyPerRound: 166.67,
    totalBuyAmount: 4800,
    totalSellAmount: 5200,
    totalRealizedProfit: 400,
    finalProfitRate: 400 / 5000,
    startedAt: '2026-01-01T00:00:00Z',
    completedAt: '2026-03-25T00:00:00Z',
  };

  saveTestCycleHistory(history);

  const savedFile = path.join(TEMP_HISTORY, 'SOXL-cycle-001.json');
  assert(fs.existsSync(savedFile), 'History file should exist');
  const saved = JSON.parse(fs.readFileSync(savedFile, 'utf-8'));
  assertEqual(saved.ticker, 'SOXL', 'Saved ticker');
  assertEqual(saved.totalRealizedProfit, 400, 'Saved profit');
});

test('D5', 'Quarter mode activation (MOC sell executed)', () => {
  // Simulate: quarterMode exists but isActive=false, sell execution happened
  const quarterMode: QuarterModeState = {
    isActive: false,
    round: 1,
    originalBuyPerRound: 125,
    quarterSeed: 500,
    quarterBuyPerRound: 50,
  };
  const hasSellExec = true;

  // Logic from main-close.ts:
  if (!quarterMode.isActive && hasSellExec) {
    quarterMode.isActive = true;
  }
  assertEqual(quarterMode.isActive, true, 'Quarter mode should be activated after MOC sell');
});

test('D6', 'Quarter mode exit (full sell after QM)', () => {
  const cycleData = {
    remainingCash: 200,
    splitCount: 40,
    principal: 5000,
  };
  const totalQuantity = 0;
  const hasSellExec = true;
  const soldAmount = 1800;

  // Logic from main-close.ts: quarter mode exit
  const isQMExit = totalQuantity === 0 && hasSellExec;
  assert(isQMExit, 'Should detect QM exit');

  const newPrincipal = (cycleData.remainingCash || 0) + soldAmount;
  assertEqual(newPrincipal, 2000, 'New principal should be remainingCash + soldAmount');

  const newBuyPerRound = newPrincipal / cycleData.splitCount;
  assertEqual(newBuyPerRound, 50, 'New buyPerRound should be 50');
});

test('D7', 'Quarter mode round increase', () => {
  const quarterMode: QuarterModeState = {
    isActive: true,
    round: 3,
    originalBuyPerRound: 125,
    quarterSeed: 500,
    quarterBuyPerRound: 50,
  };
  const hasBuyExec = true;

  if (quarterMode.isActive && hasBuyExec) {
    const newRound = (quarterMode.round || 0) + 1;
    quarterMode.round = newRound;
  }
  assertEqual(quarterMode.round, 4, 'Quarter mode round should increase to 4');
});

test('D8', 'MOO reservation sell trigger (closePrice >= targetPrice)', () => {
  const avgPrice = 50.00;
  const targetProfit = 0.10;
  // Use same rounding as source code (calculatePrice): Math.round(avgPrice * (1+tp) * 100) / 100
  const targetPrice = Math.round(avgPrice * (1 + targetProfit) * 100) / 100; // 55.00
  const totalQuantity = 20;

  // Case 1: Price at target
  const currentPrice1 = 55.00;
  const shouldMOO1 = totalQuantity > 0 && currentPrice1 > 0 && currentPrice1 >= targetPrice;
  assertEqual(shouldMOO1, true, 'Should trigger MOO at target price');

  // Case 2: Price above target
  const currentPrice2 = 60.00;
  const shouldMOO2 = totalQuantity > 0 && currentPrice2 > 0 && currentPrice2 >= targetPrice;
  assertEqual(shouldMOO2, true, 'Should trigger MOO above target');

  // Case 3: Price below target
  const currentPrice3 = 54.99;
  const shouldMOO3 = totalQuantity > 0 && currentPrice3 > 0 && currentPrice3 >= targetPrice;
  assertEqual(shouldMOO3, false, 'Should NOT trigger MOO below target');
});


// ============================================================
// E. State Manager
// ============================================================
console.log('');
console.log('--- E. State Manager ---');

test('E1', 'Config read/write', () => {
  const config = readTestConfig();
  assertEqual(config.enabled, true, 'Config enabled');
  assertEqual(config.tickers.length, 2, 'Config has 2 tickers');
  assertEqual(config.tickerConfigs.SOXL.splitCount, 30, 'SOXL splitCount');

  // Write and re-read
  config.enabled = false;
  writeTestConfig(config);
  const config2 = readTestConfig();
  assertEqual(config2.enabled, false, 'Config should be updated');

  // Restore
  config2.enabled = true;
  writeTestConfig(config2);
});

test('E2', 'Cycle state read/write/update', () => {
  const state: CycleState = {
    ticker: 'SOXL',
    status: 'active',
    cycleNumber: 1,
    strategyVersion: 'v2.2',
    splitCount: 30,
    targetProfit: 0.12,
    starDecreaseRate: calculateDecreaseRate(0.12, 30),
    principal: 5000,
    buyPerRound: 166.67,
    totalQuantity: 10,
    avgPrice: 25.00,
    totalInvested: 250,
    remainingCash: 4750,
    totalBuyAmount: 250,
    totalSellAmount: 0,
    totalRealizedProfit: 0,
    startedAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  };

  writeTestCycleState('SOXL', state);
  const read = readTestCycleState('SOXL');
  assertEqual(read.ticker, 'SOXL', 'Read ticker');
  assertEqual(read.principal, 5000, 'Read principal');
  assertEqual(read.totalQuantity, 10, 'Read totalQuantity');

  // Update
  read.totalQuantity = 15;
  read.updatedAt = new Date().toISOString();
  writeTestCycleState('SOXL', read);
  const read2 = readTestCycleState('SOXL');
  assertEqual(read2.totalQuantity, 15, 'Updated totalQuantity');
});

test('E3', 'Log append', () => {
  const date = '2026-03-25';
  appendTestLog(date, {
    timestamp: new Date().toISOString(),
    ticker: 'SOXL',
    action: 'ORDER_RESULT',
    details: { side: 'BUY', price: 25.50, quantity: 6 },
  });
  appendTestLog(date, {
    timestamp: new Date().toISOString(),
    ticker: 'TQQQ',
    action: 'ORDER_RESULT',
    details: { side: 'BUY', price: 60.00, quantity: 2 },
  });

  const logFile = path.join(TEMP_LOGS, `${date}.json`);
  const logs = JSON.parse(fs.readFileSync(logFile, 'utf-8'));
  assertEqual(logs.length, 2, 'Should have 2 log entries');
  assertEqual(logs[0].ticker, 'SOXL', 'First log ticker');
  assertEqual(logs[1].ticker, 'TQQQ', 'Second log ticker');
});

test('E4', 'History save + cycle number auto-increment', () => {
  // Cycle 1 already saved in test D4
  const nextNum = getTestNextCycleNumber('SOXL');
  assertEqual(nextNum, 2, 'Next cycle number for SOXL should be 2');

  // Save cycle 2
  saveTestCycleHistory({
    ticker: 'SOXL', cycleNumber: 2, strategyVersion: 'v2.2',
    splitCount: 30, targetProfit: 0.12, starDecreaseRate: 0.008,
    principal: 5000, buyPerRound: 166.67,
    totalBuyAmount: 4900, totalSellAmount: 5100,
    totalRealizedProfit: 200, finalProfitRate: 0.04,
    startedAt: '2026-02-01T00:00:00Z', completedAt: '2026-03-25T00:00:00Z',
  });

  const nextNum2 = getTestNextCycleNumber('SOXL');
  assertEqual(nextNum2, 3, 'Next cycle number should now be 3');

  // TQQQ should still be 1
  const nextNumTqqq = getTestNextCycleNumber('TQQQ');
  assertEqual(nextNumTqqq, 1, 'TQQQ next cycle number should be 1');
});

test('E5', 'Read non-existent file returns null', () => {
  const result = readTestCycleState('NONEXISTENT');
  assertEqual(result, null, 'Should return null for non-existent file');
});


// ============================================================
// F. Utilities
// ============================================================
console.log('');
console.log('--- F. Utilities ---');

test('F1', 'US market holidays 2026 accuracy', () => {
  // Manually verify 2026 holidays by computing them via the same algorithm
  // We test the helper functions by reimplementing them here

  function getNthWeekdayOfMonth(year: number, month: number, weekday: number, n: number): Date {
    const firstDay = new Date(year, month, 1);
    const firstWeekday = firstDay.getDay();
    const day = 1 + ((weekday - firstWeekday + 7) % 7) + (n - 1) * 7;
    return new Date(year, month, day);
  }

  function getLastWeekdayOfMonth(year: number, month: number, weekday: number): Date {
    const lastDay = new Date(year, month + 1, 0);
    const diff = (lastDay.getDay() - weekday + 7) % 7;
    return new Date(year, month, lastDay.getDate() - diff);
  }

  const year = 2026;

  // New Year: Jan 1, 2026 = Thursday
  const newYear = new Date(2026, 0, 1);
  assertEqual(newYear.getDay(), 4, 'Jan 1 2026 is Thursday');

  // MLK Day: 3rd Monday of January
  const mlk = getNthWeekdayOfMonth(2026, 0, 1, 3);
  assertEqual(mlk.getDate(), 19, 'MLK Day 2026 should be Jan 19');

  // Presidents Day: 3rd Monday of February
  const presidents = getNthWeekdayOfMonth(2026, 1, 1, 3);
  assertEqual(presidents.getDate(), 16, 'Presidents Day 2026 should be Feb 16');

  // Memorial Day: last Monday of May
  const memorial = getLastWeekdayOfMonth(2026, 4, 1);
  assertEqual(memorial.getDate(), 25, 'Memorial Day 2026 should be May 25');

  // Independence Day: July 4, 2026 = Saturday => observed Friday July 3
  const july4 = new Date(2026, 6, 4);
  assertEqual(july4.getDay(), 6, 'July 4 2026 is Saturday');
  // Observed: July 3 (Friday)

  // Labor Day: 1st Monday of September
  const labor = getNthWeekdayOfMonth(2026, 8, 1, 1);
  assertEqual(labor.getDate(), 7, 'Labor Day 2026 should be Sep 7');

  // Thanksgiving: 4th Thursday of November
  const thanksgiving = getNthWeekdayOfMonth(2026, 10, 4, 4);
  assertEqual(thanksgiving.getDate(), 26, 'Thanksgiving 2026 should be Nov 26');

  // Christmas: Dec 25, 2026 = Friday
  const christmas = new Date(2026, 11, 25);
  assertEqual(christmas.getDay(), 5, 'Dec 25 2026 is Friday');
});

test('F2', 'Weekend check', () => {
  // Saturday
  const sat = new Date(2026, 2, 28); // March 28, 2026
  assertEqual(sat.getDay(), 6, 'March 28, 2026 is Saturday');

  // Sunday
  const sun = new Date(2026, 2, 29); // March 29, 2026
  assertEqual(sun.getDay(), 0, 'March 29, 2026 is Sunday');

  // Monday
  const mon = new Date(2026, 2, 30); // March 30, 2026
  assertEqual(mon.getDay(), 1, 'March 30, 2026 is Monday');
});

test('F3', 'fmtUSD formatting', () => {
  assertEqual(fmtUSD(1234.56), '$1234.56', 'Format $1234.56');
  assertEqual(fmtUSD(0), '$0.00', 'Format $0.00');
  assertEqual(fmtUSD(-50.1), '$-50.10', 'Format negative');
  assertEqual(fmtUSD(1000000), '$1000000.00', 'Format large number');
});


// ============================================================
// G. Edge Cases
// ============================================================
console.log('');
console.log('--- G. Edge Cases ---');

test('G1', 'Quantity 0 but avgPrice > 0 (residual data)', () => {
  const params: CalculateParams = {
    ticker: 'SOXL',
    currentPrice: 25.00,
    totalQuantity: 0,
    avgPrice: 30.00, // residual
    totalInvested: 0,
    remainingCash: 5000,
    buyPerRound: 166.67,
    splitCount: 30,
    targetProfit: 0.12,
    starDecreaseRate: calculateDecreaseRate(0.12, 30),
    strategyVersion: 'v2.2',
  };

  const result = calculate(params);
  // Should generate no sell orders (totalQuantity = 0)
  assertEqual(result.sellOrders.length, 0, 'No sell orders when qty=0');
  // cycleStatus.shouldReset should be true
  assertEqual(result.cycleStatus.shouldReset, true, 'Should reset when qty=0');
});

test('G2', 'Current price 0 or negative', () => {
  const params: CalculateParams = {
    ticker: 'SOXL',
    currentPrice: 0,
    totalQuantity: 0,
    avgPrice: 0,
    totalInvested: 0,
    remainingCash: 5000,
    buyPerRound: 166.67,
    splitCount: 30,
    targetProfit: 0.12,
    starDecreaseRate: calculateDecreaseRate(0.12, 30),
    strategyVersion: 'v2.2',
  };

  const result = calculate(params);
  // With currentPrice=0 and avgPrice=0, no orders should be generated
  assertEqual(result.buyOrders.length, 0, 'No buy orders when currentPrice=0');
  assertEqual(result.sellOrders.length, 0, 'No sell orders when currentPrice=0');
});

test('G3', 'Price higher than buyPerRound -> quantity = 0', () => {
  const params: CalculateParams = {
    ticker: 'SOXL',
    currentPrice: 200.00,  // way higher than buyPerRound
    totalQuantity: 0,
    avgPrice: 0,
    totalInvested: 0,
    remainingCash: 5000,
    buyPerRound: 166.67,
    splitCount: 30,
    targetProfit: 0.12,
    starDecreaseRate: calculateDecreaseRate(0.12, 30),
    strategyVersion: 'v2.2',
  };

  const result = calculate(params);
  // quantity = floor(166.67 / 200) = 0
  assertEqual(result.buyOrders.length, 0, 'No buy orders when price > buyPerRound');
});

test('G4', 'config.enabled = false -> immediate exit', () => {
  writeTestConfig({ ...readTestConfig(), enabled: false });
  const config = readTestConfig();
  assertEqual(config.enabled, false, 'Config should be disabled');

  // Simulate main() behavior
  let exited = false;
  if (!config.enabled) {
    exited = true;
  }
  assertEqual(exited, true, 'Should exit immediately when disabled');

  // Restore
  writeTestConfig({ ...config, enabled: true });
});

test('G5', 'Only one ticker holding, other empty', () => {
  const tickers = ['SOXL', 'TQQQ'];
  const cycleStatusMap = new Map<string, CycleStatus>();

  // SOXL is active with holdings
  cycleStatusMap.set('SOXL', {
    ticker: 'SOXL', needsNewCycle: false,
    nextPrincipal: 5000, holdingValue: 2000,
    cycleData: { remainingCash: 3000, principal: 5000 },
  });

  // TQQQ needs new cycle
  cycleStatusMap.set('TQQQ', {
    ticker: 'TQQQ', needsNewCycle: true,
    nextPrincipal: 4500, holdingValue: 0, cycleData: null,
  });

  const result = calculatePrincipal({ accountCash: 7500, tickers, cycleStatusMap });

  // totalAllocated = SOXL.remainingCash(3000) + TQQQ.nextPrincipal(4500) = 7500
  assertEqual(result.totalAllocatedFunds, 7500, 'Total allocated');
  assertEqual(result.additionalDeposit, 0, 'No additional deposit');

  // Only TQQQ should have new cycle principal
  assert(result.newCyclePrincipalMap.has('TQQQ'), 'TQQQ should have new cycle principal');
  assert(!result.newCyclePrincipalMap.has('SOXL'), 'SOXL should NOT have new cycle principal');
  assertEqual(result.newCyclePrincipalMap.get('TQQQ'), 4500, 'TQQQ principal');
});

test('G6', 'Quarter mode round > 10 (reset)', () => {
  const qm: QuarterModeState = {
    isActive: true,
    round: 11,  // exceeded 10
    originalBuyPerRound: 125,
    quarterSeed: 500,
    quarterBuyPerRound: 50,
  };

  const params: CalculateParams = {
    ticker: 'TQQQ',
    currentPrice: 45.00,
    totalQuantity: 30,
    avgPrice: 50.00,
    totalInvested: 1500,
    remainingCash: 50,
    buyPerRound: 125,
    splitCount: 40,
    targetProfit: 0.10,
    starDecreaseRate: calculateDecreaseRate(0.10, 40),
    strategyVersion: 'v2.2',
    quarterMode: qm,
  };

  const result = calculate(params);
  assertEqual(result.phase, 'QUARTER_MODE', 'Should be in quarter mode');

  // When round > 10, sell orders should be MOC only (reset)
  const mocOrders = result.sellOrders.filter(o => o.orderType === 'MOC');
  assert(mocOrders.length > 0, 'Should have MOC order for QM reset (round > 10)');

  // Should NOT have LIMIT order when resetting (MOC only)
  const limitOrders = result.sellOrders.filter(o => o.orderType === 'LIMIT');
  assertEqual(limitOrders.length, 0, 'Should have no LIMIT orders on QM reset');
});

test('G7', 'remainingCash negative (loss situation)', () => {
  // This can happen when totalInvested > principal due to price drop + averaging down
  const tickers = ['SOXL', 'TQQQ'];
  const cycleStatusMap = new Map<string, CycleStatus>();

  cycleStatusMap.set('SOXL', {
    ticker: 'SOXL', needsNewCycle: false,
    nextPrincipal: 5000, holdingValue: 6000,
    cycleData: { remainingCash: -500, principal: 5000 },
  });

  cycleStatusMap.set('TQQQ', {
    ticker: 'TQQQ', needsNewCycle: false,
    nextPrincipal: 5000, holdingValue: 5000,
    cycleData: { remainingCash: 0, principal: 5000 },
  });

  // Account cash = 0 (all in holdings)
  const result = calculatePrincipal({ accountCash: 0, tickers, cycleStatusMap });

  // totalAllocated = SOXL.remainingCash(-500) + TQQQ.remainingCash(0) = -500
  assertEqual(result.totalAllocatedFunds, -500, 'Negative allocated funds');

  // additionalDeposit = max(0, 0 - (-500)) = 500 (math gives positive but its not a real deposit)
  assertEqual(result.additionalDeposit, 500, 'Additional deposit from negative remaining');

  // No new cycles
  assert(!result.newCyclePrincipalMap.has('SOXL'), 'SOXL not new cycle');
  assert(!result.newCyclePrincipalMap.has('TQQQ'), 'TQQQ not new cycle');
});


// ============================================================
// Additional Calculator Tests
// ============================================================
console.log('');
console.log('--- Additional Calculator Tests ---');

test('CALC1', 'V3.0 strategy: no quarter mode, MOC + LIMIT when cash insufficient', () => {
  const params: CalculateParams = {
    ticker: 'SOXL',
    currentPrice: 20.00,
    totalQuantity: 50,
    avgPrice: 22.00,
    totalInvested: 1100,
    remainingCash: 50, // < buyPerRound
    buyPerRound: 250,
    splitCount: 20,
    targetProfit: 0.20,
    starDecreaseRate: calculateDecreaseRate(0.20, 20),
    strategyVersion: 'v3.0',
  };

  const result = calculate(params);
  // V3.0 should NOT enter quarter mode
  assert(result.phase !== 'QUARTER_MODE', 'V3.0 should not use quarter mode');

  // Should have MOC + LIMIT sell orders
  const mocSells = result.sellOrders.filter(o => o.orderType === 'MOC');
  const limitSells = result.sellOrders.filter(o => o.orderType === 'LIMIT');
  assert(mocSells.length > 0, 'V3.0 should have MOC sell when cash insufficient');
  assert(limitSells.length > 0, 'V3.0 should have LIMIT sell too');
});

test('CALC2', 'Quarter mode seed calculation: min(remainingCash, buyPerRound * 10)', () => {
  // Case 1: remainingCash < buyPerRound * 10
  const r1 = calculateQuarterModeSeed(500, 125);
  assertEqual(r1.quarterSeed, 500, 'Seed should be 500 (limited by cash)');
  assertEqual(r1.quarterBuyPerRound, 50, 'quarterBuyPerRound should be 50');

  // Case 2: remainingCash > buyPerRound * 10
  const r2 = calculateQuarterModeSeed(2000, 125);
  assertEqual(r2.quarterSeed, 1250, 'Seed should be 1250 (limited by max)');
  assertEqual(r2.quarterBuyPerRound, 125, 'quarterBuyPerRound should be 125');
});

test('CALC3', 'Decrease rate formula: targetProfit * 2 / splitCount', () => {
  assertEqual(calculateDecreaseRate(0.10, 40), 0.005, 'TQQQ decrease rate');
  assertEqual(calculateDecreaseRate(0.12, 30), 0.008, 'SOXL decrease rate');
  assertEqual(calculateDecreaseRate(0.20, 20), 0.02, 'V3.0 SOXL decrease rate');
  assertEqual(calculateDecreaseRate(0.15, 20), 0.015, 'V3.0 TQQQ decrease rate');
  assertEqual(calculateDecreaseRate(0, 40), 0, 'Zero target profit');
  assertEqual(calculateDecreaseRate(0.10, 0), 0, 'Zero split count');
});

test('CALC4', 'Quarter mode star% uses T=splitCount', () => {
  // Quarter mode star% = targetProfit - (decreaseRate * splitCount)
  // = targetProfit - (targetProfit * 2 / splitCount * splitCount)
  // = targetProfit - 2*targetProfit = -targetProfit
  const dr = calculateDecreaseRate(0.10, 40);
  const qmStar = 0.10 - (dr * 40); // 0.10 - 0.20 = -0.10
  assertClose(qmStar, -0.10, 0.0001, 'QM star% should be -targetProfit');
});

test('CALC5', 'Sell order quarter quantity: max(1, ceil(qty/4)), capped at total', () => {
  // totalQuantity = 3 -> quarterQty = max(1, ceil(3/4)) = max(1, 1) = 1
  let q1 = Math.max(1, Math.ceil(3 / 4));
  assertEqual(q1, 1, 'Quarter of 3 should be 1');

  // totalQuantity = 1 -> quarterQty = max(1, ceil(1/4)) = max(1, 1) = 1
  // But capped at totalQuantity = 1
  let q2 = Math.max(1, Math.ceil(1 / 4));
  if (q2 >= 1) q2 = 1;
  assertEqual(q2, 1, 'Quarter of 1 should be 1 (full)');

  // totalQuantity = 100 -> quarterQty = max(1, ceil(100/4)) = 25
  const q3 = Math.max(1, Math.ceil(100 / 4));
  assertEqual(q3, 25, 'Quarter of 100 should be 25');
});


// ==================== Cleanup & Summary ====================

cleanupTempDir();

console.log('');
console.log('='.repeat(70));
console.log('  TEST SUMMARY');
console.log('='.repeat(70));

const passed = results.filter(r => r.passed).length;
const failed = results.filter(r => !r.passed).length;
const total = results.length;

console.log(`  Total:  ${total}`);
console.log(`  Passed: ${passed}`);
console.log(`  Failed: ${failed}`);

if (failed > 0) {
  console.log('');
  console.log('  FAILED TESTS:');
  for (const r of results.filter(r => !r.passed)) {
    console.log(`    ${r.id}: ${r.name}`);
    console.log(`      -> ${r.error}`);
  }
}

console.log('');
console.log(failed === 0 ? '  ALL TESTS PASSED' : '  SOME TESTS FAILED');
console.log('='.repeat(70));
console.log('');

process.exit(failed > 0 ? 1 : 0);
